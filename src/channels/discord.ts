import { withRetry } from "../utils/retry";
import { Logger } from "../utils/logger";
import type { ChannelAdapter, SenderOptions, SendAudioOptions, MediaItem, BotIdentity } from "./registry";
import { base64ToBlob } from "./registry";
import { chunkText, parseRetryAfterMs } from "./utils";

const log = new Logger({ channel: "discord" });

const DISCORD_API = "https://discord.com/api/v10";

export class DiscordAdapter implements ChannelAdapter {
  readonly name = "discord";
  readonly maxMessageLength = 2000;

  async getBotIdentity(token: string, signal?: AbortSignal): Promise<BotIdentity | null> {
    const resp = await fetch(`${DISCORD_API}/users/@me`, {
      headers: { Authorization: `Bot ${token}` },
      signal,
    });
    const data = await resp.json() as { id?: string };
    if (data.id) return { channelUserId: data.id };
    return null;
  }

  formatMessage(markdown: string): string {
    return markdown;
  }

  async sendTyping(token: string, channelId: string): Promise<void> {
    const res = await fetch(`${DISCORD_API}/channels/${channelId}/typing`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}` },
    });
    await res.text();
  }

  async sendMessage(
    token: string,
    channelId: string,
    text: string,
    options?: SenderOptions,
  ): Promise<void> {
    const formatted = this.formatMessage(text);
    if (token.startsWith("https://")) {
      await this._sendViaWebhook(token, formatted, options);
    } else {
      const finalText = options?.meta?.username ? `[${options.meta.username}]\n${formatted}` : formatted;
      await this._sendViaBotApi(token, channelId, finalText, options?.media);
    }
  }

  async sendAudio(
    token: string,
    channelId: string,
    audio: ArrayBuffer,
    options?: SendAudioOptions,
  ): Promise<{ captionSent: boolean }> {
    const caption = options?.caption;
    const meta = options?.meta;
    const isWebhook = token.startsWith("https://");

    // Discord content limit is 2000 chars
    // Bot API mode: prefix with [username] like sendMessage does
    let content: string | undefined;
    if (caption != null && caption.length > 0) {
      const prefixed = !isWebhook && meta?.username ? `[${meta.username}]\n${caption}` : caption;
      if (prefixed.length <= this.maxMessageLength) {
        content = prefixed;
      }
    }
    const captionSent = content != null;

    const form = new FormData();
    const payload: Record<string, unknown> = {};

    form.append("files[0]", new Blob([audio], { type: "audio/mpeg" }), "voice.mp3");
    payload.attachments = [{ id: 0, filename: "voice.mp3" }];
    if (content) payload.content = content;

    if (isWebhook) {
      if (meta?.username) payload.username = meta.username;
      if (meta?.avatarUrl) payload.avatar_url = meta.avatarUrl;
      form.append("payload_json", JSON.stringify(payload));

      await withRetry(async () => {
        const res = await fetch(`${token}?wait=true`, { method: "POST", body: form });
        if (!res.ok) {
          const body = await res.text();
          const retryAfterMs = parseRetryAfterMs(res.headers?.get("Retry-After"));
          throw Object.assign(new Error(`Discord webhook audio failed: ${res.status} ${body}`), {
            status: res.status, ...(retryAfterMs !== undefined && { retryAfterMs }),
          });
        }
      });
    } else {
      form.append("payload_json", JSON.stringify(payload));
      await withRetry(async () => {
        const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
          method: "POST",
          headers: { Authorization: `Bot ${token}` },
          body: form,
        });
        if (!res.ok) {
          const body = await res.text();
          const retryAfterMs = parseRetryAfterMs(res.headers?.get("Retry-After"));
          throw Object.assign(new Error(`Discord sendAudio failed: ${res.status} ${body}`), {
            status: res.status, ...(retryAfterMs !== undefined && { retryAfterMs }),
          });
        }
      });
    }

    return { captionSent };
  }

  // ---- Private helpers ----

  private async _sendViaWebhook(
    webhookUrl: string,
    text: string,
    options?: SenderOptions,
  ): Promise<void> {
    const meta = options?.meta;
    const media = options?.media;

    // Try sending with media first; on failure, fallback to text-only + hint
    if (media && media.length > 0) {
      try {
        await this._sendWebhookWithMedia(webhookUrl, text, media, meta);
        return;
      } catch (e) {
        log.warn("Discord webhook media failed, falling back to text", { error: String(e) });
      }
    }

    await this._sendWebhookTextOnly(webhookUrl, text + (media && media.length > 0 ? "\n\n[image unavailable]" : ""), meta);
  }

  private async _sendWebhookTextOnly(
    webhookUrl: string,
    text: string,
    meta?: SenderOptions["meta"],
  ): Promise<void> {
    const chunks = chunkText(text, this.maxMessageLength);

    for (const chunk of chunks) {
      const body: Record<string, unknown> = { content: chunk };
      if (meta?.username) body.username = meta.username;
      if (meta?.avatarUrl) body.avatar_url = meta.avatarUrl;

      await withRetry(async () => {
        const res = await fetch(`${webhookUrl}?wait=true`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const respBody = await res.text();
          if (res.status === 429 || res.status >= 500) {
            const retryAfterMs = parseRetryAfterMs(res.headers?.get("Retry-After"));
            throw Object.assign(new Error(`Discord webhook failed: ${res.status} ${respBody}`), {
              status: res.status,
              ...(retryAfterMs !== undefined && { retryAfterMs }),
            });
          }
          log.error("Discord webhook failed", { status: res.status, body: respBody });
        }
      });
    }
  }

  private async _sendWebhookWithMedia(
    webhookUrl: string,
    text: string,
    media: MediaItem[],
    meta?: SenderOptions["meta"],
  ): Promise<void> {
    const chunks = chunkText(text, this.maxMessageLength);

    for (let ci = 0; ci < chunks.length; ci++) {
      const isLastChunk = ci === chunks.length - 1;
      const chunkMedia = isLastChunk ? media : undefined;

      // Use FormData if we have base64 media on the last chunk
      if (chunkMedia && chunkMedia.length > 0 && DiscordAdapter._hasBase64Media(chunkMedia)) {
        const form = new FormData();
        const payload: Record<string, unknown> = { content: chunks[ci] };
        if (meta?.username) payload.username = meta.username;
        if (meta?.avatarUrl) payload.avatar_url = meta.avatarUrl;

        // URL media -> embeds, base64 media -> file attachments
        const urlMedia = chunkMedia.filter(m => m.source.type === "url");
        const b64Media = chunkMedia.filter(m => m.source.type === "base64");

        if (urlMedia.length > 0) {
          payload.embeds = urlMedia.map(m => ({ image: { url: (m.source as { type: "url"; url: string }).url } }));
        }

        const attachments: { id: number; filename: string }[] = [];
        b64Media.forEach((m, idx) => {
          const src = m.source as { type: "base64"; data: string; mimeType: string };
          const ext = src.mimeType.split("/")[1] || "png";
          const filename = `image_${idx}.${ext}`;
          const blob = base64ToBlob(src.data, src.mimeType);
          form.append(`files[${idx}]`, blob, filename);
          attachments.push({ id: idx, filename });
        });
        payload.attachments = attachments;

        form.append("payload_json", JSON.stringify(payload));

        await withRetry(async () => {
          const res = await fetch(`${webhookUrl}?wait=true`, {
            method: "POST",
            body: form,
          });
          if (!res.ok) {
            const respBody = await res.text();
            if (res.status === 429 || res.status >= 500) {
              const retryAfterMs = parseRetryAfterMs(res.headers?.get("Retry-After"));
              throw Object.assign(new Error(`Discord webhook failed: ${res.status} ${respBody}`), {
                status: res.status,
                ...(retryAfterMs !== undefined && { retryAfterMs }),
              });
            }
            throw new Error(`Discord webhook media failed: ${res.status} ${respBody}`);
          }
        });
      } else {
        // JSON body (URL-only media or no media)
        const body: Record<string, unknown> = { content: chunks[ci] };
        if (meta?.username) body.username = meta.username;
        if (meta?.avatarUrl) body.avatar_url = meta.avatarUrl;
        if (chunkMedia && chunkMedia.length > 0) {
          body.embeds = chunkMedia.map(m => ({ image: { url: (m.source as { type: "url"; url: string }).url } }));
        }

        await withRetry(async () => {
          const res = await fetch(`${webhookUrl}?wait=true`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
          if (!res.ok) {
            const respBody = await res.text();
            if (res.status === 429 || res.status >= 500) {
              const retryAfterMs = parseRetryAfterMs(res.headers?.get("Retry-After"));
              throw Object.assign(new Error(`Discord webhook failed: ${res.status} ${respBody}`), {
                status: res.status,
                ...(retryAfterMs !== undefined && { retryAfterMs }),
              });
            }
            throw new Error(`Discord webhook media failed: ${res.status} ${respBody}`);
          }
        });
      }
    }
  }

  private async _sendViaBotApi(
    token: string,
    channelId: string,
    text: string,
    media?: MediaItem[],
  ): Promise<void> {
    // Try sending with media first; on failure, fallback to text-only + hint
    if (media && media.length > 0) {
      try {
        await this._sendBotApiWithMedia(token, channelId, text, media);
        return;
      } catch (e) {
        log.warn("Discord bot API media failed, falling back to text", { error: String(e) });
      }
    }

    await this._sendBotApiTextOnly(token, channelId, text + (media && media.length > 0 ? "\n\n[image unavailable]" : ""));
  }

  private async _sendBotApiTextOnly(
    token: string,
    channelId: string,
    text: string,
  ): Promise<void> {
    const chunks = chunkText(text, this.maxMessageLength);

    for (const chunk of chunks) {
      await withRetry(async () => {
        const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
          method: "POST",
          headers: {
            Authorization: `Bot ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ content: chunk }),
        });
        if (!res.ok) {
          const body = await res.text();
          if (res.status === 429 || res.status >= 500) {
            const retryAfterMs = parseRetryAfterMs(res.headers?.get("Retry-After"));
            throw Object.assign(new Error(`Discord sendMessage failed: ${res.status} ${body}`), {
              status: res.status,
              ...(retryAfterMs !== undefined && { retryAfterMs }),
            });
          }
          log.error("Discord sendMessage failed", { status: res.status, body });
        }
      });
    }
  }

  private async _sendBotApiWithMedia(
    token: string,
    channelId: string,
    text: string,
    media: MediaItem[],
  ): Promise<void> {
    const chunks = chunkText(text, this.maxMessageLength);

    for (let ci = 0; ci < chunks.length; ci++) {
      const isLastChunk = ci === chunks.length - 1;
      const chunkMedia = isLastChunk ? media : undefined;

      // Use FormData if we have base64 media on the last chunk
      if (chunkMedia && chunkMedia.length > 0 && DiscordAdapter._hasBase64Media(chunkMedia)) {
        const form = new FormData();
        const payload: Record<string, unknown> = { content: chunks[ci] };

        const urlMedia = chunkMedia.filter(m => m.source.type === "url");
        const b64Media = chunkMedia.filter(m => m.source.type === "base64");

        if (urlMedia.length > 0) {
          payload.embeds = urlMedia.map(m => ({ image: { url: (m.source as { type: "url"; url: string }).url } }));
        }

        const attachments: { id: number; filename: string }[] = [];
        b64Media.forEach((m, idx) => {
          const src = m.source as { type: "base64"; data: string; mimeType: string };
          const ext = src.mimeType.split("/")[1] || "png";
          const filename = `image_${idx}.${ext}`;
          const blob = base64ToBlob(src.data, src.mimeType);
          form.append(`files[${idx}]`, blob, filename);
          attachments.push({ id: idx, filename });
        });
        payload.attachments = attachments;

        form.append("payload_json", JSON.stringify(payload));

        await withRetry(async () => {
          const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
            method: "POST",
            headers: { Authorization: `Bot ${token}` },
            body: form,
          });
          if (!res.ok) {
            const body = await res.text();
            if (res.status === 429 || res.status >= 500) {
              const retryAfterMs = parseRetryAfterMs(res.headers?.get("Retry-After"));
              throw Object.assign(new Error(`Discord sendMessage failed: ${res.status} ${body}`), {
                status: res.status,
                ...(retryAfterMs !== undefined && { retryAfterMs }),
              });
            }
            throw new Error(`Discord sendMessage media failed: ${res.status} ${body}`);
          }
        });
      } else {
        // JSON body (URL-only media or no media)
        const payload: Record<string, unknown> = { content: chunks[ci] };
        if (chunkMedia && chunkMedia.length > 0) {
          payload.embeds = chunkMedia.map(m => ({ image: { url: (m.source as { type: "url"; url: string }).url } }));
        }

        await withRetry(async () => {
          const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
            method: "POST",
            headers: {
              Authorization: `Bot ${token}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(payload),
          });
          if (!res.ok) {
            const body = await res.text();
            if (res.status === 429 || res.status >= 500) {
              const retryAfterMs = parseRetryAfterMs(res.headers?.get("Retry-After"));
              throw Object.assign(new Error(`Discord sendMessage failed: ${res.status} ${body}`), {
                status: res.status,
                ...(retryAfterMs !== undefined && { retryAfterMs }),
              });
            }
            throw new Error(`Discord sendMessage media failed: ${res.status} ${body}`);
          }
        });
      }
    }
  }

  private static _hasBase64Media(media: MediaItem[]): boolean {
    return media.some(m => m.source.type === "base64");
  }
}


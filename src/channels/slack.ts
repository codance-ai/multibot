import { withRetry } from "../utils/retry";
import { Logger } from "../utils/logger";
import type { ChannelAdapter, ChannelPayload, SenderOptions, SendAudioOptions, MediaItem, BotIdentity } from "./registry";
import { chunkText, formatSlackMarkdown, parseRetryAfterMs } from "./utils";
import type { Env } from "../config/schema";
import type { ChannelFileRef } from "../utils/file-download";

const log = new Logger({ channel: "slack" });

const SLACK_API = "https://slack.com/api";

export class SlackAdapter implements ChannelAdapter {
  readonly name = "slack";
  readonly maxMessageLength = 4000;

  preProcessWebhook(_request: Request, body: unknown, _env: Env): Response | null {
    if ((body as any).type === "url_verification") {
      return Response.json({ challenge: (body as any).challenge });
    }
    return null;
  }

  async getBotIdentity(token: string, signal?: AbortSignal): Promise<BotIdentity | null> {
    const resp = await fetch(`${SLACK_API}/auth.test`, {
      headers: { Authorization: `Bearer ${token}` },
      signal,
    });
    const data = await resp.json() as { ok?: boolean; user_id?: string };
    if (data.ok && data.user_id) return { channelUserId: data.user_id };
    return null;
  }

  parseWebhook(body: unknown): ChannelPayload | null {
    const event = (body as any)?.event;
    if (!event || event.subtype) return null;

    const hasText = !!event.text;
    const hasFiles = event.files?.some((f: any) => f.mimetype && f.url_private_download) ?? false;
    if (!hasText && !hasFiles) return null;

    const userMessage = event.text ?? "";

    // Slack ts format: "1700000000.123456" — extract integer seconds
    const ts = event.ts ?? "";
    const messageDate = ts ? Math.floor(Number(ts)) : undefined;

    // Extract Slack user mentions: <@U12345> or <@U12345|name> (W-prefix for enterprise grid)
    const slackMentions = new Set<string>();
    const mentionRegex = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g;
    let slackMatch;
    while ((slackMatch = mentionRegex.exec(userMessage)) !== null) {
      slackMentions.add(slackMatch[1]);
    }

    const hasAudioFile = event.files?.some((f: any) =>
      f.mimetype?.startsWith("audio/") && f.url_private_download
    ) ?? false;

    return {
      chatId: event.channel,
      userId: event.user ?? "",
      userName: event.user ?? "",
      userMessage,
      chatType: event.channel_type === "im" ? "private" : "group",
      messageId: ts,
      messageDate,
      mentions: [...slackMentions],
      ...(hasAudioFile && { isVoiceMessage: true }),
    };
  }

  formatMessage(markdown: string): string {
    return formatSlackMarkdown(markdown);
  }

  async sendTyping(token: string, channelId: string): Promise<void> {
    const res = await fetch(`${SLACK_API}/users.typing`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel: channelId }),
    });
    await res.text();
  }

  async sendAudio(
    token: string,
    channelId: string,
    audio: ArrayBuffer,
    options?: SendAudioOptions,
  ): Promise<{ captionSent: boolean }> {
    const caption = options?.caption;

    // Step 1: Get upload URL
    const getUrlRes = await fetch(`${SLACK_API}/files.getUploadURLExternal`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        filename: "voice.mp3",
        length: String(audio.byteLength),
      }),
    });
    const getUrlData = await getUrlRes.json() as { ok: boolean; upload_url?: string; file_id?: string; error?: string };
    if (!getUrlData.ok || !getUrlData.upload_url || !getUrlData.file_id) {
      throw new Error(`Slack getUploadURLExternal failed: ${getUrlData.error ?? "unknown"}`);
    }

    // Step 2: Upload file bytes
    const uploadRes = await fetch(getUrlData.upload_url, {
      method: "PUT",
      headers: { "Content-Type": "audio/mpeg" },
      body: audio,
    });
    if (!uploadRes.ok) {
      const body = await uploadRes.text();
      throw new Error(`Slack file upload failed: ${uploadRes.status} ${body}`);
    }

    // Step 3: Complete upload, share to channel with optional caption
    const completeBody: Record<string, unknown> = {
      files: [{ id: getUrlData.file_id, title: "Voice message" }],
      channel_id: channelId,
    };
    const useCaption = caption != null && caption.length > 0;
    if (useCaption) {
      completeBody.initial_comment = formatSlackMarkdown(caption);
    }

    const completeRes = await fetch(`${SLACK_API}/files.completeUploadExternal`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(completeBody),
    });
    const completeData = await completeRes.json() as { ok: boolean; error?: string };
    if (!completeData.ok) {
      throw new Error(`Slack completeUploadExternal failed: ${completeData.error ?? "unknown"}`);
    }

    return { captionSent: useCaption };
  }

  async sendMessage(
    token: string,
    channelId: string,
    text: string,
    options?: SenderOptions,
  ): Promise<void> {
    const formatted = this.formatMessage(text);
    const meta = options?.meta;
    const media = options?.media;

    // Filter to URL-only images (Slack base64 upload requires files.uploadV2 — not yet supported)
    const urlImages: MediaItem[] = media
      ? media.filter(m => m.kind === "image" && m.source.type === "url")
      : [];

    // Try sending with image blocks; on failure, fallback to text-only + hint
    if (urlImages.length > 0) {
      try {
        await this._sendChunks(token, channelId, formatted, meta, urlImages);
        return;
      } catch (e) {
        log.warn("Slack media blocks failed, falling back to text", { error: String(e) });
      }
      // Fallback: text-only with hint
      await this._sendChunks(token, channelId, formatted + "\n\n[image unavailable]", meta);
      return;
    }

    await this._sendChunks(token, channelId, formatted, meta);
  }

  private async _sendChunks(
    token: string,
    channelId: string,
    text: string,
    meta?: SenderOptions["meta"],
    urlImages?: MediaItem[],
  ): Promise<void> {
    const chunks = chunkText(text, this.maxMessageLength);

    for (let ci = 0; ci < chunks.length; ci++) {
      const isLastChunk = ci === chunks.length - 1;

      await withRetry(async () => {
        const body: Record<string, unknown> = { channel: channelId, text: chunks[ci] };
        if (meta?.username) body.username = meta.username;
        if (meta?.avatarUrl) body.icon_url = meta.avatarUrl;

        // Attach image blocks to the last chunk
        if (isLastChunk && urlImages && urlImages.length > 0) {
          body.blocks = [
            { type: "section", text: { type: "mrkdwn", text: chunks[ci] } },
            ...urlImages.map((m) => ({
              type: "image",
              image_url: (m.source as { type: "url"; url: string }).url,
              alt_text: "image",
            })),
          ];
        }

        const res = await fetch(`${SLACK_API}/chat.postMessage`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });

        // Slack returns HTTP 200 for most errors — must check response body
        const respBody = await res.text();
        if (!res.ok) {
          const retryAfterMs = parseRetryAfterMs(res.headers?.get("Retry-After"));
          if (res.status === 429 || res.status >= 500) {
            throw Object.assign(new Error(`Slack sendMessage failed: ${res.status} ${respBody}`), {
              status: res.status,
              ...(retryAfterMs !== undefined && { retryAfterMs }),
            });
          }
          log.error("Slack sendMessage failed", { status: res.status, body: respBody });
          return;
        }

        let parsed: { ok?: boolean; error?: string } | undefined;
        try { parsed = JSON.parse(respBody); } catch { /* non-JSON response */ }
        if (parsed && parsed.ok === false) {
          const errCode = parsed.error ?? "unknown";
          // rate_limited is retryable
          if (errCode === "ratelimited") {
            const retryAfterMs = parseRetryAfterMs(res.headers?.get("Retry-After"));
            throw Object.assign(new Error(`Slack API error: ${errCode}`), {
              status: 429,
              ...(retryAfterMs !== undefined && { retryAfterMs }),
            });
          }
          log.error("Slack API error", { error: errCode, body: respBody });
        }
      });
    }
  }
}

export function extractSlackFileRefs(body: unknown, token: string): ChannelFileRef[] {
  const event = (body as any)?.event;
  if (!event?.files || !Array.isArray(event.files)) return [];

  return event.files
    .filter((f: any) => f.mimetype && f.url_private_download && f.mode !== "external")
    .map((f: any) => ({
      downloadUrl: f.url_private_download,
      mediaType: f.mimetype,
      authHeader: `Bearer ${token}`,
      fileName: f.name,
    }));
}


import { withRetry } from "../utils/retry";
import { Logger } from "../utils/logger";
import type { ChannelAdapter, ChannelPayload, SenderOptions, SendAudioOptions, MediaItem, BotIdentity } from "./registry";
import { base64ToBlob } from "./registry";
import { chunkText, formatTelegramMarkdown } from "./utils";
import { TelegramUpdateSchema } from "../config/schema";
import type { Env } from "../config/schema";
import type { ChannelFileRef } from "../utils/file-download";

const log = new Logger({ channel: "telegram" });

const MAX_CAPTION_LENGTH = 1024;

export class TelegramAdapter implements ChannelAdapter {
  readonly name = "telegram";
  readonly maxMessageLength = 4096;

  preProcessWebhook(request: Request, _body: unknown, env: Env): Response | null {
    const secret = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
    if (secret !== env.WEBHOOK_SECRET) {
      return new Response("Unauthorized", { status: 401 });
    }
    return null;
  }

  async getBotIdentity(token: string, signal?: AbortSignal): Promise<BotIdentity | null> {
    const resp = await fetch(`https://api.telegram.org/bot${token}/getMe`, { signal });
    const data = await resp.json() as { ok: boolean; result?: { username?: string } };
    if (data.ok && data.result?.username) {
      return { channelUsername: `@${data.result.username}` };
    }
    return null;
  }

  parseWebhook(body: unknown): ChannelPayload | null {
    // Capture raw reply_to_message before Zod strips/transforms it
    const rawReply = (body as Record<string, any>)?.message?.reply_to_message;

    const result = TelegramUpdateSchema.safeParse(body);
    if (!result.success) return null;
    const update = result.data;

    const msg = update.message;
    if (!msg) return null;

    // Accept if message has text, caption (photo), or photo/document/voice/audio
    const hasContent = msg.text || msg.caption || msg.photo || msg.document || msg.voice || msg.audio;
    if (!hasContent) return null;

    // Use text if present, otherwise caption (photo messages)
    const userMessage = msg.text ?? msg.caption ?? "";

    // Extract structured mentions from entities + caption_entities
    const rawMsg = body as Record<string, any>;
    const textEntities: any[] = rawMsg?.message?.entities ?? [];
    const captionEntities: any[] = rawMsg?.message?.caption_entities ?? [];
    const allEntities = [...textEntities, ...captionEntities];
    const mentionSet = new Set<string>();
    const sourceText = msg.text ?? msg.caption ?? "";
    for (const entity of allEntities) {
      if (entity.type === "mention") {
        const mention = sourceText.slice(entity.offset, entity.offset + entity.length);
        if (mention.startsWith("@")) mentionSet.add(mention.toLowerCase());
      } else if (entity.type === "text_mention" && entity.user?.username) {
        mentionSet.add(`@${entity.user.username.toLowerCase()}`);
      }
    }

    // Extract reply-to name (from parsed or raw payload)
    const reply = msg.reply_to_message;
    const replyToName = reply?.from?.first_name
      ?? rawReply?.from?.first_name
      ?? rawReply?.from?.username;

    // Extract reply-to text content (text > caption > raw fallbacks)
    const replyToText = reply?.text
      ?? reply?.caption
      ?? rawReply?.text
      ?? rawReply?.caption
      ?? undefined;

    const isVoiceMessage = !!(msg.voice || msg.audio);

    return {
      chatId: String(msg.chat.id),
      userId: String(msg.from?.id ?? 0),
      userName: msg.from?.first_name ?? "User",
      userMessage,
      chatType: msg.chat.type,
      messageId: String(msg.message_id),
      replyToName,
      messageDate: msg.date,
      replyToText,
      mentions: [...mentionSet],
      ...(isVoiceMessage && { isVoiceMessage: true }),
    };
  }

  formatMessage(markdown: string): string {
    return formatTelegramMarkdown(markdown);
  }

  async sendMessage(
    token: string,
    chatId: string,
    text: string,
    options?: SenderOptions,
  ): Promise<void> {
    const formatted = this.formatMessage(text);
    const media = options?.media;

    // Send photos if media items are provided
    if (media && media.length > 0) {
      // First photo: attach text as caption if it fits (Telegram caption limit is 1024 chars)
      const useCaption = formatted.length <= MAX_CAPTION_LENGTH;

      // Multiple images → use sendMediaGroup to merge into one message group
      if (media.length >= 2 && media.every(m => m.kind === "image")) {
        const caption = useCaption ? formatted : undefined;
        let mediaFailed = false;
        try {
          const res = await withRetry(async () => {
            return this._sendMediaGroup(token, chatId, media, caption, "Markdown");
          });
          if (!res.ok && caption) {
            // Fallback: retry without Markdown parse_mode
            const res2 = await withRetry(async () => {
              return this._sendMediaGroup(token, chatId, media, caption, undefined);
            });
            if (!res2.ok) mediaFailed = true;
          } else if (!res.ok) {
            mediaFailed = true;
          }
        } catch (e) {
          console.warn("[telegram] Media group send failed:", e);
          mediaFailed = true;
        }

        if (mediaFailed) {
          await this._sendTextMessage(token, chatId, formatted + "\n\n[image unavailable]");
          return;
        }
        if (!useCaption) {
          await this._sendTextMessage(token, chatId, formatted);
        }
        return;
      }

      // Single media item → use sendPhoto/sendDocument
      let mediaFailed = false;
      let textDelivered = false;

      for (let i = 0; i < media.length; i++) {
        const caption = (i === 0 && useCaption) ? formatted : undefined;
        const parseMode = caption ? "Markdown" : undefined;

        try {
          const res = await withRetry(async () => {
            return this._sendMediaItem(token, chatId, media[i], caption, parseMode);
          });
          // Fallback: if Markdown parsing fails in caption, retry without parse_mode
          if (!res.ok && i === 0 && useCaption) {
            const res2 = await withRetry(async () => {
              return this._sendMediaItem(token, chatId, media[i], caption, undefined);
            });
            if (!res2.ok) {
              mediaFailed = true;
              break;
            } else {
              textDelivered = true;
            }
          } else if (!res.ok) {
            mediaFailed = true;
            break;
          } else if (caption) {
            textDelivered = true;
          }
        } catch (e) {
          console.warn("[telegram] Media item send failed:", e);
          mediaFailed = true;
          break;
        }
      }

      // If media failed, fallback to text with failure hint
      if (mediaFailed) {
        const hint = "\n\n[image unavailable]";
        if (textDelivered) {
          // Text already sent as caption on a successful image, only send hint
          await this._sendTextMessage(token, chatId, hint.trimStart());
        } else {
          await this._sendTextMessage(token, chatId, formatted + hint);
        }
        return;
      }

      // If caption didn't fit, send text separately
      if (!useCaption) {
        await this._sendTextMessage(token, chatId, formatted);
      }
      return;
    }

    // No media — send text as usual
    await this._sendTextMessage(token, chatId, formatted);
  }

  async sendAudio(
    token: string,
    chatId: string,
    audio: ArrayBuffer,
    options?: SendAudioOptions,
  ): Promise<{ captionSent: boolean }> {
    const caption = options?.caption;
    const useCaption = caption != null && caption.length > 0 && caption.length <= MAX_CAPTION_LENGTH;

    const buildForm = (withMarkdown: boolean): FormData => {
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append("voice", new Blob([audio], { type: "audio/mpeg" }), "voice.mp3");
      if (useCaption) {
        form.append("caption", withMarkdown ? formatTelegramMarkdown(caption) : caption);
        if (withMarkdown) form.append("parse_mode", "Markdown");
      }
      return form;
    };

    // First attempt: with Markdown parse_mode
    const res = await withRetry(async () => {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
        method: "POST",
        body: buildForm(true),
      });
      if (!r.ok) {
        const body = await r.text();
        if (r.status === 429 || r.status >= 500) {
          throw new Error(`Telegram sendVoice failed: ${r.status} ${body}`);
        }
        return r; // 4xx — don't retry, return for markdown fallback check
      }
      return r;
    });

    // Fallback: if Markdown parsing failed and we had a caption, retry without parse_mode
    if (!res.ok && useCaption) {
      await withRetry(async () => {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendVoice`, {
          method: "POST",
          body: buildForm(false),
        });
        if (!r.ok) {
          const body = await r.text();
          throw new Error(`Telegram sendVoice failed: ${r.status} ${body}`);
        }
        return r;
      });
      return { captionSent: true };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Telegram sendVoice failed: ${res.status} ${body}`);
    }

    return { captionSent: useCaption };
  }

  async sendTyping(token: string, chatId: string): Promise<void> {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: "typing" }),
    });
    await res.text();
  }

  private async _sendMediaItem(
    token: string,
    chatId: string,
    item: MediaItem,
    caption?: string,
    parseMode?: string,
  ): Promise<Response> {
    const apiMethod = item.kind === "image" ? "sendPhoto" : "sendDocument";
    const fieldName = item.kind === "image" ? "photo" : "document";

    if (item.source.type === "url") {
      const body: Record<string, unknown> = { chat_id: chatId, [fieldName]: item.source.url };
      if (caption) {
        body.caption = caption;
        if (parseMode) body.parse_mode = parseMode;
      }
      const res = await fetch(`https://api.telegram.org/bot${token}/${apiMethod}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const resBody = await res.text();
      if (!res.ok) {
        log.error("Telegram media send failed", { apiMethod, status: res.status, response: resBody, url: item.source.url });
      }
      return new Response(resBody, { status: res.status });
    } else {
      const blob = base64ToBlob(item.source.data, item.source.mimeType);
      const ext = item.source.mimeType.split("/")[1] || "png";
      const form = new FormData();
      form.append("chat_id", chatId);
      form.append(fieldName, blob, `image.${ext}`);
      if (caption) {
        form.append("caption", caption);
        if (parseMode) form.append("parse_mode", parseMode);
      }
      const res = await fetch(`https://api.telegram.org/bot${token}/${apiMethod}`, {
        method: "POST",
        body: form,
      });
      const resBody = await res.text();
      if (!res.ok) {
        log.error("Telegram media send failed", { apiMethod, status: res.status, response: resBody });
      }
      return new Response(resBody, { status: res.status });
    }
  }

  private async _sendMediaGroup(
    token: string,
    chatId: string,
    items: MediaItem[],
    caption?: string,
    parseMode?: string,
  ): Promise<Response> {
    const allUrl = items.every(m => m.source.type === "url");

    if (allUrl) {
      const mediaArr = items.map((m, i) => {
        const entry: Record<string, unknown> = {
          type: "photo",
          media: (m.source as { type: "url"; url: string }).url,
        };
        if (i === 0 && caption) {
          entry.caption = caption;
          if (parseMode) entry.parse_mode = parseMode;
        }
        return entry;
      });
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, media: mediaArr }),
      });
      const resBody = await res.text();
      if (!res.ok) {
        log.error("Telegram sendMediaGroup failed", { status: res.status, response: resBody });
      }
      return new Response(resBody, { status: res.status });
    }

    // Mixed or base64 sources → use multipart form with attach:// references
    const form = new FormData();
    form.append("chat_id", chatId);
    const mediaArr = items.map((m, i) => {
      const attachName = `file${i}`;
      const entry: Record<string, unknown> = { type: "photo" };

      if (m.source.type === "url") {
        entry.media = m.source.url;
      } else {
        entry.media = `attach://${attachName}`;
        const blob = base64ToBlob(m.source.data, m.source.mimeType);
        const ext = m.source.mimeType.split("/")[1] || "png";
        form.append(attachName, blob, `image${i}.${ext}`);
      }
      if (i === 0 && caption) {
        entry.caption = caption;
        if (parseMode) entry.parse_mode = parseMode;
      }
      return entry;
    });
    form.append("media", JSON.stringify(mediaArr));
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
      method: "POST",
      body: form,
    });
    const resBody = await res.text();
    if (!res.ok) {
      log.error("Telegram sendMediaGroup failed", { status: res.status, response: resBody });
    }
    return new Response(resBody, { status: res.status });
  }

  private async _sendTextMessage(
    token: string,
    chatId: string,
    text: string,
  ): Promise<void> {
    const chunks = chunkText(text, this.maxMessageLength);

    for (const chunk of chunks) {
      const res = await withRetry(async () => {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            chat_id: chatId,
            text: chunk,
            parse_mode: "Markdown",
          }),
        });
        await r.text();
        return r;
      });
      // Fallback: if Markdown parsing fails (e.g. unmatched _ in tool names),
      // retry without parse_mode
      if (!res.ok) {
        await withRetry(async () => {
          const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              chat_id: chatId,
              text: chunk,
            }),
          });
          await r.text();
          return r;
        });
      }
    }
  }
}

/** Extract file references from Telegram webhook body (photos + all documents). */
export function extractTelegramFileRefs(body: unknown): ChannelFileRef[] {
  const msg = (body as any)?.message;
  if (!msg) return [];
  const refs: ChannelFileRef[] = [];

  // Photo: array of sizes, pick largest (last element)
  if (msg.photo && Array.isArray(msg.photo) && msg.photo.length > 0) {
    const largest = msg.photo[msg.photo.length - 1];
    if (largest?.file_id) {
      refs.push({ downloadUrl: `__telegram_file_id__:${largest.file_id}`, mediaType: "image/jpeg" });
    }
  }

  // Document: ALL types, not just images
  if (msg.document?.file_id) {
    refs.push({
      downloadUrl: `__telegram_file_id__:${msg.document.file_id}`,
      mediaType: msg.document.mime_type ?? "application/octet-stream",
      fileName: msg.document.file_name,
    });
  }

  // Voice message: OGG/Opus container
  if (msg.voice?.file_id) {
    refs.push({
      downloadUrl: `__telegram_file_id__:${msg.voice.file_id}`,
      mediaType: "audio/ogg",
      fileName: "voice.ogg",
    });
  }

  // Audio file: user-uploaded music/recording
  if (msg.audio?.file_id) {
    refs.push({
      downloadUrl: `__telegram_file_id__:${msg.audio.file_id}`,
      mediaType: msg.audio.mime_type ?? "audio/mpeg",
      fileName: msg.audio.file_name,
    });
  }

  return refs;
}


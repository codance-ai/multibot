import { TelegramAdapter } from "./telegram";
import { DiscordAdapter } from "./discord";
import { SlackAdapter } from "./slack";
import type { Env } from "../config/schema";

// ---- ChannelAdapter Interface ----

/** File attachment received from user (incoming). Stored in R2. */
export interface AttachmentRef {
  /** Unique identifier (short UUID, e.g. "a1b2c3d4") */
  id: string;
  /** R2 object key, e.g. "media/{botId}/{ts}_{id}.{ext}" */
  r2Key: string;
  /** Original filename from the channel, if available */
  fileName?: string;
  /** MIME type, e.g. "application/pdf", "text/plain", "image/jpeg" */
  mediaType: string;
  /** File size in bytes */
  sizeBytes?: number;
}

export interface ChannelPayload {
  chatId: string;
  userId: string;
  userName: string;
  userMessage: string;
  chatType: string;
  messageId: string;
  replyToName?: string;
  messageDate?: number;    // Unix seconds (Telegram message.date)
  replyToText?: string;    // Original message content being replied to
  /** Channel-specific mention identifiers (e.g. "@username" for Telegram, "U12345" for Slack). Always [] if parsed, undefined if not supported. */
  mentions?: string[];
  attachments?: AttachmentRef[];
  isVoiceMessage?: boolean;
}

export interface BotIdentity {
  channelUsername?: string;
  channelUserId?: string;
}

export interface ChannelAdapter {
  readonly name: string;
  readonly maxMessageLength: number;

  /**
   * Channel-specific pre-processing before token lookup.
   * Returns a Response to short-circuit (e.g. Telegram auth check, Slack URL verification),
   * or null to continue normal webhook processing.
   */
  preProcessWebhook?(request: Request, body: unknown, env: Env): Response | null;

  /**
   * Parse channel-specific webhook payload into normalized ChannelPayload.
   * Returns null if the message should be ignored.
   * Optional — Discord uses WebSocket gateway, not HTTP webhooks.
   */
  parseWebhook?(body: unknown): ChannelPayload | null;

  /**
   * Fetch the bot's own identity (username/userId) from the channel API.
   * Optional — not all channels support or need this.
   */
  getBotIdentity?(token: string, signal?: AbortSignal): Promise<BotIdentity | null>;

  /**
   * Send a message. Text is standard markdown; the adapter formats it for the platform internally.
   */
  sendMessage(token: string, chatId: string, text: string, options?: SenderOptions): Promise<void>;

  /**
   * Send an audio file with optional caption.
   * Returns { captionSent } indicating whether caption was included.
   * Throws on delivery failure so sendFinalReply can fallback to text.
   */
  sendAudio?(token: string, chatId: string, audio: ArrayBuffer, options?: SendAudioOptions): Promise<{ captionSent: boolean }>;

  /** Send typing indicator. */
  sendTyping(token: string, chatId: string): Promise<void>;

  /** Convert standard markdown to platform-native format. */
  formatMessage(markdown: string): string;
}

// ---- Shared Types ----

export type MediaKind = "image";

export interface MediaItem {
  kind: MediaKind;
  source:
    | { type: "url"; url: string }
    | { type: "base64"; data: string; mimeType: string };
}

export function base64ToBlob(b64: string, mimeType: string): Blob {
  const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
  return new Blob([bytes], { type: mimeType });
}

export interface SenderMeta {
  username?: string;
  avatarUrl?: string;
}

export interface SenderOptions {
  meta?: SenderMeta;
  media?: MediaItem[];
}

export interface SendAudioOptions extends SenderOptions {
  caption?: string;
}

// ---- Adapter Registry (lazy singleton) ----

let adapters: Record<string, ChannelAdapter> | null = null;

function initAdapters(): Record<string, ChannelAdapter> {
  if (!adapters) {
    adapters = {
      telegram: new TelegramAdapter(),
      discord: new DiscordAdapter(),
      slack: new SlackAdapter(),
    };
  }
  return adapters;
}

export function getAdapter(channel: string): ChannelAdapter | undefined {
  return initAdapters()[channel];
}

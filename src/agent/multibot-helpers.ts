import type { ImageAttachment } from "../utils/media";

/** Overall request timeout: 3 minutes. Prevents a single request from monopolizing the DO. */
export const REQUEST_TIMEOUT_MS = 3 * 60 * 1000;

/** DO Storage key for tracking in-flight requests. Used to detect orphaned messages after DO eviction. */
export const PENDING_REQUEST_KEY = "pendingRequest";
/** Grace period before a pending request is considered orphaned (slightly > REQUEST_TIMEOUT_MS). */
export const PENDING_ORPHAN_MS = REQUEST_TIMEOUT_MS + 30_000;

export interface PendingRequest {
  requestId: string;
  channel: string;
  channelToken: string;
  chatId: string;
  timestamp: number;
}

export class RequestTimeoutError extends Error {
  constructor() {
    super("Request timed out");
    this.name = "TimeoutError";
  }
}

/** Race a promise against a hard timeout. Rejects with TimeoutError if deadline is exceeded. */
export function withTimeout<T>(promise: Promise<T>, ms: number, abort?: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      abort?.abort();
      reject(new RequestTimeoutError());
    }, ms);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}

/** Default base URLs and models per image provider. gen.py is a pure executor -- all config comes from here. */
export const IMAGE_PROVIDER_DEFAULTS: Record<string, { baseUrl: string; model: string }> = {
  openai: { baseUrl: "https://api.openai.com", model: "gpt-image-1.5" },
  xai: { baseUrl: "https://api.x.ai", model: "grok-imagine-image" },
  google: { baseUrl: "https://generativelanguage.googleapis.com", model: "gemini-2.5-flash-image" },
};

export function attachmentsToJson(attachments: ImageAttachment[]): string | null {
  const r2Attachments = attachments.filter(att => att.url.startsWith("/media/"));
  if (r2Attachments.length === 0) return null;
  return JSON.stringify(
    r2Attachments.map(att => ({
      r2Key: att.url.replace(/^\//, ""),
      mediaType: att.mediaType,
    }))
  );
}

export function uint8ArrayToBase64(bytes: Uint8Array): string {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export function formatSizeCompact(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

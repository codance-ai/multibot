import type { Logger } from "./logger";

const MAX_BACKOFF_DELAY_MS = 30_000; // Cap for exponential backoff
const MAX_RETRY_AFTER_MS = 120_000; // Cap for server-specified Retry-After

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  retryIf?: (err: unknown) => boolean;
  log?: Logger;
}

/**
 * Check if an error is retryable (network errors, 429, 5xx).
 * Abort/timeout errors are never retried — they are intentional cancellations.
 */
export function isRetryableError(err: unknown): boolean {
  // Never retry abort or timeout errors (from AbortSignal.timeout / AbortController)
  const name = (err as any)?.name;
  if (name === "AbortError" || name === "TimeoutError") return false;

  // Network / fetch errors (no response at all)
  if (err instanceof TypeError) return true;

  // AI SDK and HTTP errors with statusCode or status
  const status =
    (err as any)?.statusCode ?? (err as any)?.status ?? (err as any)?.response?.status;
  if (typeof status === "number") {
    return status === 429 || (status >= 500 && status <= 599);
  }

  // AI SDK wraps errors losing the status code — detect by message
  const message = (err as any)?.message ?? "";
  if (typeof message === "string" && /overloaded|too many requests/i.test(message)) {
    return true;
  }

  return false;
}

/**
 * Execute an async function with retry and exponential backoff.
 *
 * Defaults: maxAttempts=3, baseDelayMs=500, retryIf=isRetryableError
 * Backoff: baseDelayMs * 2^(attempt-1)  →  500ms, 1000ms, 2000ms
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts?: RetryOptions
): Promise<T> {
  const maxAttempts = opts?.maxAttempts ?? 3;
  const baseDelayMs = opts?.baseDelayMs ?? 500;
  const retryIf = opts?.retryIf ?? isRetryableError;
  const log = opts?.log;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt >= maxAttempts || !retryIf(err)) {
        throw err;
      }
      // Prefer server-specified Retry-After over exponential backoff
      const retryAfterMs = (err as any)?.retryAfterMs;
      const backoff = baseDelayMs * Math.pow(2, attempt - 1);
      const jitter = Math.random() * 500;
      const delay =
        typeof retryAfterMs === "number" && retryAfterMs >= 0
          ? Math.min(retryAfterMs + jitter, MAX_RETRY_AFTER_MS)
          : Math.min(backoff + jitter, MAX_BACKOFF_DELAY_MS);
      log?.warn("Retrying after error", {
        attempt,
        maxAttempts,
        delayMs: Math.round(delay),
        error: err instanceof Error ? err.message : String(err),
      });
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // Should never reach here, but satisfy TypeScript
  throw lastError;
}

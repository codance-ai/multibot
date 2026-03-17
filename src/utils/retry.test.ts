import { describe, it, expect, vi, afterEach } from "vitest";
import { withRetry, isRetryableError } from "./retry";
import { Logger } from "./logger";

afterEach(() => {
  vi.useRealTimers();
});

describe("isRetryableError", () => {
  it("returns true for TypeError (network error)", () => {
    expect(isRetryableError(new TypeError("fetch failed"))).toBe(true);
  });

  it("returns true for 429 status", () => {
    expect(isRetryableError({ statusCode: 429 })).toBe(true);
  });

  it("returns true for 500-599 status codes", () => {
    expect(isRetryableError({ statusCode: 500 })).toBe(true);
    expect(isRetryableError({ statusCode: 502 })).toBe(true);
    expect(isRetryableError({ statusCode: 503 })).toBe(true);
    expect(isRetryableError({ status: 504 })).toBe(true);
  });

  it("returns false for 4xx auth errors", () => {
    expect(isRetryableError({ statusCode: 401 })).toBe(false);
    expect(isRetryableError({ statusCode: 403 })).toBe(false);
    expect(isRetryableError({ statusCode: 400 })).toBe(false);
  });

  it("returns false for generic errors", () => {
    expect(isRetryableError(new Error("something"))).toBe(false);
  });

  it("returns false for AbortError", () => {
    const err = new DOMException("signal is aborted", "AbortError");
    expect(isRetryableError(err)).toBe(false);
  });

  it("returns false for TimeoutError", () => {
    const err = new DOMException("signal timed out", "TimeoutError");
    expect(isRetryableError(err)).toBe(false);
  });

  it("returns false for abort-like error even with TypeError-like properties", () => {
    // AI SDK may wrap abort errors — name takes priority
    const err = Object.assign(new TypeError("fetch failed"), { name: "AbortError" });
    expect(isRetryableError(err)).toBe(false);
  });
});

describe("withRetry", () => {
  it("returns result on first success without retrying", async () => {
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await withRetry(fn);

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("retries on retryable error and succeeds", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce("recovered");

    const result = await withRetry(fn, { baseDelayMs: 1 });

    expect(result).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("throws after max attempts exceeded", async () => {
    const fn = vi.fn().mockRejectedValue(new TypeError("fetch failed"));

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })
    ).rejects.toThrow("fetch failed");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws immediately for non-retryable errors", async () => {
    const error = Object.assign(new Error("Unauthorized"), { statusCode: 401 });
    const fn = vi.fn().mockRejectedValue(error);

    await expect(withRetry(fn)).rejects.toThrow("Unauthorized");
    expect(fn).toHaveBeenCalledOnce();
  });

  it("uses custom retryIf predicate", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new Error("custom-retriable"))
      .mockResolvedValueOnce("ok");

    const result = await withRetry(fn, {
      baseDelayMs: 1,
      retryIf: (err) => (err as Error).message === "custom-retriable",
    });

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("applies exponential backoff delays", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5); // jitter = 250ms
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fail"))
      .mockRejectedValueOnce(new TypeError("fail"))
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 });

    // After first failure: 100ms + 250ms jitter = 350ms
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(350);
    expect(fn).toHaveBeenCalledTimes(2);

    // After second failure: 200ms + 250ms jitter = 450ms
    await vi.advanceTimersByTimeAsync(450);
    const result = await promise;

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(3);
    vi.restoreAllMocks();
  });

  it("logs warn on retry when log is provided", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const log = new Logger({ requestId: "r1" });
    const warnSpy = vi.spyOn(log, "warn");

    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce("ok");

    await withRetry(fn, { baseDelayMs: 1, retryIf: isRetryableError, log });

    expect(warnSpy).toHaveBeenCalledOnce();
    expect(warnSpy).toHaveBeenCalledWith("Retrying after error", expect.objectContaining({
      attempt: 1,
      maxAttempts: 3,
      error: "fetch failed",
    }));
  });

  it("does not log when no log is provided", async () => {
    const fn = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce("ok");

    // Should not throw even without log
    const result = await withRetry(fn, { baseDelayMs: 1 });
    expect(result).toBe("ok");
  });

  it("uses retryAfterMs from error instead of default backoff", async () => {
    vi.useFakeTimers();
    const err429 = Object.assign(new Error("rate limited"), {
      status: 429,
      retryAfterMs: 5000,
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(err429)
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { maxAttempts: 3, baseDelayMs: 100 });

    expect(fn).toHaveBeenCalledTimes(1);

    // Default backoff would be 100ms, but retryAfterMs is 5000ms + jitter (0-500ms)
    await vi.advanceTimersByTimeAsync(100);
    expect(fn).toHaveBeenCalledTimes(1); // Still waiting — not retried yet

    await vi.advanceTimersByTimeAsync(5400); // 5000 + max jitter
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("caps retryAfterMs at MAX_RETRY_AFTER_MS (120s)", async () => {
    vi.useFakeTimers();
    const errHuge = Object.assign(new Error("rate limited"), {
      status: 429,
      retryAfterMs: 300_000, // 5 minutes
    });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(errHuge)
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { maxAttempts: 2, baseDelayMs: 100 });

    // Should be capped at 120s + jitter, not 300s
    await vi.advanceTimersByTimeAsync(121_000);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("falls back to default backoff when retryAfterMs is not set", async () => {
    vi.useFakeTimers();
    const err500 = Object.assign(new Error("server error"), { status: 500 });

    const fn = vi
      .fn()
      .mockRejectedValueOnce(err500)
      .mockResolvedValueOnce("ok");

    const promise = withRetry(fn, { maxAttempts: 2, baseDelayMs: 200 });

    // Default backoff: 200ms + jitter (0-500ms)
    await vi.advanceTimersByTimeAsync(700);
    const result = await promise;
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateUploadToken,
  validateUploadToken,
  detectImageType,
  handleInternalUpload,
} from "./upload";
import type { Env } from "../config/schema";

const TEST_SECRET = "test-webhook-secret-at-least-32-chars-long!!";

// Mock media.ts
vi.mock("../utils/media", () => ({
  uploadImageToR2: vi.fn().mockResolvedValue("/media/bot123/12345_abcd.jpeg"),
}));

import { uploadImageToR2 } from "../utils/media";
const mockUploadImageToR2 = vi.mocked(uploadImageToR2);

function makeEnv(overrides?: Partial<Env>) {
  const putCalls: { key: string; contentType?: string }[] = [];
  return {
    env: {
      WEBHOOK_SECRET: TEST_SECRET,
      ASSETS_BUCKET: {
        put: async (key: string, body: any, opts?: any) => {
          putCalls.push({ key, contentType: opts?.httpMetadata?.contentType });
        },
      } as unknown as R2Bucket,
      ...overrides,
    } as unknown as Env,
    putCalls,
  };
}

// Helper to make a JPEG byte array (minimal valid magic bytes)
function makeJpegBytes(size = 10): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  return bytes;
}

// Helper to make a PNG byte array
function makePngBytes(size = 12): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0x89;
  bytes[1] = 0x50;
  bytes[2] = 0x4e;
  bytes[3] = 0x47;
  return bytes;
}

// Helper to make a GIF byte array
function makeGifBytes(size = 10): Uint8Array {
  const bytes = new Uint8Array(size);
  bytes[0] = 0x47; // G
  bytes[1] = 0x49; // I
  bytes[2] = 0x46; // F
  return bytes;
}

// Helper to make a WebP byte array
function makeWebpBytes(): Uint8Array {
  const bytes = new Uint8Array(12);
  bytes[0] = 0x52; // R
  bytes[1] = 0x49; // I
  bytes[2] = 0x46; // F
  bytes[3] = 0x46; // F
  // bytes 4-7: file size (arbitrary)
  bytes[8] = 0x57; // W
  bytes[9] = 0x45; // E
  bytes[10] = 0x42; // B
  bytes[11] = 0x50; // P
  return bytes;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockUploadImageToR2.mockResolvedValue("/media/bot123/12345_abcd.jpeg");
});

// ---------------------------------------------------------------------------
// generateUploadToken
// ---------------------------------------------------------------------------

describe("generateUploadToken", () => {
  it("generates a non-empty JWT string", async () => {
    const token = await generateUploadToken("bot123", TEST_SECRET);
    expect(typeof token).toBe("string");
    expect(token.length).toBeGreaterThan(0);
    // JWT has 3 parts separated by dots
    const parts = token.split(".");
    expect(parts).toHaveLength(3);
  });

  it("roundtrips: generated token validates and returns botId", async () => {
    const token = await generateUploadToken("bot-abc", TEST_SECRET);
    const result = await validateUploadToken(token, TEST_SECRET);
    expect(result).toBe("bot-abc");
  });
});

// ---------------------------------------------------------------------------
// validateUploadToken
// ---------------------------------------------------------------------------

describe("validateUploadToken", () => {
  it("returns botId for a valid upload token", async () => {
    const token = await generateUploadToken("bot42", TEST_SECRET);
    const result = await validateUploadToken(token, TEST_SECRET);
    expect(result).toBe("bot42");
  });

  it("returns null for an invalid token string", async () => {
    const result = await validateUploadToken("not-a-jwt", TEST_SECRET);
    expect(result).toBeNull();
  });

  it("returns null when signed with a different secret", async () => {
    const token = await generateUploadToken("bot42", TEST_SECRET);
    const result = await validateUploadToken(token, "different-secret-that-is-long-enough!!");
    expect(result).toBeNull();
  });

  it("returns null for a token with wrong purpose", async () => {
    // Sign a token manually with wrong purpose using jose
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(TEST_SECRET);
    const token = await new SignJWT({ botId: "bot42", purpose: "session" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt()
      .setExpirationTime("2m")
      .sign(key);
    const result = await validateUploadToken(token, TEST_SECRET);
    expect(result).toBeNull();
  });

  it("returns null for an expired token", async () => {
    // Sign a token with past expiry
    const { SignJWT } = await import("jose");
    const key = new TextEncoder().encode(TEST_SECRET);
    // Use numeric iat and exp in the past
    const iat = Math.floor(Date.now() / 1000) - 300; // 5 min ago
    const exp = iat + 1; // expired 4m59s ago
    const token = await new SignJWT({ botId: "bot42", purpose: "upload" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuedAt(iat)
      .setExpirationTime(exp)
      .sign(key);
    const result = await validateUploadToken(token, TEST_SECRET);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// detectImageType
// ---------------------------------------------------------------------------

describe("detectImageType", () => {
  it("detects JPEG", () => {
    expect(detectImageType(makeJpegBytes())).toBe("image/jpeg");
  });

  it("detects PNG", () => {
    expect(detectImageType(makePngBytes())).toBe("image/png");
  });

  it("detects GIF", () => {
    expect(detectImageType(makeGifBytes())).toBe("image/gif");
  });

  it("detects WebP", () => {
    expect(detectImageType(makeWebpBytes())).toBe("image/webp");
  });

  it("returns null for non-image data (plain text)", () => {
    const bytes = new TextEncoder().encode("Hello, world!");
    expect(detectImageType(bytes)).toBeNull();
  });

  it("returns null for data shorter than 4 bytes", () => {
    expect(detectImageType(new Uint8Array([0xff, 0xd8]))).toBeNull();
  });

  it("returns null for empty array", () => {
    expect(detectImageType(new Uint8Array(0))).toBeNull();
  });

  it("returns null for RIFF without WEBP marker", () => {
    const bytes = new Uint8Array(12);
    bytes[0] = 0x52; // R
    bytes[1] = 0x49; // I
    bytes[2] = 0x46; // F
    bytes[3] = 0x46; // F
    // bytes 8-11: not WEBP
    bytes[8] = 0x41;
    bytes[9] = 0x56;
    bytes[10] = 0x49;
    bytes[11] = 0x20;
    expect(detectImageType(bytes)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handleInternalUpload
// ---------------------------------------------------------------------------

describe("handleInternalUpload", () => {
  function makeRequest(opts: {
    token?: string;
    botId?: string;
    body?: BodyInit | null;
    method?: string;
  } = {}): Request {
    const url = new URL("https://example.com/internal/upload");
    if (opts.token !== undefined) url.searchParams.set("token", opts.token);
    if (opts.botId !== undefined) url.searchParams.set("botId", opts.botId);
    return new Request(url.toString(), {
      method: opts.method ?? "PUT",
      body: opts.body ?? null,
    });
  }

  it("returns 401 when token param is missing", async () => {
    const { env } = makeEnv();
    const req = makeRequest({ botId: "bot123" });
    const res = await handleInternalUpload(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is invalid", async () => {
    const { env } = makeEnv();
    const req = makeRequest({ token: "bad-token", botId: "bot123", body: makeJpegBytes() });
    const res = await handleInternalUpload(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 401 when token botId mismatches query botId", async () => {
    const { env } = makeEnv();
    const token = await generateUploadToken("bot-other", TEST_SECRET);
    const req = makeRequest({ token, botId: "bot123", body: makeJpegBytes() });
    const res = await handleInternalUpload(req, env);
    expect(res.status).toBe(401);
  });

  it("returns 400 for empty body", async () => {
    const { env } = makeEnv();
    const token = await generateUploadToken("bot123", TEST_SECRET);
    const req = makeRequest({ token, botId: "bot123", body: new Uint8Array(0) });
    const res = await handleInternalUpload(req, env);
    expect(res.status).toBe(400);
  });

  it("returns 400 for non-image data", async () => {
    const { env } = makeEnv();
    const token = await generateUploadToken("bot123", TEST_SECRET);
    const body = new TextEncoder().encode("not an image at all");
    const req = makeRequest({ token, botId: "bot123", body });
    const res = await handleInternalUpload(req, env);
    expect(res.status).toBe(400);
  });

  it("returns 400 for body exceeding 5MB", async () => {
    const { env } = makeEnv();
    const token = await generateUploadToken("bot123", TEST_SECRET);
    // Build a fake image-like body > 5MB: start with JPEG magic bytes then pad
    const big = new Uint8Array(5 * 1024 * 1024 + 1);
    big[0] = 0xff;
    big[1] = 0xd8;
    big[2] = 0xff;
    const req = makeRequest({ token, botId: "bot123", body: big });
    const res = await handleInternalUpload(req, env);
    expect(res.status).toBe(400);
  });

  it("returns 500 when ASSETS_BUCKET is not configured", async () => {
    const { env } = makeEnv({ ASSETS_BUCKET: undefined });
    const token = await generateUploadToken("bot123", TEST_SECRET);
    const req = makeRequest({ token, botId: "bot123", body: makeJpegBytes() });
    const res = await handleInternalUpload(req, env);
    expect(res.status).toBe(500);
  });

  it("returns 200 with path for valid JPEG upload", async () => {
    const { env } = makeEnv();
    const token = await generateUploadToken("bot123", TEST_SECRET);
    const req = makeRequest({ token, botId: "bot123", body: makeJpegBytes() });
    const res = await handleInternalUpload(req, env);
    expect(res.status).toBe(200);
    const body = await res.json() as { path: string };
    expect(typeof body.path).toBe("string");
    expect(body.path.length).toBeGreaterThan(0);
  });

  it("calls uploadImageToR2 with correct contentType for JPEG", async () => {
    const { env } = makeEnv();
    const token = await generateUploadToken("bot123", TEST_SECRET);
    const req = makeRequest({ token, botId: "bot123", body: makeJpegBytes() });
    await handleInternalUpload(req, env);
    expect(mockUploadImageToR2).toHaveBeenCalledWith(
      expect.anything(), // bucket
      "bot123",
      expect.any(Uint8Array),
      "image/jpeg",
    );
  });

  it("calls uploadImageToR2 with correct contentType for PNG", async () => {
    mockUploadImageToR2.mockResolvedValueOnce("/media/bot123/12345_abcd.png");
    const { env } = makeEnv();
    const token = await generateUploadToken("bot123", TEST_SECRET);
    const req = makeRequest({ token, botId: "bot123", body: makePngBytes() });
    const res = await handleInternalUpload(req, env);
    expect(res.status).toBe(200);
    expect(mockUploadImageToR2).toHaveBeenCalledWith(
      expect.anything(),
      "bot123",
      expect.any(Uint8Array),
      "image/png",
    );
  });
});

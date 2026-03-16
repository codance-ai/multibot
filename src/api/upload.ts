import { SignJWT, jwtVerify } from "jose";
import type { Env } from "../config/schema";
import { uploadImageToR2 } from "../utils/media";

const UPLOAD_TOKEN_EXPIRY = "2m";
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5MB

function getSigningKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Generate a short-lived upload token (2 min) for the given botId.
 * Claims: { botId, purpose: "upload" }. Signed with HS256.
 */
export async function generateUploadToken(
  botId: string,
  secret: string,
): Promise<string> {
  return new SignJWT({ botId, purpose: "upload" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(UPLOAD_TOKEN_EXPIRY)
    .sign(getSigningKey(secret));
}

/**
 * Validate an upload token. Returns the botId on success, null on any failure.
 */
export async function validateUploadToken(
  token: string,
  secret: string,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, getSigningKey(secret));
    if (payload["purpose"] !== "upload") return null;
    if (typeof payload["botId"] !== "string") return null;
    return payload["botId"];
  } catch (e) {
    console.warn(JSON.stringify({ msg: "validateUploadToken: verification failed", error: e instanceof Error ? e.message : String(e) }));
    return null;
  }
}

/**
 * Detect image media type from magic bytes.
 * Returns the MIME type string or null if unrecognised / too short.
 */
export function detectImageType(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;

  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }

  // PNG: 89 50 4E 47
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }

  // GIF: 47 49 46
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return "image/gif";
  }

  // WebP: RIFF .... WEBP (bytes 0-3 = "RIFF", bytes 8-11 = "WEBP")
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }

  return null;
}

/**
 * PUT handler for internal image uploads.
 * Query params: token, botId
 * Body: raw image bytes
 * Returns: { path } on success
 */
export async function handleInternalUpload(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  const botId = url.searchParams.get("botId");

  // Auth: token must be present and valid, and match the botId param
  if (!token || !botId) {
    return Response.json({ error: "Missing token or botId" }, { status: 401 });
  }

  const tokenBotId = await validateUploadToken(token, env.WEBHOOK_SECRET);
  if (!tokenBotId) {
    return Response.json({ error: "Invalid or expired token" }, { status: 401 });
  }

  if (tokenBotId !== botId) {
    return Response.json({ error: "Token botId mismatch" }, { status: 401 });
  }

  // Bucket must be configured
  if (!env.ASSETS_BUCKET) {
    return Response.json({ error: "Storage not configured" }, { status: 500 });
  }

  // Read body
  const buffer = await request.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  // Validate body size
  if (bytes.length === 0) {
    return Response.json({ error: "Empty body" }, { status: 400 });
  }

  if (bytes.length > MAX_UPLOAD_BYTES) {
    return Response.json({ error: "File too large (max 5MB)" }, { status: 400 });
  }

  // Detect image type
  const mediaType = detectImageType(bytes);
  if (!mediaType) {
    return Response.json({ error: "Unsupported file type" }, { status: 400 });
  }

  // Upload to R2
  const path = await uploadImageToR2(env.ASSETS_BUCKET, botId, bytes, mediaType);

  console.log(JSON.stringify({
    msg: "upload: image stored",
    botId,
    path,
    size: bytes.length,
    mediaType,
  }));

  return Response.json({ path });
}

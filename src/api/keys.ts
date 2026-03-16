import type { Env, UserKeys } from "../config/schema";
import { UpdateKeysSchema } from "../config/schema";
import type { RouteParams } from "./router";
import * as configDb from "../db/config";

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/** Mask a key value: show only last 4 chars, prefix with ****. */
function maskKey(value: string | undefined): string | null {
  if (!value) return null;
  if (value.length <= 4) return "****";
  return "****" + value.slice(-4);
}

function maskKeys(keys: UserKeys): Record<string, string | null> {
  return {
    openai: maskKey(keys.openai),
    anthropic: maskKey(keys.anthropic),
    google: maskKey(keys.google),
    deepseek: maskKey(keys.deepseek),
    moonshot: maskKey(keys.moonshot),
    brave: maskKey(keys.brave),
    xai: maskKey(keys.xai),
    elevenlabs: maskKey(keys.elevenlabs),
    fish: maskKey(keys.fish),
  };
}

export async function handleGetKeys(
  _request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;
  const keys = await configDb.getUserKeys(env.D1_DB, ownerId);
  if (!keys) return jsonResponse({ openai: null, anthropic: null, google: null, deepseek: null, moonshot: null, brave: null, xai: null, elevenlabs: null, fish: null });

  return jsonResponse(maskKeys(keys));
}

export async function handleUpdateKeys(
  request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;

  let body: unknown;
  try {
    body = await request.json();
  } catch (e) {
    console.warn("[api] Invalid JSON in update keys:", e);
    return errorResponse("Invalid JSON", 400);
  }

  const parsed = UpdateKeysSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.message, 400);
  }

  // Load existing keys from D1
  const existing: UserKeys = (await configDb.getUserKeys(env.D1_DB, ownerId)) ?? {};

  // Merge: null deletes a key, string sets it, undefined leaves unchanged
  const updated: UserKeys = { ...existing };
  for (const [key, value] of Object.entries(parsed.data)) {
    if (value === null) {
      delete (updated as any)[key];
    } else if (value !== undefined) {
      (updated as any)[key] = value;
    }
  }

  await configDb.upsertUserKeys(env.D1_DB, ownerId, updated);
  return jsonResponse(maskKeys(updated));
}

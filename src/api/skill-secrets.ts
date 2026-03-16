import type { Env } from "../config/schema";
import type { RouteParams } from "./router";
import * as configDb from "../db/config";

/** GET /api/skill-secrets — list all skill secrets for owner (values masked) */
export async function handleListSkillSecrets(
  _request: Request,
  env: Env,
  params: RouteParams,
): Promise<Response> {
  const secrets = await configDb.getSkillSecrets(env.D1_DB, params.ownerId);

  // Mask values: show first 4 chars + "..." + last 3 chars, or "***" for short values
  const masked: Record<string, Record<string, string>> = {};
  for (const [skill, vars] of Object.entries(secrets)) {
    masked[skill] = {};
    for (const [key, value] of Object.entries(vars)) {
      masked[skill][key] = value.length > 6
        ? value.slice(0, 4) + "..." + value.slice(-3)
        : "***";
    }
  }

  return Response.json(masked);
}

/** PUT /api/skill-secrets/:skillName — set env vars for a skill */
export async function handleSetSkillSecret(
  request: Request,
  env: Env,
  params: RouteParams,
): Promise<Response> {
  const skillName = decodeURIComponent(params.skillName);

  let raw: unknown;
  try {
    raw = await request.json();
  } catch (e) {
    console.warn("[api] Invalid JSON body in skill-secrets:", e);
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return Response.json({ error: "Body must be a JSON object" }, { status: 400 });
  }
  const body = raw as Record<string, string | null>;

  // Validate: values must be non-empty strings or null (null = delete key)
  for (const [key, value] of Object.entries(body)) {
    if (typeof key !== "string") {
      return Response.json({ error: `Invalid env var key: ${key}` }, { status: 400 });
    }
    if (value !== null && (typeof value !== "string" || !value)) {
      return Response.json({ error: `Invalid env var: ${key}` }, { status: 400 });
    }
  }

  // Merge with existing secrets: null values remove keys, strings set them
  const allSecrets = await configDb.getSkillSecrets(env.D1_DB, params.ownerId);
  const current = { ...(allSecrets[skillName] ?? {}) };
  for (const [key, value] of Object.entries(body)) {
    if (value === null) {
      delete current[key];
    } else {
      current[key] = value;
    }
  }

  if (Object.keys(current).length === 0) {
    await configDb.deleteSkillSecret(env.D1_DB, params.ownerId, skillName);
  } else {
    await configDb.upsertSkillSecret(env.D1_DB, params.ownerId, skillName, current);
  }
  return Response.json({ ok: true });
}

/** DELETE /api/skill-secrets/:skillName — remove secrets for a skill */
export async function handleDeleteSkillSecret(
  _request: Request,
  env: Env,
  params: RouteParams,
): Promise<Response> {
  const skillName = decodeURIComponent(params.skillName);
  await configDb.deleteSkillSecret(env.D1_DB, params.ownerId, skillName);
  return Response.json({ ok: true });
}

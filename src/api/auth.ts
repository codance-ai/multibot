import { SignJWT, jwtVerify } from "jose";
import type { Env } from "../config/schema";

const COOKIE_NAME = "multibot_session";
const SESSION_MAX_AGE = 7 * 24 * 60 * 60; // 7 days in seconds

function getSigningKey(env: Env): Uint8Array {
  return new TextEncoder().encode(env.WEBHOOK_SECRET);
}

/**
 * Validate the session cookie JWT.
 * Returns the ownerId on success, or null on failure.
 */
export async function validateSession(
  request: Request,
  env: Env,
): Promise<string | null> {
  if (!env.DASHBOARD_PASSWORD || !env.OWNER_ID) return null;

  const cookie = request.headers.get("Cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE_NAME}=([^;]+)`));
  if (!match) return null;

  try {
    const { payload } = await jwtVerify(match[1], getSigningKey(env));
    if (payload.sub !== env.OWNER_ID) return null;
    return payload.sub;
  } catch {
    return null;
  }
}

/**
 * Handle POST /api/auth/login — validate password, set session cookie.
 */
export async function handleLogin(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!env.DASHBOARD_PASSWORD || !env.OWNER_ID) {
    return Response.json(
      { error: "DASHBOARD_PASSWORD or OWNER_ID not configured" },
      { status: 500 },
    );
  }

  const body = await request.json().catch(() => null) as { password?: string } | null;
  if (!body?.password) {
    return Response.json({ error: "Password required" }, { status: 400 });
  }

  if (body.password !== env.DASHBOARD_PASSWORD) {
    return Response.json({ error: "Invalid password" }, { status: 401 });
  }

  const token = await new SignJWT({ sub: env.OWNER_ID })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${SESSION_MAX_AGE}s`)
    .sign(getSigningKey(env));

  const isSecure = new URL(request.url).protocol === "https:";
  const cookie = [
    `${COOKIE_NAME}=${token}`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=${SESSION_MAX_AGE}`,
    ...(isSecure ? ["Secure"] : []),
  ].join("; ");

  return Response.json({ ok: true }, {
    headers: { "Set-Cookie": cookie },
  });
}

/**
 * Handle POST /api/auth/logout — clear session cookie.
 */
export function handleLogout(request: Request): Response {
  const isSecure = new URL(request.url).protocol === "https:";
  const cookie = [
    `${COOKIE_NAME}=`,
    `Path=/`,
    `HttpOnly`,
    `SameSite=Lax`,
    `Max-Age=0`,
    ...(isSecure ? ["Secure"] : []),
  ].join("; ");

  return Response.json({ ok: true }, {
    headers: { "Set-Cookie": cookie },
  });
}

/**
 * Handle GET /api/auth/check — return auth status.
 */
export async function handleAuthCheck(
  request: Request,
  env: Env,
): Promise<Response> {
  const ownerId = await validateSession(request, env);
  if (!ownerId) {
    return Response.json({ authenticated: false }, { status: 401 });
  }
  return Response.json({ authenticated: true, ownerId });
}

import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateSession, handleLogin, handleLogout, handleAuthCheck } from "./auth";
import type { Env } from "../config/schema";

// Mock jose module
vi.mock("jose", () => ({
  SignJWT: vi.fn().mockImplementation(() => {
    const chain: Record<string, unknown> = {};
    chain.setProtectedHeader = vi.fn().mockReturnValue(chain);
    chain.setIssuedAt = vi.fn().mockReturnValue(chain);
    chain.setExpirationTime = vi.fn().mockReturnValue(chain);
    chain.sign = vi.fn().mockResolvedValue("mock-jwt-token");
    return chain;
  }),
  jwtVerify: vi.fn(),
}));

import { jwtVerify } from "jose";
const mockJwtVerify = vi.mocked(jwtVerify);

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    WEBHOOK_SECRET: "test-secret",
    DASHBOARD_PASSWORD: "test-password",
    OWNER_ID: "owner@example.com",
    ...overrides,
  } as Env;
}

function makeRequest(opts: { cookie?: string; method?: string; body?: unknown; url?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers["Cookie"] = opts.cookie;
  if (opts.body) headers["Content-Type"] = "application/json";
  return new Request(opts.url ?? "https://example.com/api/bots", {
    method: opts.method ?? "GET",
    headers,
    ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("validateSession", () => {
  it("returns null when DASHBOARD_PASSWORD is not configured", async () => {
    const env = makeEnv({ DASHBOARD_PASSWORD: undefined });
    const result = await validateSession(makeRequest(), env);
    expect(result).toBeNull();
  });

  it("returns null when OWNER_ID is not configured", async () => {
    const env = makeEnv({ OWNER_ID: undefined });
    const result = await validateSession(makeRequest(), env);
    expect(result).toBeNull();
  });

  it("returns null when no cookie is present", async () => {
    const result = await validateSession(makeRequest(), makeEnv());
    expect(result).toBeNull();
  });

  it("returns ownerId on valid session cookie", async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: { sub: "owner@example.com" },
      protectedHeader: { alg: "HS256" },
    } as any);

    const result = await validateSession(
      makeRequest({ cookie: "multibot_session=valid-token" }),
      makeEnv(),
    );
    expect(result).toBe("owner@example.com");
  });

  it("returns null when JWT verification fails", async () => {
    mockJwtVerify.mockRejectedValueOnce(new Error("Invalid token"));

    const result = await validateSession(
      makeRequest({ cookie: "multibot_session=bad-token" }),
      makeEnv(),
    );
    expect(result).toBeNull();
  });

  it("returns null when sub does not match OWNER_ID", async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: { sub: "someone-else@example.com" },
      protectedHeader: { alg: "HS256" },
    } as any);

    const result = await validateSession(
      makeRequest({ cookie: "multibot_session=valid-token" }),
      makeEnv(),
    );
    expect(result).toBeNull();
  });
});

describe("handleLogin", () => {
  it("returns 500 when DASHBOARD_PASSWORD is not configured", async () => {
    const env = makeEnv({ DASHBOARD_PASSWORD: undefined });
    const res = await handleLogin(makeRequest({ method: "POST", body: { password: "x" } }), env);
    expect(res.status).toBe(500);
  });

  it("returns 400 when no password provided", async () => {
    const res = await handleLogin(makeRequest({ method: "POST", body: {} }), makeEnv());
    expect(res.status).toBe(400);
  });

  it("returns 401 on wrong password", async () => {
    const res = await handleLogin(
      makeRequest({ method: "POST", body: { password: "wrong" } }),
      makeEnv(),
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 with Set-Cookie on correct password", async () => {
    const res = await handleLogin(
      makeRequest({ method: "POST", body: { password: "test-password" } }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie");
    expect(cookie).toContain("multibot_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
  });
});

describe("handleLogout", () => {
  it("clears the session cookie", async () => {
    const res = handleLogout(makeRequest());
    expect(res.status).toBe(200);
    const cookie = res.headers.get("Set-Cookie");
    expect(cookie).toContain("multibot_session=");
    expect(cookie).toContain("Max-Age=0");
  });
});

describe("handleAuthCheck", () => {
  it("returns 401 when not authenticated", async () => {
    const res = await handleAuthCheck(makeRequest(), makeEnv());
    expect(res.status).toBe(401);
  });

  it("returns 200 when authenticated", async () => {
    mockJwtVerify.mockResolvedValueOnce({
      payload: { sub: "owner@example.com" },
      protectedHeader: { alg: "HS256" },
    } as any);

    const res = await handleAuthCheck(
      makeRequest({ cookie: "multibot_session=valid-token" }),
      makeEnv(),
    );
    expect(res.status).toBe(200);
    const body = await res.json() as { authenticated: boolean };
    expect(body.authenticated).toBe(true);
  });
});

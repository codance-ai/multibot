import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleGetKeys, handleUpdateKeys } from "./keys";
import type { Env, UserKeys } from "../config/schema";

// -- Mock configDb module --

vi.mock("../db/config", () => ({
  getUserKeys: vi.fn(),
  upsertUserKeys: vi.fn(),
}));

import * as configDb from "../db/config";

beforeEach(() => {
  vi.clearAllMocks();
});

const OWNER_ID = "test-owner";

function makeEnv(): Env {
  return {
    D1_DB: {} as D1Database,
  } as Env;
}

function jsonRequest(method: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request("https://example.com/api/keys", init);
}

describe("handleGetKeys", () => {
  it("returns all nulls when no keys exist", async () => {
    vi.mocked(configDb.getUserKeys).mockResolvedValueOnce(null);
    const env = makeEnv();
    const res = await handleGetKeys(jsonRequest("GET"), env, { ownerId: OWNER_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      openai: null,
      anthropic: null,
      google: null,
      deepseek: null,
      moonshot: null,
      brave: null,
      xai: null,
      elevenlabs: null,
      fish: null,
    });
  });

  it("returns masked keys", async () => {
    vi.mocked(configDb.getUserKeys).mockResolvedValueOnce({
      openai: "sk-1234567890abcdef",
      anthropic: "sk-ant-xyz9",
    });
    const env = makeEnv();

    const res = await handleGetKeys(jsonRequest("GET"), env, { ownerId: OWNER_ID });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.openai).toBe("****cdef");
    expect(data.anthropic).toBe("****xyz9");
    expect(data.brave).toBeNull();
  });

  it("masks short keys with only ****", async () => {
    vi.mocked(configDb.getUserKeys).mockResolvedValueOnce({
      openai: "abc",
    });
    const env = makeEnv();

    const res = await handleGetKeys(jsonRequest("GET"), env, { ownerId: OWNER_ID });
    const data: any = await res.json();
    expect(data.openai).toBe("****");
  });
});

describe("handleUpdateKeys", () => {
  it("returns 400 for invalid JSON", async () => {
    const env = makeEnv();
    const req = new Request("https://example.com/api/keys", {
      method: "PUT",
      body: "not json",
    });
    const res = await handleUpdateKeys(req, env, { ownerId: OWNER_ID });
    expect(res.status).toBe(400);
  });

  it("creates keys from scratch", async () => {
    vi.mocked(configDb.getUserKeys).mockResolvedValueOnce(null);
    vi.mocked(configDb.upsertUserKeys).mockResolvedValueOnce(undefined);
    const env = makeEnv();

    const res = await handleUpdateKeys(
      jsonRequest("PUT", { openai: "sk-new-key-1234" }),
      env,
      { ownerId: OWNER_ID }
    );
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.openai).toBe("****1234");

    // Verify upsertUserKeys was called with unmasked value
    expect(configDb.upsertUserKeys).toHaveBeenCalledOnce();
    const calledKeys = vi.mocked(configDb.upsertUserKeys).mock.calls[0][2];
    expect(calledKeys.openai).toBe("sk-new-key-1234");
  });

  it("merges with existing keys", async () => {
    vi.mocked(configDb.getUserKeys).mockResolvedValueOnce({
      openai: "sk-old",
      brave: "br-old",
    });
    vi.mocked(configDb.upsertUserKeys).mockResolvedValueOnce(undefined);
    const env = makeEnv();

    const res = await handleUpdateKeys(
      jsonRequest("PUT", { anthropic: "sk-ant-new1" }),
      env,
      { ownerId: OWNER_ID }
    );
    expect(res.status).toBe(200);
    const data: any = await res.json();
    // Old keys preserved
    expect(data.openai).toBe("****-old");
    expect(data.brave).toBe("****-old");
    // New key added
    expect(data.anthropic).toBe("****new1");
  });

  it("deletes a key when set to null", async () => {
    vi.mocked(configDb.getUserKeys).mockResolvedValueOnce({
      openai: "sk-old",
      brave: "br-old",
    });
    vi.mocked(configDb.upsertUserKeys).mockResolvedValueOnce(undefined);
    const env = makeEnv();

    const res = await handleUpdateKeys(
      jsonRequest("PUT", { openai: null }),
      env,
      { ownerId: OWNER_ID }
    );
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.openai).toBeNull();
    expect(data.brave).toBe("****-old");

    // Verify stored keys
    const calledKeys = vi.mocked(configDb.upsertUserKeys).mock.calls[0][2];
    expect(calledKeys.openai).toBeUndefined();
    expect(calledKeys.brave).toBe("br-old");
  });
});

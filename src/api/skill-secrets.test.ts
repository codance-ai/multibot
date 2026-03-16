import { describe, it, expect, vi } from "vitest";
import {
  handleListSkillSecrets,
  handleSetSkillSecret,
  handleDeleteSkillSecret,
} from "./skill-secrets";
import type { Env } from "../config/schema";
import * as configDb from "../db/config";

vi.mock("../db/config", () => ({
  getSkillSecrets: vi.fn(),
  upsertSkillSecret: vi.fn(),
  deleteSkillSecret: vi.fn(),
}));

const OWNER_ID = "test-owner";

function makeEnv(): Env {
  return { D1_DB: {} } as unknown as Env;
}

function makeRequest(
  method: string,
  body?: unknown,
): Request {
  return new Request("https://example.com/api/skill-secrets/weather", {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
}

describe("handleListSkillSecrets", () => {
  it("returns masked values", async () => {
    vi.mocked(configDb.getSkillSecrets).mockResolvedValue({
      weather: { WEATHER_API_KEY: "abcdefghijk" },
    });

    const res = await handleListSkillSecrets(
      makeRequest("GET"),
      makeEnv(),
      { ownerId: OWNER_ID },
    );
    expect(res.status).toBe(200);
    const data = await res.json() as Record<string, Record<string, string>>;
    expect(data.weather.WEATHER_API_KEY).toBe("abcd...ijk");
  });

  it("masks short values with ***", async () => {
    vi.mocked(configDb.getSkillSecrets).mockResolvedValue({
      weather: { SHORT: "abc" },
    });

    const res = await handleListSkillSecrets(
      makeRequest("GET"),
      makeEnv(),
      { ownerId: OWNER_ID },
    );
    const data = await res.json() as Record<string, Record<string, string>>;
    expect(data.weather.SHORT).toBe("***");
  });
});

describe("handleSetSkillSecret", () => {
  it("merges new values with existing secrets", async () => {
    vi.mocked(configDb.getSkillSecrets).mockResolvedValue({
      weather: { EXISTING_KEY: "old-value" },
    });
    vi.mocked(configDb.upsertSkillSecret).mockResolvedValue();

    const res = await handleSetSkillSecret(
      makeRequest("PUT", { NEW_KEY: "new-value" }),
      makeEnv(),
      { ownerId: OWNER_ID, skillName: "weather" },
    );
    expect(res.status).toBe(200);
    expect(configDb.upsertSkillSecret).toHaveBeenCalledWith(
      expect.anything(),
      OWNER_ID,
      "weather",
      { EXISTING_KEY: "old-value", NEW_KEY: "new-value" },
    );
  });

  it("removes keys when value is null", async () => {
    vi.mocked(configDb.getSkillSecrets).mockResolvedValue({
      weather: { KEY_A: "val-a", KEY_B: "val-b" },
    });
    vi.mocked(configDb.upsertSkillSecret).mockResolvedValue();

    const res = await handleSetSkillSecret(
      makeRequest("PUT", { KEY_A: null }),
      makeEnv(),
      { ownerId: OWNER_ID, skillName: "weather" },
    );
    expect(res.status).toBe(200);
    expect(configDb.upsertSkillSecret).toHaveBeenCalledWith(
      expect.anything(),
      OWNER_ID,
      "weather",
      { KEY_B: "val-b" },
    );
  });

  it("deletes entire skill secret when all keys removed", async () => {
    vi.mocked(configDb.getSkillSecrets).mockResolvedValue({
      weather: { KEY_A: "val-a" },
    });
    vi.mocked(configDb.deleteSkillSecret).mockResolvedValue();

    const res = await handleSetSkillSecret(
      makeRequest("PUT", { KEY_A: null }),
      makeEnv(),
      { ownerId: OWNER_ID, skillName: "weather" },
    );
    expect(res.status).toBe(200);
    expect(configDb.deleteSkillSecret).toHaveBeenCalledWith(
      expect.anything(),
      OWNER_ID,
      "weather",
    );
  });

  it("rejects invalid JSON body", async () => {
    const res = await handleSetSkillSecret(
      new Request("https://example.com/api/skill-secrets/weather", {
        method: "PUT",
        body: "not-json",
      }),
      makeEnv(),
      { ownerId: OWNER_ID, skillName: "weather" },
    );
    expect(res.status).toBe(400);
  });

  it("rejects empty string values", async () => {
    const res = await handleSetSkillSecret(
      makeRequest("PUT", { KEY: "" }),
      makeEnv(),
      { ownerId: OWNER_ID, skillName: "weather" },
    );
    expect(res.status).toBe(400);
  });

  it("rejects array body", async () => {
    const res = await handleSetSkillSecret(
      makeRequest("PUT", ["a", "b"]),
      makeEnv(),
      { ownerId: OWNER_ID, skillName: "weather" },
    );
    expect(res.status).toBe(400);
  });
});

describe("handleDeleteSkillSecret", () => {
  it("deletes secrets for a skill", async () => {
    vi.mocked(configDb.deleteSkillSecret).mockResolvedValue();

    const res = await handleDeleteSkillSecret(
      makeRequest("DELETE"),
      makeEnv(),
      { ownerId: OWNER_ID, skillName: "weather" },
    );
    expect(res.status).toBe(200);
    expect(configDb.deleteSkillSecret).toHaveBeenCalledWith(
      expect.anything(),
      OWNER_ID,
      "weather",
    );
  });

  it("decodes URL-encoded skill name", async () => {
    vi.mocked(configDb.deleteSkillSecret).mockResolvedValue();

    const res = await handleDeleteSkillSecret(
      makeRequest("DELETE"),
      makeEnv(),
      { ownerId: OWNER_ID, skillName: "my%2Ftool" },
    );
    expect(res.status).toBe(200);
    expect(configDb.deleteSkillSecret).toHaveBeenCalledWith(
      expect.anything(),
      OWNER_ID,
      "my/tool",
    );
  });
});

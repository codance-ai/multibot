import { describe, it, expect, vi } from "vitest";
import { handleListSkills, handleDeleteSkill } from "./skills";
import type { Env } from "../config/schema";

function createMockD1(
  rows: Array<{ name: string; description: string; emoji: string | null; path: string }> = [],
): D1Database {
  let storedRows = [...rows];
  return {
    prepare: vi.fn((sql: string) => ({
      bind: vi.fn((...args: unknown[]) => ({
        all: vi.fn(async () => ({ results: storedRows })),
        run: vi.fn(async () => {
          if (sql.startsWith("DELETE")) {
            const name = sql.includes("bot_id") ? args[1] as string : args[0] as string;
            const before = storedRows.length;
            storedRows = storedRows.filter((r) => r.name !== name);
            return { meta: { changes: before - storedRows.length } };
          }
          return { meta: { changes: 0 } };
        }),
      })),
      all: vi.fn(async () => ({ results: storedRows })),
    })),
  } as unknown as D1Database;
}

const OWNER_ID = "test-owner";

function makeEnv(d1Rows: Array<{ name: string; description: string; emoji: string | null; path: string }> = []): Env {
  return {
    D1_DB: createMockD1(d1Rows),
  } as Env;
}

function makeRequest(method: string): Request {
  return new Request("https://example.com/api/skills", { method });
}

describe("handleListSkills", () => {
  it("returns builtin skills with source=bundled", async () => {
    const env = makeEnv();
    const res = await handleListSkills(makeRequest("GET"), env, {
      ownerId: OWNER_ID,
    });
    expect(res.status).toBe(200);
    const data: any[] = await res.json();

    // Should have all 5 builtins (clawhub removed, browse migrated to native tool, system-reference added)
    expect(data.length).toBe(5);

    const memory = data.find((s: any) => s.name === "memory");
    expect(memory).toBeUndefined();

    const weather = data.find((s: any) => s.name === "weather");
    expect(weather).toBeDefined();
    expect(weather.source).toBe("bundled");
    expect(weather.emoji).toBeDefined();

    // All should be bundled
    for (const skill of data) {
      expect(skill.source).toBe("bundled");
    }
  });

  it("includes installed skills from D1 with source=installed", async () => {
    const env = makeEnv([
      { name: "my-tool", description: "A custom skill", emoji: null, path: "/installed-skills/my-tool/SKILL.md" },
    ]);

    const res = await handleListSkills(makeRequest("GET"), env, {
      ownerId: OWNER_ID,
    });
    expect(res.status).toBe(200);
    const data: any[] = await res.json();

    const custom = data.find((s: any) => s.name === "my-tool");
    expect(custom).toBeDefined();
    expect(custom.source).toBe("installed");
    expect(custom.description).toBe("A custom skill");
    expect(custom.available).toBe(true);
  });

  it("installed skill with same name as bundled is skipped", async () => {
    const env = makeEnv([
      { name: "weather", description: "My custom weather", emoji: null, path: "/installed-skills/weather/SKILL.md" },
    ]);

    const res = await handleListSkills(makeRequest("GET"), env, {
      ownerId: OWNER_ID,
    });
    expect(res.status).toBe(200);
    const data: any[] = await res.json();

    // Bundled takes priority, installed is skipped
    const weathers = data.filter((s: any) => s.name === "weather");
    expect(weathers).toHaveLength(1);
    expect(weathers[0].source).toBe("bundled");
  });
});

describe("handleDeleteSkill", () => {
  it("returns 400 when trying to delete a builtin skill", async () => {
    const env = makeEnv();
    const res = await handleDeleteSkill(makeRequest("DELETE"), env, {
      ownerId: OWNER_ID,
      skillName: "weather",
    });
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error).toMatch(/builtin/i);
  });

  it("returns 404 when skill not found in D1", async () => {
    const env = makeEnv();
    const res = await handleDeleteSkill(makeRequest("DELETE"), env, {
      ownerId: OWNER_ID,
      skillName: "nonexistent",
    });
    expect(res.status).toBe(404);
    const data: any = await res.json();
    expect(data.error).toMatch(/not found/i);
  });

  it("deletes an installed skill from D1", async () => {
    const env = makeEnv([
      { name: "my-tool", description: "A custom skill", emoji: null, path: "/installed-skills/my-tool/SKILL.md" },
    ]);

    const res = await handleDeleteSkill(makeRequest("DELETE"), env, {
      ownerId: OWNER_ID,
      skillName: "my-tool",
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.deleted).toBe(true);
  });

  it("handles URL-encoded skill name", async () => {
    const env = makeEnv([
      { name: "my-tool", description: "A custom skill", emoji: null, path: "/installed-skills/my-tool/SKILL.md" },
    ]);
    const res = await handleDeleteSkill(makeRequest("DELETE"), env, {
      ownerId: OWNER_ID,
      skillName: "my%2Dtool",  // URL-encoded my-tool
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.deleted).toBe(true);
  });
});

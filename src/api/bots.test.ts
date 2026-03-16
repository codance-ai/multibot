import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleListBots,
  handleCreateBot,
  handleGetBot,
  handleUpdateBot,
  handleDeleteBot,
  handleRestoreBot,
} from "./bots";
import type { Env, BotConfig } from "../config/schema";

// -- Mock configDb module --

vi.mock("../db/config", () => ({
  getBot: vi.fn(),
  listBots: vi.fn(),
  upsertBot: vi.fn(),
  softDeleteBot: vi.fn(),
  restoreBot: vi.fn(),
  deleteBotPermanently: vi.fn(),
  deleteTokenMapping: vi.fn(),
  deleteTokenMappingsForBot: vi.fn(),
  getTokenMapping: vi.fn(),
  upsertTokenMapping: vi.fn(),
}));

// -- Mock d1 module (deleteBotData) --

vi.mock("../db/d1", () => ({
  deleteBotData: vi.fn(),
}));

import * as configDb from "../db/config";
import { deleteBotData } from "../db/d1";

// -- Mock Discord Gateway DO --

function createMockDiscordGateway() {
  const shutdownFn = vi.fn(async () => {});
  const stub = { shutdown: shutdownFn } as any;
  const ns = {
    idFromName: vi.fn(() => "mock-do-id"),
    get: vi.fn(() => stub),
  } as unknown as Env["DISCORD_GATEWAY"];
  return { ns, shutdownFn };
}

// -- Helpers --

const OWNER_ID = "test-owner";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DISCORD_GATEWAY: createMockDiscordGateway().ns,
    D1_DB: {} as D1Database, // configDb is mocked, so D1_DB is unused
    ...overrides,
  } as Env;
}

function jsonRequest(method: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request("https://example.com/api/bots", init);
}

function validBotBody(): Record<string, unknown> {
  return {
    name: "TestBot",
    soul: "",
    agents: "",
    user: "",
    tools: "",
    identity: "",
    provider: "openai",
    model: "gpt-4o",
  };
}

function makeBotConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    botId: "bot-1",
    ownerId: OWNER_ID,
    name: "TestBot",
    soul: "",
    agents: "",
    user: "",
    tools: "",
    identity: "",
    provider: "openai",
    model: "gpt-4o",
    channels: {},
    enabledSkills: [],
    maxIterations: 10,
    memoryWindow: 50,
    contextWindow: 128000,
    mcpServers: {},
    botType: "normal",
    allowedSenderIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

// -- Tests --

describe("handleListBots", () => {
  it("returns empty array when no bots exist", async () => {
    vi.mocked(configDb.listBots).mockResolvedValueOnce([]);
    const env = makeEnv();
    const res = await handleListBots(jsonRequest("GET"), env, { ownerId: OWNER_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
    expect(configDb.listBots).toHaveBeenCalledWith(env.D1_DB, OWNER_ID);
  });

  it("returns all bots", async () => {
    const bot = makeBotConfig();
    vi.mocked(configDb.listBots).mockResolvedValueOnce([bot]);
    const env = makeEnv();

    const res = await handleListBots(jsonRequest("GET"), env, { ownerId: OWNER_ID });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toHaveLength(1);
    expect((data as any[])[0].botId).toBe("bot-1");
  });

  it("returns multiple bots", async () => {
    const bot1 = makeBotConfig();
    const bot2 = makeBotConfig({ botId: "bot-2", name: "Bot2" });
    vi.mocked(configDb.listBots).mockResolvedValueOnce([bot1, bot2]);
    const env = makeEnv();

    const res = await handleListBots(jsonRequest("GET"), env, { ownerId: OWNER_ID });
    expect(res.status).toBe(200);
    const data: any[] = await res.json();
    expect(data).toHaveLength(2);
    expect(data.map((b) => b.botId).sort()).toEqual(["bot-1", "bot-2"]);
  });
});

describe("handleCreateBot", () => {
  it("returns 400 for invalid JSON", async () => {
    const env = makeEnv();
    const req = new Request("https://example.com/api/bots", {
      method: "POST",
      body: "not json",
    });
    const res = await handleCreateBot(req, env, { ownerId: OWNER_ID });
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error).toContain("Invalid JSON");
  });

  it("returns 400 for schema validation failure", async () => {
    const env = makeEnv();
    const res = await handleCreateBot(
      jsonRequest("POST", { name: "Bot" }), // missing required fields
      env,
      { ownerId: OWNER_ID }
    );
    expect(res.status).toBe(400);
  });

  it("creates a bot and returns 201", async () => {
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    const env = makeEnv();
    const res = await handleCreateBot(
      jsonRequest("POST", validBotBody()),
      env,
      { ownerId: OWNER_ID }
    );
    expect(res.status).toBe(201);
    const data: any = await res.json();
    expect(data.botId).toBeDefined();
    expect(data.ownerId).toBe(OWNER_ID);
    expect(data.name).toBe("TestBot");

    // Verify upsertBot was called
    expect(configDb.upsertBot).toHaveBeenCalledOnce();
    const calledWith = vi.mocked(configDb.upsertBot).mock.calls[0];
    expect(calledWith[1].botId).toBe(data.botId);
    expect(calledWith[1].ownerId).toBe(OWNER_ID);
  });

  it("stores botType as 'normal' by default and allowedSenderIds as []", async () => {
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    const env = makeEnv();
    const res = await handleCreateBot(
      jsonRequest("POST", validBotBody()),
      env,
      { ownerId: OWNER_ID }
    );
    expect(res.status).toBe(201);
    const data: any = await res.json();
    expect(data.botType).toBe("normal");
    expect(data.allowedSenderIds).toEqual([]);

    // Verify the config passed to upsertBot
    const calledWith = vi.mocked(configDb.upsertBot).mock.calls[0][1];
    expect(calledWith.botType).toBe("normal");
    expect(calledWith.allowedSenderIds).toEqual([]);
  });
});

describe("handleGetBot", () => {
  it("returns 404 for non-existent bot", async () => {
    vi.mocked(configDb.getBot).mockResolvedValueOnce(null);
    const env = makeEnv();
    const res = await handleGetBot(jsonRequest("GET"), env, {
      ownerId: OWNER_ID, botId: "nope",
    });
    expect(res.status).toBe(404);
  });

  it("returns the bot config", async () => {
    const bot = makeBotConfig();
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    const env = makeEnv();

    const res = await handleGetBot(jsonRequest("GET"), env, {
      ownerId: OWNER_ID, botId: "bot-1",
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.botId).toBe("bot-1");
    expect(data.name).toBe("TestBot");
  });
});

describe("handleUpdateBot", () => {
  it("returns 404 for non-existent bot", async () => {
    vi.mocked(configDb.getBot).mockResolvedValueOnce(null);
    const env = makeEnv();
    const res = await handleUpdateBot(
      jsonRequest("PUT", { name: "NewName" }),
      env,
      { ownerId: OWNER_ID, botId: "nope" }
    );
    expect(res.status).toBe(404);
  });

  it("merges partial update", async () => {
    const bot = makeBotConfig();
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    const env = makeEnv();

    const res = await handleUpdateBot(
      jsonRequest("PUT", { name: "Updated", model: "gpt-4o-mini" }),
      env,
      { ownerId: OWNER_ID, botId: "bot-1" }
    );
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.name).toBe("Updated");
    expect(data.model).toBe("gpt-4o-mini");
    expect(data.soul).toBe(""); // unchanged

    // Verify upsertBot was called with merged config
    expect(configDb.upsertBot).toHaveBeenCalledOnce();
    const calledWith = vi.mocked(configDb.upsertBot).mock.calls[0][1];
    expect(calledWith.name).toBe("Updated");
    expect(calledWith.model).toBe("gpt-4o-mini");
  });

  it("does not allow overwriting botId or ownerId", async () => {
    const bot = makeBotConfig();
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    const env = makeEnv();

    const res = await handleUpdateBot(
      jsonRequest("PUT", { name: "Hacked" }),
      env,
      { ownerId: OWNER_ID, botId: "bot-1" }
    );
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.botId).toBe("bot-1");
    expect(data.ownerId).toBe(OWNER_ID);
  });

  it("preserves botType from existing config (immutable via API update)", async () => {
    const bot = makeBotConfig({ botType: "admin", allowedSenderIds: ["user-1"] });
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    const env = makeEnv();

    const res = await handleUpdateBot(
      jsonRequest("PUT", { name: "Updated" }),
      env,
      { ownerId: OWNER_ID, botId: "bot-1" }
    );
    expect(res.status).toBe(200);
    const data: any = await res.json();
    // botType should remain "admin" — not overwritten by update payload
    expect(data.botType).toBe("admin");
    expect(data.allowedSenderIds).toEqual(["user-1"]);

    // Verify upsertBot received the preserved botType
    const calledWith = vi.mocked(configDb.upsertBot).mock.calls[0][1];
    expect(calledWith.botType).toBe("admin");
    expect(calledWith.allowedSenderIds).toEqual(["user-1"]);
  });
});

describe("handleDeleteBot", { timeout: 15_000 }, () => {
  it("returns 404 for non-existent bot", async () => {
    vi.mocked(configDb.getBot).mockResolvedValueOnce(null);
    const env = makeEnv();
    const res = await handleDeleteBot(jsonRequest("DELETE"), env, {
      ownerId: OWNER_ID, botId: "nope",
    });
    expect(res.status).toBe(404);
  });

  it("returns 403 when trying to delete admin bot", async () => {
    const adminBot = makeBotConfig({ botType: "admin" });
    vi.mocked(configDb.getBot).mockResolvedValueOnce(adminBot);
    const env = makeEnv();

    const res = await handleDeleteBot(jsonRequest("DELETE"), env, {
      ownerId: OWNER_ID, botId: "bot-1",
    });
    expect(res.status).toBe(403);
    const data: any = await res.json();
    expect(data.error).toContain("Cannot delete admin bot");

    // softDeleteBot should NOT have been called
    expect(configDb.softDeleteBot).not.toHaveBeenCalled();
  });

  it("deletes bot and cleans up", async () => {
    const bot = makeBotConfig();
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    vi.mocked(configDb.softDeleteBot).mockResolvedValueOnce(undefined);
    vi.mocked(deleteBotData).mockResolvedValueOnce(undefined);
    const env = makeEnv();

    const res = await handleDeleteBot(jsonRequest("DELETE"), env, {
      ownerId: OWNER_ID, botId: "bot-1",
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.deleted).toBe(true);

    // softDeleteBot should have been called with ownerId
    expect(configDb.softDeleteBot).toHaveBeenCalledWith(env.D1_DB, OWNER_ID, "bot-1");
  });

  it("bulk deletes token mappings for bot", async () => {
    const bot = makeBotConfig({
      channels: {
        telegram: { token: "tg-tok" },
        slack: { token: "sl-tok" },
      },
    });
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    vi.mocked(configDb.deleteTokenMappingsForBot).mockResolvedValue(undefined);
    vi.mocked(configDb.softDeleteBot).mockResolvedValueOnce(undefined);
    vi.mocked(deleteBotData).mockResolvedValueOnce(undefined);
    const env = makeEnv();

    const res = await handleDeleteBot(jsonRequest("DELETE"), env, {
      ownerId: OWNER_ID, botId: "bot-1",
    });
    expect(res.status).toBe(200);

    expect(configDb.deleteTokenMappingsForBot).toHaveBeenCalledWith(env.D1_DB, OWNER_ID, "bot-1");
  });

  it("calls Discord gateway shutdown", async () => {
    const { ns: discordNs, shutdownFn } = createMockDiscordGateway();
    const bot = makeBotConfig({
      channels: { discord: { token: "dc-tok" } },
    });
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    vi.mocked(configDb.deleteTokenMappingsForBot).mockResolvedValue(undefined);
    vi.mocked(configDb.softDeleteBot).mockResolvedValueOnce(undefined);
    vi.mocked(deleteBotData).mockResolvedValueOnce(undefined);
    const env = makeEnv({ DISCORD_GATEWAY: discordNs });

    const res = await handleDeleteBot(jsonRequest("DELETE"), env, {
      ownerId: OWNER_ID, botId: "bot-1",
    });
    expect(res.status).toBe(200);
    expect(shutdownFn).toHaveBeenCalledOnce();
  });

  it("returns warnings when cascade steps fail", async () => {
    const bot = makeBotConfig({
      channels: { discord: { token: "dc-tok" } },
    });
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    vi.mocked(configDb.deleteTokenMappingsForBot).mockResolvedValue(undefined);
    vi.mocked(configDb.softDeleteBot).mockResolvedValueOnce(undefined);
    vi.mocked(deleteBotData).mockResolvedValueOnce(undefined);

    // Make Discord gateway throw
    const badNs = {
      idFromName: vi.fn(() => "id"),
      get: vi.fn(() => ({
        shutdown: vi.fn(async () => {
          throw new Error("DO unavailable");
        }),
      })),
    } as unknown as Env["DISCORD_GATEWAY"];
    const env = makeEnv({ DISCORD_GATEWAY: badNs });

    const res = await handleDeleteBot(jsonRequest("DELETE"), env, {
      ownerId: OWNER_ID, botId: "bot-1",
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.deleted).toBe(true);
    expect(data.warnings).toBeDefined();
    expect(data.warnings.length).toBeGreaterThan(0);
    expect(data.warnings[0]).toContain("discord");
  });

});

describe("handleRestoreBot", () => {
  it("returns 404 when no restorable bot exists", async () => {
    vi.mocked(configDb.getBot).mockResolvedValueOnce(null);
    vi.mocked(configDb.restoreBot).mockResolvedValueOnce(null);
    const env = makeEnv();
    const res = await handleRestoreBot(jsonRequest("POST"), env, {
      ownerId: OWNER_ID, botId: "bot-999",
    });
    expect(res.status).toBe(404);
  });

  it("returns 409 when bot is not deleted", async () => {
    vi.mocked(configDb.getBot).mockResolvedValueOnce(makeBotConfig());
    const env = makeEnv();

    const res = await handleRestoreBot(jsonRequest("POST"), env, {
      ownerId: OWNER_ID, botId: "bot-1",
    });
    expect(res.status).toBe(409);
  });

  it("restores a deleted bot", async () => {
    const bot = makeBotConfig({
      channels: { telegram: { token: "tg-tok" } },
    });
    // getBot returns null (bot is soft-deleted)
    vi.mocked(configDb.getBot).mockResolvedValueOnce(null);
    // restoreBot returns the restored config
    vi.mocked(configDb.restoreBot).mockResolvedValueOnce(bot);
    // getTokenMapping returns null (no conflict)
    vi.mocked(configDb.getTokenMapping).mockResolvedValue(null);
    vi.mocked(configDb.upsertTokenMapping).mockResolvedValue(undefined);
    const env = makeEnv();

    const res = await handleRestoreBot(jsonRequest("POST"), env, {
      ownerId: OWNER_ID, botId: "bot-1",
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.botId).toBe("bot-1");

    // Token mapping should be recreated via D1
    expect(configDb.upsertTokenMapping).toHaveBeenCalledWith(
      env.D1_DB, "telegram", "tg-tok",
      { ownerId: OWNER_ID, botId: "bot-1" }
    );
  });
});

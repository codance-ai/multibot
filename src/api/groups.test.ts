import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  handleListGroups,
  handleCreateGroup,
  handleGetGroup,
  handleUpdateGroup,
  handleDeleteGroup,
} from "./groups";
import type { Env, GroupConfig, BotConfig } from "../config/schema";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// -- Mock configDb module --

vi.mock("../db/config", () => ({
  getBot: vi.fn(),
  listGroups: vi.fn(),
  getGroup: vi.fn(),
  upsertGroup: vi.fn(),
  deleteGroup: vi.fn(),
}));

import * as configDb from "../db/config";

beforeEach(() => {
  vi.clearAllMocks();
});

// -- Helpers --

const OWNER_ID = "test-owner";

function makeEnv(): Env {
  return {
    D1_DB: {} as D1Database,
  } as Env;
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

function makeGroupConfig(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    groupId: "group-1",
    ownerId: OWNER_ID,
    name: "TestGroup",
    botIds: ["bot-1", "bot-2"],
    note: "",
    orchestratorProvider: "anthropic",
    orchestratorModel: "claude-sonnet-4-6",
    ...overrides,
  };
}

function jsonRequest(method: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request("https://example.com/api/groups", init);
}

// -- handleListGroups --

describe("handleListGroups", () => {
  it("returns empty array when no groups exist", async () => {
    vi.mocked(configDb.listGroups).mockResolvedValueOnce([]);
    const env = makeEnv();
    const res = await handleListGroups(jsonRequest("GET"), env, { ownerId: OWNER_ID });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it("returns groups with available channels", async () => {
    const group = makeGroupConfig();
    vi.mocked(configDb.listGroups).mockResolvedValueOnce([group]);
    // loadBotConfigs will call getBot for each botId
    vi.mocked(configDb.getBot)
      .mockResolvedValueOnce(makeBotConfig({ channels: { telegram: { token: "t" } } }))
      .mockResolvedValueOnce(makeBotConfig({ botId: "bot-2", channels: { slack: { token: "s" } } }));
    const env = makeEnv();

    const res = await handleListGroups(jsonRequest("GET"), env, { ownerId: OWNER_ID });
    expect(res.status).toBe(200);
    const data: any[] = await res.json();
    expect(data).toHaveLength(1);
    expect(data[0].groupId).toBe("group-1");
    expect(data[0].availableChannels).toEqual(["slack", "telegram"]);
  });
});

// -- handleCreateGroup --

describe("handleCreateGroup", () => {
  it("returns 400 for invalid JSON", async () => {
    const env = makeEnv();
    const req = new Request("https://example.com/api/groups", {
      method: "POST",
      body: "not json",
    });
    const res = await handleCreateGroup(req, env, { ownerId: OWNER_ID });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing required fields", async () => {
    const env = makeEnv();
    const res = await handleCreateGroup(
      jsonRequest("POST", { name: "Group" }), // missing botIds
      env,
      { ownerId: OWNER_ID }
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when creating group with admin bot", async () => {
    vi.mocked(configDb.getBot).mockResolvedValueOnce(
      makeBotConfig({ botId: "admin-bot", botType: "admin" })
    );
    const env = makeEnv();

    const res = await handleCreateGroup(
      jsonRequest("POST", { name: "G", botIds: ["admin-bot"] }),
      env,
      { ownerId: OWNER_ID }
    );
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error).toContain("Cannot add admin bot");

    // upsertGroup should NOT have been called
    expect(configDb.upsertGroup).not.toHaveBeenCalled();
  });

  it("returns 404 when creating group with non-existent bot", async () => {
    vi.mocked(configDb.getBot).mockResolvedValueOnce(null);
    const env = makeEnv();

    const res = await handleCreateGroup(
      jsonRequest("POST", { name: "G", botIds: ["missing-bot"] }),
      env,
      { ownerId: OWNER_ID }
    );
    expect(res.status).toBe(404);
    const data: any = await res.json();
    expect(data.error).toContain("not found");

    expect(configDb.upsertGroup).not.toHaveBeenCalled();
  });

  it("creates a group and returns 201", async () => {
    vi.mocked(configDb.upsertGroup).mockResolvedValueOnce(undefined);
    // 2 calls for admin bot validation + 2 calls for loadBotConfigs
    vi.mocked(configDb.getBot)
      .mockResolvedValueOnce(makeBotConfig())
      .mockResolvedValueOnce(makeBotConfig({ botId: "bot-2" }))
      .mockResolvedValueOnce(makeBotConfig())
      .mockResolvedValueOnce(makeBotConfig({ botId: "bot-2" }));
    const env = makeEnv();

    const res = await handleCreateGroup(
      jsonRequest("POST", { name: "MyGroup", botIds: ["bot-1", "bot-2"] }),
      env,
      { ownerId: OWNER_ID }
    );
    expect(res.status).toBe(201);
    const data: any = await res.json();
    expect(data.groupId).toBeDefined();
    expect(data.name).toBe("MyGroup");
    expect(data.ownerId).toBe(OWNER_ID);
    expect(data.botIds).toEqual(["bot-1", "bot-2"]);

    // Verify upsertGroup was called
    expect(configDb.upsertGroup).toHaveBeenCalledOnce();
  });

  it("returns privacy mode warning for telegram bots", async () => {
    vi.mocked(configDb.upsertGroup).mockResolvedValueOnce(undefined);
    const tgBot = makeBotConfig({ channels: { telegram: { token: "tg-tok" } } });
    // 1 call for admin bot validation + 1 call for loadBotConfigs
    vi.mocked(configDb.getBot)
      .mockResolvedValueOnce(tgBot)
      .mockResolvedValueOnce(tgBot);
    // getMe returns no group reading permission
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: true, result: { can_read_all_group_messages: false } }),
    });
    const env = makeEnv();

    const res = await handleCreateGroup(
      jsonRequest("POST", { name: "G", botIds: ["bot-1"] }),
      env,
      { ownerId: OWNER_ID }
    );
    expect(res.status).toBe(201);
    const data: any = await res.json();
    expect(data.warnings).toBeDefined();
    expect(data.warnings[0]).toContain("Privacy Mode");
  });
});

// -- handleGetGroup --

describe("handleGetGroup", () => {
  it("returns 404 for non-existent group", async () => {
    vi.mocked(configDb.getGroup).mockResolvedValueOnce(null);
    const env = makeEnv();
    const res = await handleGetGroup(jsonRequest("GET"), env, {
      ownerId: OWNER_ID, groupId: "nope",
    });
    expect(res.status).toBe(404);
  });

  it("returns group with available channels", async () => {
    const group = makeGroupConfig();
    vi.mocked(configDb.getGroup).mockResolvedValueOnce(group);
    vi.mocked(configDb.getBot)
      .mockResolvedValueOnce(makeBotConfig({ channels: { discord: { token: "d" } } }))
      .mockResolvedValueOnce(null); // bot-2 missing
    const env = makeEnv();

    const res = await handleGetGroup(jsonRequest("GET"), env, {
      ownerId: OWNER_ID, groupId: "group-1",
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.groupId).toBe("group-1");
    expect(data.availableChannels).toEqual(["discord"]);
  });
});

// -- handleUpdateGroup --

describe("handleUpdateGroup", () => {
  it("returns 404 for non-existent group", async () => {
    vi.mocked(configDb.getGroup).mockResolvedValueOnce(null);
    const env = makeEnv();
    const res = await handleUpdateGroup(
      jsonRequest("PUT", { name: "NewName" }),
      env,
      { ownerId: OWNER_ID, groupId: "nope" }
    );
    expect(res.status).toBe(404);
  });

  it("merges partial update", async () => {
    const group = makeGroupConfig();
    vi.mocked(configDb.getGroup).mockResolvedValueOnce(group);
    vi.mocked(configDb.upsertGroup).mockResolvedValueOnce(undefined);
    vi.mocked(configDb.getBot)
      .mockResolvedValueOnce(makeBotConfig())
      .mockResolvedValueOnce(makeBotConfig({ botId: "bot-2" }));
    const env = makeEnv();

    const res = await handleUpdateGroup(
      jsonRequest("PUT", { name: "Updated" }),
      env,
      { ownerId: OWNER_ID, groupId: "group-1" }
    );
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.name).toBe("Updated");
    expect(data.botIds).toEqual(["bot-1", "bot-2"]); // unchanged

    // Verify upsertGroup was called
    expect(configDb.upsertGroup).toHaveBeenCalledOnce();
    const calledWith = vi.mocked(configDb.upsertGroup).mock.calls[0][1];
    expect(calledWith.name).toBe("Updated");
    expect(calledWith.groupId).toBe("group-1"); // immutable
    expect(calledWith.ownerId).toBe(OWNER_ID); // immutable
  });

  it("returns 400 when updating group to include admin bot", async () => {
    const group = makeGroupConfig();
    vi.mocked(configDb.getGroup).mockResolvedValueOnce(group);
    vi.mocked(configDb.getBot).mockResolvedValueOnce(
      makeBotConfig({ botId: "admin-bot", botType: "admin" })
    );
    const env = makeEnv();

    const res = await handleUpdateGroup(
      jsonRequest("PUT", { botIds: ["admin-bot"] }),
      env,
      { ownerId: OWNER_ID, groupId: "group-1" }
    );
    expect(res.status).toBe(400);
    const data: any = await res.json();
    expect(data.error).toContain("Cannot add admin bot");

    // upsertGroup should NOT have been called
    expect(configDb.upsertGroup).not.toHaveBeenCalled();
  });

  it("returns 404 when updating group with non-existent bot", async () => {
    const group = makeGroupConfig();
    vi.mocked(configDb.getGroup).mockResolvedValueOnce(group);
    vi.mocked(configDb.getBot).mockResolvedValueOnce(null);
    const env = makeEnv();

    const res = await handleUpdateGroup(
      jsonRequest("PUT", { botIds: ["missing-bot"] }),
      env,
      { ownerId: OWNER_ID, groupId: "group-1" }
    );
    expect(res.status).toBe(404);
    const data: any = await res.json();
    expect(data.error).toContain("not found");

    expect(configDb.upsertGroup).not.toHaveBeenCalled();
  });
});

// -- handleDeleteGroup --

describe("handleDeleteGroup", () => {
  it("returns 404 for non-existent group", async () => {
    vi.mocked(configDb.getGroup).mockResolvedValueOnce(null);
    const env = makeEnv();
    const res = await handleDeleteGroup(jsonRequest("DELETE"), env, {
      ownerId: OWNER_ID, groupId: "nope",
    });
    expect(res.status).toBe(404);
  });

  it("deletes a group", async () => {
    vi.mocked(configDb.getGroup).mockResolvedValueOnce(makeGroupConfig());
    vi.mocked(configDb.deleteGroup).mockResolvedValueOnce(undefined);
    const env = makeEnv();

    const res = await handleDeleteGroup(jsonRequest("DELETE"), env, {
      ownerId: OWNER_ID, groupId: "group-1",
    });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.deleted).toBe(true);

    expect(configDb.deleteGroup).toHaveBeenCalledWith(env.D1_DB, OWNER_ID, "group-1");
  });
});

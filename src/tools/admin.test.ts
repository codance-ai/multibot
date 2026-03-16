import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAdminTools } from "./admin";
import type { Env, BotConfig, UserKeys, GroupConfig } from "../config/schema";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../db/config", () => ({
  listBots: vi.fn(),
  getBot: vi.fn(),
  upsertBot: vi.fn(),
  softDeleteBot: vi.fn(),
  restoreBot: vi.fn(),
  listGroups: vi.fn(),
  getGroup: vi.fn(),
  upsertGroup: vi.fn(),
  deleteGroup: vi.fn(),
  getUserKeys: vi.fn(),
  upsertUserKeys: vi.fn(),
  upsertTokenMapping: vi.fn(),
  deleteTokenMapping: vi.fn(),
  deleteTokenMappingsForBot: vi.fn(),
  getSkillSecrets: vi.fn(),
  upsertSkillSecret: vi.fn(),
}));

vi.mock("../skills/loader", () => ({
  listAllSkills: vi.fn(),
}));

vi.mock("../skills/builtin", () => ({
  BUNDLED_SKILL_META: [
    { name: "memory", description: "Memory skill", path: "/skills/memory/SKILL.md" },
    { name: "weather", description: "Weather skill", path: "/skills/weather/SKILL.md" },
  ],
  BUILTIN_SKILLS: {
    memory: "---\nname: memory\n---\n",
    weather: "---\nname: weather\n---\n",
  },
}));

vi.mock("../db/d1", () => ({
  getMemory: vi.fn(),
  upsertMemory: vi.fn(),
  getHistoryEntries: vi.fn(),
  insertHistoryEntry: vi.fn(),
}));

import * as configDb from "../db/config";
import { getMemory, upsertMemory, getHistoryEntries, insertHistoryEntry } from "../db/d1";
import { listAllSkills } from "../skills/loader";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OWNER_ID = "owner-1";

function makeMockEnv(): Env {
  return {
    D1_DB: {
      prepare: vi.fn(() => ({
        bind: vi.fn((..._args: unknown[]) => ({
          run: vi.fn(async () => ({ meta: { changes: 0 } })),
          all: vi.fn(async () => ({ results: [] })),
          first: vi.fn(async () => null),
        })),
      })),
    } as unknown as D1Database,
    MULTIBOT_AGENT: {} as any,
    SANDBOX: {} as any,
    DISCORD_GATEWAY: {} as any,
    WEBHOOK_SECRET: "test-secret",
    BASE_URL: "https://example.com",
    CHAT_COORDINATOR: {} as any,
  };
}

function makeBot(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    botId: "bot-1",
    name: "TestBot",
    ownerId: OWNER_ID,
    provider: "openai",
    model: "gpt-4",
    soul: "",
    agents: "",
    user: "",
    tools: "",
    identity: "",
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

/** Helper to execute a tool by name. */
async function exec(tools: ReturnType<typeof createAdminTools>, name: string, input: any = {}) {
  const t = tools[name] as any;
  return t.execute(input);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createAdminTools", () => {
  let env: Env;
  let tools: ReturnType<typeof createAdminTools>;

  beforeEach(() => {
    vi.clearAllMocks();
    env = makeMockEnv();
    tools = createAdminTools(env, OWNER_ID);
  });

  // -------------------------------------------------------------------------
  // list_bots
  // -------------------------------------------------------------------------

  describe("list_bots", () => {
    it("returns formatted list of bots", async () => {
      vi.mocked(configDb.listBots).mockResolvedValue([
        makeBot({ botId: "b1", name: "Alpha", provider: "openai", model: "gpt-4" }),
        makeBot({ botId: "b2", name: "Beta", provider: "anthropic", model: "claude-sonnet-4-6", botType: "admin" }),
      ]);

      const result = await exec(tools, "list_bots");
      expect(result).toContain("**Alpha**");
      expect(result).toContain("`b1`");
      expect(result).toContain("openai/gpt-4");
      expect(result).toContain("**Beta**");
      expect(result).toContain("type: admin");
    });

    it("handles empty list", async () => {
      vi.mocked(configDb.listBots).mockResolvedValue([]);
      const result = await exec(tools, "list_bots");
      expect(result).toBe("No bots found.");
    });
  });

  // -------------------------------------------------------------------------
  // get_bot
  // -------------------------------------------------------------------------

  describe("get_bot", () => {
    it("returns bot details as JSON", async () => {
      const bot = makeBot({ botId: "b1" });
      vi.mocked(configDb.getBot).mockResolvedValue(bot);

      const result = await exec(tools, "get_bot", { botId: "b1" });
      const parsed = JSON.parse(result);
      expect(parsed.botId).toBe("b1");
      expect(parsed.name).toBe("TestBot");
    });

    it("returns not found for missing bot", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(null);
      const result = await exec(tools, "get_bot", { botId: "missing" });
      expect(result).toContain("Bot not found");
    });
  });

  // -------------------------------------------------------------------------
  // create_bot
  // -------------------------------------------------------------------------

  describe("create_bot", () => {
    it("creates a bot with UUID and returns confirmation", async () => {
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      const result = await exec(tools, "create_bot", {
        name: "NewBot",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        soul: "You are helpful.",
      });

      expect(result).toContain("Bot created");
      expect(result).toContain("**NewBot**");
      // Verify upsertBot was called with UUID
      expect(configDb.upsertBot).toHaveBeenCalledWith(
        env.D1_DB,
        expect.objectContaining({
          name: "NewBot",
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          soul: "You are helpful.",
          botType: "normal",
          ownerId: OWNER_ID,
          botId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          ),
        }),
      );
    });

    it("rejects unknown skill names", async () => {
      vi.mocked(listAllSkills).mockResolvedValue([
        { name: "memory", type: "builtin", available: true },
      ] as Awaited<ReturnType<typeof listAllSkills>>);

      const result = await exec(tools, "create_bot", {
        name: "NewBot",
        provider: "openai",
        model: "gpt-4",
        enabledSkills: ["memory", "nonexistent"],
      });

      expect(result).toContain("Unknown skill(s)");
      expect(result).toContain("nonexistent");
      expect(configDb.upsertBot).not.toHaveBeenCalled();
    });

    it("creates a bot with default values when optionals omitted", async () => {
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      await exec(tools, "create_bot", {
        name: "MinBot",
        provider: "openai",
        model: "gpt-4",
      });

      expect(configDb.upsertBot).toHaveBeenCalledWith(
        env.D1_DB,
        expect.objectContaining({
          soul: "",
          agents: "",
          identity: "",
          enabledSkills: [],
          maxIterations: 10,
          memoryWindow: 50,
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // update_bot
  // -------------------------------------------------------------------------

  describe("update_bot", () => {
    it("preserves botId, ownerId, and botType as immutable", async () => {
      const existing = makeBot({
        botId: "b1",
        botType: "admin",
        ownerId: OWNER_ID,
      });
      vi.mocked(configDb.getBot).mockResolvedValue(existing);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      await exec(tools, "update_bot", {
        botId: "b1",
        name: "RenamedBot",
      });

      expect(configDb.upsertBot).toHaveBeenCalledWith(
        env.D1_DB,
        expect.objectContaining({
          botId: "b1",
          ownerId: OWNER_ID,
          botType: "admin",
          name: "RenamedBot",
        }),
      );
    });

    it("merges only provided fields", async () => {
      const existing = makeBot({
        botId: "b1",
        name: "OldName",
        soul: "Old soul",
        model: "gpt-3.5",
      });
      vi.mocked(configDb.getBot).mockResolvedValue(existing);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      await exec(tools, "update_bot", {
        botId: "b1",
        name: "NewName",
      });

      expect(configDb.upsertBot).toHaveBeenCalledWith(
        env.D1_DB,
        expect.objectContaining({
          name: "NewName",
          soul: "Old soul", // preserved
          model: "gpt-3.5", // preserved
        }),
      );
    });

    it("returns not found for missing bot", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(null);
      const result = await exec(tools, "update_bot", {
        botId: "missing",
        name: "Whatever",
      });
      expect(result).toContain("Bot not found");
    });

    it("ignores accidental empty values unless explicitly cleared", async () => {
      const existing = makeBot({
        botId: "b1",
        model: "gpt-4",
        soul: "Keep this",
        enabledSkills: ["memory"],
      });
      vi.mocked(configDb.getBot).mockResolvedValue(existing);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      await exec(tools, "update_bot", {
        botId: "b1",
        model: "gpt-5",
        soul: "",
        enabledSkills: [],
      });

      expect(configDb.upsertBot).toHaveBeenCalledWith(
        env.D1_DB,
        expect.objectContaining({
          model: "gpt-5",
          soul: "Keep this",
          enabledSkills: ["memory"],
        }),
      );
    });

    it("clears selected fields via clearFields", async () => {
      const existing = makeBot({
        botId: "b1",
        soul: "To be cleared",
        enabledSkills: ["memory"],
        baseUrl: "https://api.example.com",
      });
      vi.mocked(configDb.getBot).mockResolvedValue(existing);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      await exec(tools, "update_bot", {
        botId: "b1",
        clearFields: ["soul", "enabledSkills", "baseUrl"],
      });

      expect(configDb.upsertBot).toHaveBeenCalledWith(
        env.D1_DB,
        expect.objectContaining({
          soul: "",
          enabledSkills: [],
          baseUrl: undefined,
        }),
      );
    });

    it("rejects conflicting clearFields and value updates", async () => {
      const existing = makeBot({ botId: "b1", soul: "Old" });
      vi.mocked(configDb.getBot).mockResolvedValue(existing);

      const result = await exec(tools, "update_bot", {
        botId: "b1",
        soul: "New",
        clearFields: ["soul"],
      });

      expect(result).toContain("Conflicting update");
      expect(configDb.upsertBot).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // delete_bot
  // -------------------------------------------------------------------------

  describe("delete_bot", () => {
    it("prevents deleting admin bot", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(
        makeBot({ botId: "admin-1", botType: "admin" }),
      );

      const result = await exec(tools, "delete_bot", { botId: "admin-1" });
      expect(result).toBe("Cannot delete an admin bot.");
      expect(configDb.softDeleteBot).not.toHaveBeenCalled();
    });

    it("deletes a normal bot successfully", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(
        makeBot({ botId: "b1", name: "NormalBot", botType: "normal" }),
      );
      vi.mocked(configDb.deleteTokenMappingsForBot).mockResolvedValue(undefined);
      vi.mocked(configDb.softDeleteBot).mockResolvedValue(undefined);

      const result = await exec(tools, "delete_bot", { botId: "b1" });
      expect(result).toContain("Bot deleted");
      expect(result).toContain("NormalBot");
      expect(configDb.deleteTokenMappingsForBot).toHaveBeenCalledWith(
        env.D1_DB,
        OWNER_ID,
        "b1",
      );
      expect(configDb.softDeleteBot).toHaveBeenCalledWith(env.D1_DB, OWNER_ID, "b1");
    });

    it("returns not found for missing bot", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(null);
      const result = await exec(tools, "delete_bot", { botId: "x" });
      expect(result).toContain("Bot not found");
    });
  });

  // -------------------------------------------------------------------------
  // restore_bot
  // -------------------------------------------------------------------------

  describe("restore_bot", () => {
    it("restores a deleted bot", async () => {
      vi.mocked(configDb.restoreBot).mockResolvedValue(
        makeBot({ botId: "b1", name: "Restored" }),
      );

      const result = await exec(tools, "restore_bot", { botId: "b1" });
      expect(result).toContain("Bot restored");
      expect(result).toContain("Restored");
    });

    it("returns not found if bot is not deleted", async () => {
      vi.mocked(configDb.restoreBot).mockResolvedValue(null);
      const result = await exec(tools, "restore_bot", { botId: "b1" });
      expect(result).toContain("not found or not deleted");
    });
  });

  // -------------------------------------------------------------------------
  // clone_bot
  // -------------------------------------------------------------------------

  describe("clone_bot", () => {
    it("clones a bot with a new name and no channels", async () => {
      const source = makeBot({
        botId: "b1",
        name: "Original",
        soul: "Be helpful",
        enabledSkills: ["memory"],
        channels: { telegram: { token: "tok" } },
      });
      vi.mocked(configDb.getBot).mockResolvedValue(source);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      const result = await exec(tools, "clone_bot", { botId: "b1", name: "Clone" });

      expect(result).toContain("Bot cloned");
      expect(result).toContain("Clone");
      expect(result).toContain("from **Original**");
      expect(configDb.upsertBot).toHaveBeenCalledWith(
        env.D1_DB,
        expect.objectContaining({
          name: "Clone",
          soul: "Be helpful",
          enabledSkills: ["memory"],
          channels: {},
          allowedSenderIds: [],
        }),
      );
      // New botId should differ from source
      const savedBot = vi.mocked(configDb.upsertBot).mock.calls[0][1] as BotConfig;
      expect(savedBot.botId).not.toBe("b1");
    });

    it("refuses to clone admin bot", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botType: "admin" }));
      const result = await exec(tools, "clone_bot", { botId: "a1", name: "Bad" });
      expect(result).toContain("Cannot clone an admin bot");
    });

    it("returns not found for missing bot", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(null);
      const result = await exec(tools, "clone_bot", { botId: "missing", name: "X" });
      expect(result).toContain("Bot not found");
    });
  });

  // -------------------------------------------------------------------------
  // bind_channel / unbind_channel
  // -------------------------------------------------------------------------

  describe("bind_channel", () => {
    it("binds telegram channel and auto-sets webhook", async () => {
      const bot = makeBot({ botId: "b1", channels: {} });
      vi.mocked(configDb.getBot).mockResolvedValue(bot);
      vi.mocked(configDb.upsertTokenMapping).mockResolvedValue(undefined);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(JSON.stringify({ ok: true })),
      );

      const result = await exec(tools, "bind_channel", {
        botId: "b1",
        channel: "telegram",
        token: "123:ABC",
      });

      expect(result).toContain("Channel **telegram** bound to");
      expect(result).toContain("webhook set automatically");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.telegram.org/bot123:ABC/setWebhook",
        expect.objectContaining({ method: "POST" }),
      );
      expect(configDb.upsertTokenMapping).toHaveBeenCalled();
      expect(configDb.upsertBot).toHaveBeenCalledWith(
        env.D1_DB,
        expect.objectContaining({
          channels: { telegram: expect.objectContaining({ token: "123:ABC" }) },
        }),
      );

      fetchSpy.mockRestore();
    });

    it("reports warning when auto-webhook fails", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1", channels: {} }));
      vi.mocked(configDb.upsertTokenMapping).mockResolvedValue(undefined);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        new Response(JSON.stringify({ ok: false, description: "Unauthorized" })),
      );

      const result = await exec(tools, "bind_channel", {
        botId: "b1",
        channel: "telegram",
        token: "bad-token",
      });

      expect(result).toContain("Channel **telegram** bound to");
      expect(result).toContain("Warning: Failed to set webhook");
      fetchSpy.mockRestore();
    });

    it("does not call webhook for non-telegram channels", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      vi.mocked(configDb.upsertTokenMapping).mockResolvedValue(undefined);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ id: "discord-bot-id" })),
      );

      const result = await exec(tools, "bind_channel", {
        botId: "b1",
        channel: "discord",
        token: "discord-token",
      });

      expect(result).toContain("Channel **discord** bound to");
      expect(result).not.toContain("webhook");
      // fetch is called for identity lookup but NOT for webhook
      expect(fetchSpy).not.toHaveBeenCalledWith(
        expect.stringContaining("setWebhook"),
        expect.anything(),
      );
      fetchSpy.mockRestore();
    });

    it("saves channelUsername when Telegram getMe succeeds", async () => {
      const bot = makeBot({ botId: "b1", channels: {} });
      vi.mocked(configDb.getBot).mockResolvedValue(bot);
      vi.mocked(configDb.upsertTokenMapping).mockResolvedValue(undefined);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
        const urlStr = typeof url === "string" ? url : url.toString();
        if (urlStr.includes("/getMe")) {
          return new Response(JSON.stringify({ ok: true, result: { username: "test_bot" } }));
        }
        return new Response(JSON.stringify({ ok: true }));
      });

      await exec(tools, "bind_channel", {
        botId: "b1",
        channel: "telegram",
        token: "123:ABC",
      });

      const savedBot = vi.mocked(configDb.upsertBot).mock.calls[0][1];
      expect(savedBot.channels.telegram.channelUsername).toBe("@test_bot");
      fetchSpy.mockRestore();
    });
  });

  describe("unbind_channel", () => {
    it("unbinds a telegram channel and auto-deletes webhook", async () => {
      const bot = makeBot({
        botId: "b1",
        channels: { telegram: { token: "123:ABC" } },
      });
      vi.mocked(configDb.getBot).mockResolvedValue(bot);
      vi.mocked(configDb.deleteTokenMapping).mockResolvedValue(undefined);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: true })),
      );

      const result = await exec(tools, "unbind_channel", {
        botId: "b1",
        channel: "telegram",
      });

      expect(result).toContain("unbound");
      expect(result).toContain("webhook deleted");
      expect(fetchSpy).toHaveBeenCalledWith(
        "https://api.telegram.org/bot123:ABC/deleteWebhook",
      );
      expect(configDb.deleteTokenMapping).toHaveBeenCalledWith(
        env.D1_DB,
        "telegram",
        "123:ABC",
      );
      fetchSpy.mockRestore();
    });

    it("warns when telegram webhook deletion fails", async () => {
      const bot = makeBot({
        botId: "b1",
        channels: { telegram: { token: "123:ABC" } },
      });
      vi.mocked(configDb.getBot).mockResolvedValue(bot);
      vi.mocked(configDb.deleteTokenMapping).mockResolvedValue(undefined);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(JSON.stringify({ ok: false })),
      );

      const result = await exec(tools, "unbind_channel", {
        botId: "b1",
        channel: "telegram",
      });

      expect(result).toContain("unbound");
      expect(result).toContain("Warning: Failed to delete Telegram webhook");
      // Binding should still be removed even if webhook deletion failed
      expect(configDb.deleteTokenMapping).toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("returns error for unbound channel", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1", channels: {} }));
      const result = await exec(tools, "unbind_channel", {
        botId: "b1",
        channel: "slack",
      });
      expect(result).toContain("not bound");
    });
  });

  // -------------------------------------------------------------------------
  // Group Management
  // -------------------------------------------------------------------------

  describe("list_groups", () => {
    it("returns formatted group list", async () => {
      vi.mocked(configDb.listGroups).mockResolvedValue([
        {
          groupId: "g1",
          name: "TestGroup",
          ownerId: OWNER_ID,
          botIds: ["b1", "b2"],
          note: "",
          orchestratorProvider: "anthropic",
          orchestratorModel: "claude-sonnet-4-6",
        },
      ]);

      const result = await exec(tools, "list_groups");
      expect(result).toContain("**TestGroup**");
      expect(result).toContain("2 bot(s)");
    });

    it("handles empty list", async () => {
      vi.mocked(configDb.listGroups).mockResolvedValue([]);
      const result = await exec(tools, "list_groups");
      expect(result).toBe("No groups found.");
    });
  });

  describe("create_group", () => {
    it("creates a group with valid bots", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      vi.mocked(configDb.upsertGroup).mockResolvedValue(undefined);

      const result = await exec(tools, "create_group", {
        name: "ChatGroup",
        botIds: ["b1"],
      });

      expect(result).toContain("Group created");
      expect(result).toContain("**ChatGroup**");
      expect(configDb.upsertGroup).toHaveBeenCalledWith(
        env.D1_DB,
        expect.objectContaining({
          name: "ChatGroup",
          botIds: ["b1"],
          ownerId: OWNER_ID,
          groupId: expect.stringMatching(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
          ),
        }),
      );
    });

    it("prevents adding admin bot to group", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(
        makeBot({ botId: "admin-1", name: "AdminBot", botType: "admin" }),
      );

      const result = await exec(tools, "create_group", {
        name: "BadGroup",
        botIds: ["admin-1"],
      });

      expect(result).toContain("Cannot add admin bot");
      expect(configDb.upsertGroup).not.toHaveBeenCalled();
    });

    it("returns error for non-existent bot", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(null);

      const result = await exec(tools, "create_group", {
        name: "Group",
        botIds: ["missing"],
      });

      expect(result).toContain("Bot not found");
    });
  });

  describe("update_group", () => {
    it("preserves groupId and ownerId", async () => {
      const existing: GroupConfig = {
        groupId: "g1",
        name: "OldName",
        ownerId: OWNER_ID,
        botIds: ["b1"],
        note: "",
        orchestratorProvider: "anthropic",
        orchestratorModel: "claude-sonnet-4-6",
      };
      vi.mocked(configDb.getGroup).mockResolvedValue(existing);
      vi.mocked(configDb.upsertGroup).mockResolvedValue(undefined);

      await exec(tools, "update_group", {
        groupId: "g1",
        name: "NewName",
      });

      expect(configDb.upsertGroup).toHaveBeenCalledWith(
        env.D1_DB,
        expect.objectContaining({
          groupId: "g1",
          ownerId: OWNER_ID,
          name: "NewName",
        }),
      );
    });
  });

  describe("delete_group", () => {
    it("deletes a group", async () => {
      vi.mocked(configDb.deleteGroup).mockResolvedValue(undefined);
      const result = await exec(tools, "delete_group", { groupId: "g1" });
      expect(result).toContain("Group deleted");
      expect(configDb.deleteGroup).toHaveBeenCalledWith(env.D1_DB, OWNER_ID, "g1");
    });
  });

  // -------------------------------------------------------------------------
  // API Keys
  // -------------------------------------------------------------------------

  describe("get_keys", () => {
    it("masks key values (last 4 chars only)", async () => {
      vi.mocked(configDb.getUserKeys).mockResolvedValue({
        openai: "sk-1234567890abcdef",
        anthropic: "ant-xyz",
      });

      const result = await exec(tools, "get_keys");
      expect(result).toContain("**openai**: ****cdef");
      expect(result).toContain("**anthropic**: ****-xyz");
      // Must NOT contain the full key
      expect(result).not.toContain("sk-1234567890abcdef");
    });

    it("handles no keys", async () => {
      vi.mocked(configDb.getUserKeys).mockResolvedValue(null);
      const result = await exec(tools, "get_keys");
      expect(result).toBe("No API keys configured.");
    });

    it("masks short keys with ****", async () => {
      vi.mocked(configDb.getUserKeys).mockResolvedValue({
        openai: "ab",
      });

      const result = await exec(tools, "get_keys");
      expect(result).toContain("****");
    });
  });

  describe("update_keys", () => {
    it("handles null (delete) and string (set)", async () => {
      vi.mocked(configDb.getUserKeys).mockResolvedValue({
        openai: "old-key",
        anthropic: "ant-key",
      });
      vi.mocked(configDb.upsertUserKeys).mockResolvedValue(undefined);

      const result = await exec(tools, "update_keys", {
        openai: null, // delete
        google: "new-google-key", // set
      });

      expect(result).toContain("openai: removed");
      expect(result).toContain("google: set");

      // Check the merged keys passed to upsertUserKeys
      expect(configDb.upsertUserKeys).toHaveBeenCalledWith(
        env.D1_DB,
        OWNER_ID,
        expect.objectContaining({
          anthropic: "ant-key", // preserved
          google: "new-google-key", // added
        }),
      );
      // openai should be deleted
      const passedKeys = vi.mocked(configDb.upsertUserKeys).mock.calls[0][2];
      expect(passedKeys.openai).toBeUndefined();
    });

    it("creates keys when none exist", async () => {
      vi.mocked(configDb.getUserKeys).mockResolvedValue(null);
      vi.mocked(configDb.upsertUserKeys).mockResolvedValue(undefined);

      await exec(tools, "update_keys", { openai: "sk-new" });

      expect(configDb.upsertUserKeys).toHaveBeenCalledWith(
        env.D1_DB,
        OWNER_ID,
        expect.objectContaining({ openai: "sk-new" }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // Skills
  // -------------------------------------------------------------------------

  describe("list_skills", () => {
    it("returns formatted skill list", async () => {
      vi.mocked(listAllSkills).mockResolvedValue([
        {
          name: "memory",
          description: "Memory skill",
          emoji: undefined,
          path: "/skills/memory/SKILL.md",
          source: "bundled",
          available: true,
        },
        {
          name: "my-tool",
          description: "A custom skill",
          emoji: "🔧",
          path: "/installed-skills/my-tool/SKILL.md",
          source: "installed",
          available: true,
        },
      ]);

      const result = await exec(tools, "list_skills");
      expect(result).toContain("**memory**");
      expect(result).toContain("bundled");
      expect(result).toContain("**my-tool**");
      expect(result).toContain("installed");
    });
  });

  describe("delete_skill", () => {
    it("prevents deleting bundled skills", async () => {
      const result = await exec(tools, "delete_skill", { name: "memory" });
      expect(result).toContain("Cannot delete bundled skill");
    });

    it("deletes an installed skill", async () => {
      // Override mock to return changes = 1
      const mockRun = vi.fn().mockResolvedValue({ meta: { changes: 1 } });
      const mockBind = vi.fn().mockReturnValue({ run: mockRun });
      const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
      env.D1_DB = { prepare: mockPrepare } as unknown as D1Database;
      tools = createAdminTools(env, OWNER_ID);

      const result = await exec(tools, "delete_skill", { name: "my-skill" });
      expect(result).toContain('Skill "my-skill" deleted');
    });

    it("returns not found for non-existent skill", async () => {
      // Default mock returns changes: 0
      const result = await exec(tools, "delete_skill", { name: "nonexistent" });
      expect(result).toContain("not found");
    });
  });

  // -------------------------------------------------------------------------
  // query_sessions
  // -------------------------------------------------------------------------

  describe("query_sessions", () => {
    it("returns formatted session list", async () => {
      const mockAll = vi.fn().mockResolvedValue({
        results: [
          {
            id: "tg-123-20260101-abcd",
            channel: "telegram",
            chat_id: "123",
            group_id: null,
            created_at: "2026-01-01T00:00:00Z",
            message_count: 5,
          },
        ],
      });
      const mockBind = vi.fn().mockReturnValue({ all: mockAll });
      const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
      env.D1_DB = { prepare: mockPrepare } as unknown as D1Database;
      tools = createAdminTools(env, OWNER_ID);

      const result = await exec(tools, "query_sessions", {});
      expect(result).toContain("tg-123-20260101-abcd");
      expect(result).toContain("telegram");
      expect(result).toContain("5 msgs");
    });

    it("returns empty message when no sessions", async () => {
      const mockAll = vi.fn().mockResolvedValue({ results: [] });
      const mockBind = vi.fn().mockReturnValue({ all: mockAll });
      const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
      env.D1_DB = { prepare: mockPrepare } as unknown as D1Database;
      tools = createAdminTools(env, OWNER_ID);

      const result = await exec(tools, "query_sessions", {});
      expect(result).toBe("No sessions found.");
    });
  });

  // -------------------------------------------------------------------------
  // read_bot_memory
  // -------------------------------------------------------------------------

  describe("read_bot_memory", () => {
    it("reads a bot's MEMORY.md", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      vi.mocked(getMemory).mockResolvedValue("# Bot Memory\nUser likes cats");
      const result = await exec(tools, "read_bot_memory", { botId: "b1", file: "MEMORY.md" });
      expect(result).toContain("User likes cats");
      expect(getMemory).toHaveBeenCalledWith(env.D1_DB, "b1");
    });

    it("reads a bot's HISTORY.md", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      vi.mocked(getHistoryEntries).mockResolvedValue([
        { id: 1, content: "[2026-03-01] Did stuff", created_at: "2026-03-01T00:00:00Z" },
      ]);
      const result = await exec(tools, "read_bot_memory", { botId: "b1", file: "HISTORY.md" });
      expect(result).toContain("Did stuff");
      expect(getHistoryEntries).toHaveBeenCalledWith(env.D1_DB, "b1", 100);
    });

    it("returns (empty) when no memory exists", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      vi.mocked(getMemory).mockResolvedValue("");
      const result = await exec(tools, "read_bot_memory", { botId: "b1", file: "MEMORY.md" });
      expect(result).toBe("(empty)");
    });

    it("returns error for non-existent bot", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(null);
      const result = await exec(tools, "read_bot_memory", { botId: "missing", file: "MEMORY.md" });
      expect(result).toContain("Bot not found");
    });

    it("truncates content exceeding default maxLength (2000)", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      const longContent = "x".repeat(3000);
      vi.mocked(getMemory).mockResolvedValue(longContent);
      const result = await exec(tools, "read_bot_memory", { botId: "b1", file: "MEMORY.md" });
      expect(result).toContain("... (truncated, total 3000 chars, use maxLength=3000 to read full)");
      expect(result.startsWith("x".repeat(2000))).toBe(true);
    });

    it("truncates at custom maxLength", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      const content = "a".repeat(500);
      vi.mocked(getMemory).mockResolvedValue(content);
      const result = await exec(tools, "read_bot_memory", { botId: "b1", file: "MEMORY.md", maxLength: 100 });
      expect(result).toContain("... (truncated, total 500 chars, use maxLength=500 to read full)");
      expect(result.startsWith("a".repeat(100))).toBe(true);
    });

    it("does not truncate short content", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      vi.mocked(getMemory).mockResolvedValue("short content");
      const result = await exec(tools, "read_bot_memory", { botId: "b1", file: "MEMORY.md" });
      expect(result).toBe("short content");
    });
  });

  // -------------------------------------------------------------------------
  // read_bot_messages
  // -------------------------------------------------------------------------

  describe("read_bot_messages", () => {
    function setupD1Mock(results: any[]) {
      const mockAll = vi.fn().mockResolvedValue({ results });
      const mockBind = vi.fn().mockReturnValue({ all: mockAll });
      const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
      env.D1_DB = { prepare: mockPrepare } as unknown as D1Database;
      tools = createAdminTools(env, OWNER_ID);
      return { mockAll, mockBind, mockPrepare };
    }

    it("returns formatted message list", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      setupD1Mock([
        { role: "user", content: "Hello", tool_calls: null, created_at: "2026-03-01T10:00:00Z" },
        { role: "assistant", content: "Hi there!", tool_calls: '[{"toolName":"memory_read"}]', created_at: "2026-03-01T10:00:01Z" },
      ]);

      const result = await exec(tools, "read_bot_messages", { botId: "b1" });
      expect(result).toContain("USER: Hello");
      expect(result).toContain("ASSISTANT");
      expect(result).toContain("Hi there!");
      expect(result).toContain("memory_read");
      // Only 2 results with default limit 20, so no "more" footer
      expect(result).not.toContain("use offset=");
    });

    it("returns empty message when no messages found", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      setupD1Mock([]);

      const result = await exec(tools, "read_bot_messages", { botId: "b1" });
      expect(result).toBe("No messages found.");
    });

    it("returns error for non-existent bot", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(null);
      const result = await exec(tools, "read_bot_messages", { botId: "missing" });
      expect(result).toContain("Bot not found");
    });

    it("clamps limit to max 50", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      const { mockBind } = setupD1Mock([]);

      await exec(tools, "read_bot_messages", { botId: "b1", limit: 200 });
      expect(mockBind).toHaveBeenCalled();
      const bindArgs = mockBind.mock.calls[0];
      // limit is second-to-last param (before offset)
      expect(bindArgs[bindArgs.length - 2]).toBe(50);
    });

    it("truncates content over 200 chars when full=false", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      const longContent = "a".repeat(300);
      setupD1Mock([
        { role: "user", content: longContent, tool_calls: null, created_at: "2026-03-01T10:00:00Z" },
      ]);

      const result = await exec(tools, "read_bot_messages", { botId: "b1" });
      expect(result).toContain("a".repeat(200) + "...");
      expect(result).not.toContain("a".repeat(201));
    });

    it("replaces image references with [image]", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      setupD1Mock([
        { role: "assistant", content: "Here is your selfie! ![selfie](image:r2://bucket/img.png)", tool_calls: null, created_at: "2026-03-01T10:00:00Z" },
      ]);

      const result = await exec(tools, "read_bot_messages", { botId: "b1" });
      expect(result).toContain("[image]");
      expect(result).not.toContain("r2://");
      expect(result).toContain("Here is your selfie!");
    });

    it("returns full content when full=true (no truncation, no image filtering)", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      const longContent = "b".repeat(300) + " ![pic](image:r2://bucket/pic.png)";
      setupD1Mock([
        { role: "user", content: longContent, tool_calls: null, created_at: "2026-03-01T10:00:00Z" },
      ]);

      const result = await exec(tools, "read_bot_messages", { botId: "b1", full: true });
      expect(result).toContain("b".repeat(300));
      expect(result).toContain("![pic](image:r2://bucket/pic.png)");
      expect(result).not.toContain("...");
    });

    it("passes offset to SQL OFFSET", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      const { mockBind } = setupD1Mock([
        { role: "user", content: "msg", tool_calls: null, created_at: "2026-03-01T10:00:00Z" },
      ]);

      await exec(tools, "read_bot_messages", { botId: "b1", offset: 10 });
      const bindArgs = mockBind.mock.calls[0];
      expect(bindArgs[bindArgs.length - 1]).toBe(10); // offset is last param
    });

    it("shows pagination footer only when full page returned", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      // Return exactly 3 results with limit=3 → footer should appear
      setupD1Mock([
        { role: "user", content: "a", tool_calls: null, created_at: "2026-03-01T10:00:00Z" },
        { role: "user", content: "b", tool_calls: null, created_at: "2026-03-01T10:00:01Z" },
        { role: "user", content: "c", tool_calls: null, created_at: "2026-03-01T10:00:02Z" },
      ]);
      const result = await exec(tools, "read_bot_messages", { botId: "b1", limit: 3, offset: 5 });
      expect(result).toContain("(showing 6-8, use offset=8 for more)");
    });

    it("omits pagination footer when fewer results than limit", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1" }));
      setupD1Mock([
        { role: "user", content: "only one", tool_calls: null, created_at: "2026-03-01T10:00:00Z" },
      ]);
      const result = await exec(tools, "read_bot_messages", { botId: "b1", limit: 10 });
      expect(result).not.toContain("use offset=");
    });
  });

  // -------------------------------------------------------------------------
  // edit_bot_memory
  // -------------------------------------------------------------------------

  describe("edit_bot_memory", () => {
    it("replaces matching text in bot memory", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1", name: "TestBot" }));
      vi.mocked(getMemory).mockResolvedValue("Name: Alice\nCity: Beijing");
      const result = await exec(tools, "edit_bot_memory", {
        botId: "b1",
        old_string: "City: Beijing",
        new_string: "City: Shanghai",
      });
      expect(result).toContain("Edited");
      expect(result).toContain("TestBot");
      expect(upsertMemory).toHaveBeenCalledWith(
        env.D1_DB,
        "b1",
        "Name: Alice\nCity: Shanghai"
      );
    });

    it("returns error when old_string not found", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1", name: "TestBot" }));
      vi.mocked(getMemory).mockResolvedValue("Name: Alice");
      const result = await exec(tools, "edit_bot_memory", {
        botId: "b1",
        old_string: "Name: Bob",
        new_string: "Name: Charlie",
      });
      expect(result).toContain("not found");
      expect(upsertMemory).not.toHaveBeenCalled();
    });

    it("returns error when old_string matches multiple times", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1", name: "TestBot" }));
      vi.mocked(getMemory).mockResolvedValue("likes cats\nlikes cats");
      const result = await exec(tools, "edit_bot_memory", {
        botId: "b1",
        old_string: "likes cats",
        new_string: "likes dogs",
      });
      expect(result).toContain("2 times");
      expect(upsertMemory).not.toHaveBeenCalled();
    });

    it("returns error for empty file", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1", name: "TestBot" }));
      vi.mocked(getMemory).mockResolvedValue("");
      const result = await exec(tools, "edit_bot_memory", {
        botId: "b1",
        old_string: "anything",
        new_string: "new",
      });
      expect(result).toContain("empty");
    });

    it("returns error for non-existent bot", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(null);
      const result = await exec(tools, "edit_bot_memory", {
        botId: "missing",
        old_string: "a",
        new_string: "b",
      });
      expect(result).toContain("Bot not found");
    });

    it("prevents editing admin bot's memory", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(
        makeBot({ botId: "admin-1", name: "Admin", botType: "admin" }),
      );
      const result = await exec(tools, "edit_bot_memory", {
        botId: "admin-1",
        old_string: "a",
        new_string: "b",
      });
      expect(result).toContain("Cannot edit admin bot");
    });
  });

  // -------------------------------------------------------------------------
  // correct_bot_history
  // -------------------------------------------------------------------------

  describe("correct_bot_history", () => {
    it("appends correction entry to bot history", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1", name: "TestBot" }));
      const result = await exec(tools, "correct_bot_history", {
        botId: "b1",
        correction: "[CORRECTION] User's favorite color is blue, not red.",
      });
      expect(result).toContain("Appended correction");
      expect(result).toContain("TestBot");
      const { insertHistoryEntry } = await import("../db/d1");
      expect(insertHistoryEntry).toHaveBeenCalledWith(
        env.D1_DB,
        "b1",
        "[CORRECTION] User's favorite color is blue, not red.",
      );
    });

    it("auto-prepends [CORRECTION] if missing", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1", name: "TestBot" }));
      const result = await exec(tools, "correct_bot_history", {
        botId: "b1",
        correction: "User's name is actually Bob, not Alice.",
      });
      expect(result).toContain("Appended correction");
      const { insertHistoryEntry } = await import("../db/d1");
      expect(insertHistoryEntry).toHaveBeenCalledWith(
        env.D1_DB,
        "b1",
        "[CORRECTION] User's name is actually Bob, not Alice.",
      );
    });

    it("returns error for non-existent bot", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(null);
      const result = await exec(tools, "correct_bot_history", {
        botId: "missing",
        correction: "[CORRECTION] fix something",
      });
      expect(result).toContain("Bot not found");
    });

    it("prevents correcting admin bot's history", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(
        makeBot({ botId: "admin-1", name: "Admin", botType: "admin" }),
      );
      const result = await exec(tools, "correct_bot_history", {
        botId: "admin-1",
        correction: "[CORRECTION] something",
      });
      expect(result).toContain("Cannot modify admin bot");
    });
  });

  // -------------------------------------------------------------------------
  // check_webhook
  // -------------------------------------------------------------------------

  describe("check_webhook", () => {
    it("returns webhook info for a bot with telegram channel", async () => {
      const bot = makeBot({
        botId: "b1",
        name: "TestBot",
        channels: { telegram: { token: "123:ABC" } },
      });
      vi.mocked(configDb.getBot).mockResolvedValue(bot);

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          ok: true,
          result: {
            url: "https://example.com/webhook/telegram/123:ABC",
            pending_update_count: 0,
            last_error_date: 0,
            last_error_message: "",
          },
        }),
      });
      vi.stubGlobal("fetch", mockFetch);

      const result = await exec(tools, "check_webhook", { botId: "b1" });
      expect(result).toContain("https://example.com/webhook/telegram/123:ABC");
      expect(result).toContain("Pending updates: 0");
      expect(result).toContain("Status: **OK**");

      vi.unstubAllGlobals();
    });

    it("returns error when bot has no telegram channel", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(makeBot({ botId: "b1", channels: {} }));
      const result = await exec(tools, "check_webhook", { botId: "b1" });
      expect(result).toContain("No Telegram channel bound");
    });

    it("returns error for non-existent bot", async () => {
      vi.mocked(configDb.getBot).mockResolvedValue(null);
      const result = await exec(tools, "check_webhook", { botId: "missing" });
      expect(result).toContain("Bot not found");
    });

    it("handles fetch failure gracefully", async () => {
      const bot = makeBot({
        botId: "b1",
        channels: { telegram: { token: "123:ABC" } },
      });
      vi.mocked(configDb.getBot).mockResolvedValue(bot);
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("Network error")));

      const result = await exec(tools, "check_webhook", { botId: "b1" });
      expect(result).toContain("Failed to check webhook");

      vi.unstubAllGlobals();
    });
  });

  // -------------------------------------------------------------------------
  // query_usage
  // -------------------------------------------------------------------------

  describe("query_usage", () => {
    it("returns usage stats for all bots", async () => {
      const mockAll = vi.fn().mockResolvedValue({
        results: [
          { bot_id: "b1", name: "Alpha", msg_count: 42, session_count: 3 },
          { bot_id: "b2", name: "Beta", msg_count: 10, session_count: 1 },
        ],
      });
      const mockBind = vi.fn().mockReturnValue({ all: mockAll });
      const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
      env.D1_DB = { prepare: mockPrepare } as unknown as D1Database;
      tools = createAdminTools(env, OWNER_ID);

      const result = await exec(tools, "query_usage", {});
      expect(result).toContain("Alpha");
      expect(result).toContain("42 messages");
      expect(result).toContain("3 sessions");
      expect(result).toContain("Beta");
    });

    it("returns no activity message when empty", async () => {
      const mockAll = vi.fn().mockResolvedValue({ results: [] });
      const mockBind = vi.fn().mockReturnValue({ all: mockAll });
      const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
      env.D1_DB = { prepare: mockPrepare } as unknown as D1Database;
      tools = createAdminTools(env, OWNER_ID);

      const result = await exec(tools, "query_usage", {});
      expect(result).toContain("No activity");
    });

    it("filters by botId when provided", async () => {
      const mockAll = vi.fn().mockResolvedValue({
        results: [{ bot_id: "b1", name: "Alpha", msg_count: 42, session_count: 3 }],
      });
      const mockBind = vi.fn().mockReturnValue({ all: mockAll });
      const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
      env.D1_DB = { prepare: mockPrepare } as unknown as D1Database;
      tools = createAdminTools(env, OWNER_ID);

      const result = await exec(tools, "query_usage", { botId: "b1", period: "week" });
      expect(result).toContain("Alpha");
      // Verify botId was passed as second bind param
      const bindArgs = mockBind.mock.calls[0];
      expect(bindArgs).toContain("b1");
    });
  });

  // -------------------------------------------------------------------------
  // batch_update_bots
  // -------------------------------------------------------------------------

  describe("batch_update_bots", () => {
    it("updates specific bots by ID", async () => {
      const bot1 = makeBot({ botId: "b1", name: "Alpha", model: "gpt-3.5" });
      const bot2 = makeBot({ botId: "b2", name: "Beta", model: "gpt-3.5" });
      vi.mocked(configDb.getBot)
        .mockResolvedValueOnce(bot1)
        .mockResolvedValueOnce(bot2);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      const result = await exec(tools, "batch_update_bots", {
        botIds: ["b1", "b2"],
        model: "gpt-4",
      });

      expect(result).toContain("Updated 2/2");
      expect(result).toContain("Alpha");
      expect(result).toContain("Beta");
      expect(configDb.upsertBot).toHaveBeenCalledTimes(2);
      expect(configDb.upsertBot).toHaveBeenCalledWith(
        env.D1_DB,
        expect.objectContaining({ botId: "b1", model: "gpt-4" }),
      );
    });

    it("updates all normal bots when botIds is 'all'", async () => {
      vi.mocked(configDb.listBots).mockResolvedValue([
        makeBot({ botId: "b1", name: "Alpha" }),
        makeBot({ botId: "admin-1", name: "Admin", botType: "admin" }),
        makeBot({ botId: "b2", name: "Beta" }),
      ]);
      vi.mocked(configDb.getBot)
        .mockResolvedValueOnce(makeBot({ botId: "b1", name: "Alpha" }))
        .mockResolvedValueOnce(makeBot({ botId: "b2", name: "Beta" }));
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      const result = await exec(tools, "batch_update_bots", {
        botIds: "all",
        model: "claude-sonnet-4-6",
      });

      expect(result).toContain("Updated 2/2");
      expect(configDb.upsertBot).toHaveBeenCalledTimes(2);
    });

    it("reports partial failures", async () => {
      const bot1 = makeBot({ botId: "b1", name: "Alpha" });
      vi.mocked(configDb.getBot)
        .mockResolvedValueOnce(bot1)
        .mockResolvedValueOnce(null);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      const result = await exec(tools, "batch_update_bots", {
        botIds: ["b1", "b2"],
        model: "gpt-4",
      });

      expect(result).toContain("Updated 1/2");
      expect(result).toContain("b2");
    });

    it("requires at least one update field", async () => {
      const result = await exec(tools, "batch_update_bots", {
        botIds: ["b1"],
      });
      expect(result).toContain("No effective update fields");
    });

    it("ignores accidental empty values in batch updates", async () => {
      const bot1 = makeBot({
        botId: "b1",
        name: "Alpha",
        model: "gpt-4",
        enabledSkills: ["memory"],
      });
      vi.mocked(configDb.getBot).mockResolvedValueOnce(bot1);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      const result = await exec(tools, "batch_update_bots", {
        botIds: ["b1"],
        model: "gpt-5",
        enabledSkills: [],
      });

      expect(result).toContain("Updated 1/1");
      expect(configDb.upsertBot).toHaveBeenCalledWith(
        env.D1_DB,
        expect.objectContaining({
          model: "gpt-5",
          enabledSkills: ["memory"],
        }),
      );
    });

    it("clears selected fields in batch updates via clearFields", async () => {
      const bot1 = makeBot({
        botId: "b1",
        name: "Alpha",
        enabledSkills: ["memory"],
        timezone: "Asia/Shanghai",
      });
      vi.mocked(configDb.getBot).mockResolvedValueOnce(bot1);
      vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);

      const result = await exec(tools, "batch_update_bots", {
        botIds: ["b1"],
        clearFields: ["enabledSkills", "timezone"],
      });

      expect(result).toContain("Updated 1/1");
      expect(configDb.upsertBot).toHaveBeenCalledWith(
        env.D1_DB,
        expect.objectContaining({
          enabledSkills: [],
          timezone: undefined,
        }),
      );
    });
  });

  // -------------------------------------------------------------------------
  // system_status
  // -------------------------------------------------------------------------

  describe("system_status", () => {
    it("returns full system overview", async () => {
      vi.mocked(configDb.listBots).mockResolvedValue([
        makeBot({ botId: "b1", name: "Alpha", channels: { telegram: { token: "t1" } } }),
        makeBot({ botId: "b2", name: "Beta", botType: "admin" }),
      ]);
      vi.mocked(configDb.listGroups).mockResolvedValue([
        {
          groupId: "g1",
          name: "MyGroup",
          ownerId: OWNER_ID,
          botIds: ["b1"],
          note: "",
          orchestratorProvider: "anthropic",
          orchestratorModel: "claude-sonnet-4-6",
        },
      ]);
      vi.mocked(configDb.getUserKeys).mockResolvedValue({
        openai: "sk-xxx",
        anthropic: "sk-ant-yyy",
      } as UserKeys);

      const mockAll = vi.fn().mockResolvedValue({
        results: [{ bot_id: "b1", name: "Alpha", msg_count: 42 }],
      });
      const mockBind = vi.fn().mockReturnValue({ all: mockAll });
      const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
      env.D1_DB = { prepare: mockPrepare } as unknown as D1Database;
      tools = createAdminTools(env, OWNER_ID);

      const result = await exec(tools, "system_status", {});

      expect(result).toContain("**Bots** (2)");
      expect(result).toContain("Alpha");
      expect(result).toContain("telegram");
      expect(result).toContain("**Groups** (1)");
      expect(result).toContain("MyGroup");
      expect(result).toContain("**API Keys**: openai, anthropic");
      expect(result).toContain("42 total msgs");
    });

    it("handles empty system gracefully", async () => {
      vi.mocked(configDb.listBots).mockResolvedValue([]);
      vi.mocked(configDb.listGroups).mockResolvedValue([]);
      vi.mocked(configDb.getUserKeys).mockResolvedValue(null);

      const mockAll = vi.fn().mockResolvedValue({ results: [] });
      const mockBind = vi.fn().mockReturnValue({ all: mockAll });
      const mockPrepare = vi.fn().mockReturnValue({ bind: mockBind });
      env.D1_DB = { prepare: mockPrepare } as unknown as D1Database;
      tools = createAdminTools(env, OWNER_ID);

      const result = await exec(tools, "system_status", {});

      expect(result).toContain("**Bots**: none");
      expect(result).toContain("**Groups**: none");
      expect(result).toContain("none configured");
      expect(result).toContain("no messages yet");
    });
  });

  // -------------------------------------------------------------------------
  // set_skill_secret
  // -------------------------------------------------------------------------

  describe("set_skill_secret", () => {
    it("sets a new secret for a skill", async () => {
      vi.mocked(listAllSkills).mockResolvedValue([
        { name: "notion", description: "Notion", path: "/installed-skills/notion/SKILL.md", source: "installed", available: true },
      ]);
      vi.mocked(configDb.getSkillSecrets).mockResolvedValue({});
      vi.mocked(configDb.upsertSkillSecret).mockResolvedValue();

      const result = await exec(tools, "set_skill_secret", {
        skill_name: "notion",
        env_key: "NOTION_API_KEY",
        env_value: "secret-123",
      });

      expect(result).toContain("Successfully set NOTION_API_KEY");
      expect(result).toContain('"notion"');
      expect(configDb.upsertSkillSecret).toHaveBeenCalledWith(
        env.D1_DB,
        OWNER_ID,
        "notion",
        { NOTION_API_KEY: "secret-123" },
      );
    });

    it("merges with existing secrets for the same skill", async () => {
      vi.mocked(listAllSkills).mockResolvedValue([
        { name: "notion", description: "Notion", path: "/installed-skills/notion/SKILL.md", source: "installed", available: true },
      ]);
      vi.mocked(configDb.getSkillSecrets).mockResolvedValue({
        notion: { EXISTING_KEY: "existing-value" },
      });
      vi.mocked(configDb.upsertSkillSecret).mockResolvedValue();

      const result = await exec(tools, "set_skill_secret", {
        skill_name: "notion",
        env_key: "NOTION_API_KEY",
        env_value: "new-secret",
      });

      expect(result).toContain("Successfully set NOTION_API_KEY");
      expect(configDb.upsertSkillSecret).toHaveBeenCalledWith(
        env.D1_DB,
        OWNER_ID,
        "notion",
        { EXISTING_KEY: "existing-value", NOTION_API_KEY: "new-secret" },
      );
    });

    it("rejects unknown skill name", async () => {
      vi.mocked(listAllSkills).mockResolvedValue([
        { name: "weather", description: "Weather", path: "/skills/weather/SKILL.md", source: "bundled", available: true },
      ]);

      const result = await exec(tools, "set_skill_secret", {
        skill_name: "nonexistent",
        env_key: "API_KEY",
        env_value: "secret-123",
      });

      expect(result).toContain("Unknown skill(s): nonexistent");
      expect(result).toContain("Available:");
    });

    it("returns error message on failure", async () => {
      vi.mocked(listAllSkills).mockResolvedValue([
        { name: "notion", description: "Notion", path: "/installed-skills/notion/SKILL.md", source: "installed", available: true },
      ]);
      vi.mocked(configDb.getSkillSecrets).mockRejectedValue(new Error("DB error"));

      const result = await exec(tools, "set_skill_secret", {
        skill_name: "notion",
        env_key: "NOTION_API_KEY",
        env_value: "secret-123",
      });

      expect(result).toContain("Failed to set skill secret");
      expect(result).toContain("DB error");
    });
  });
});

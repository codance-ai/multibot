import { describe, it, expect } from "vitest";
import * as configDb from "./config";

/**
 * Chained D1 mock that tracks SQL calls and bindings.
 * Same pattern as d1.test.ts.
 */
function createChainedMockD1() {
  const calls: { sql: string; bindings: any[] }[] = [];
  let firstResult: any = null;
  let allResults: any[] = [];

  function makeStmt(sql: string) {
    const stmt: any = {
      _sql: sql,
      _bindings: [] as any[],
      bind(...args: any[]) {
        stmt._bindings = args;
        calls.push({ sql, bindings: args });
        return stmt;
      },
      async first() { return firstResult; },
      async all() { return { results: allResults }; },
      async run() { return { success: true, meta: { changes: 1 } }; },
    };
    return stmt;
  }

  const db: any = {
    prepare(sql: string) { return makeStmt(sql); },
    async batch(stmts: any[]) { return stmts.map(() => ({ success: true })); },
    _setFirst(val: any) { firstResult = val; },
    _setAll(val: any[]) { allResults = val; },
    _calls: calls,
  };

  return db as D1Database & {
    _setFirst: (val: any) => void;
    _setAll: (val: any[]) => void;
    _calls: typeof calls;
  };
}

// ---------------------------------------------------------------------------
// Sample data
// ---------------------------------------------------------------------------

const sampleBotRow = {
  bot_id: "bot-1",
  owner_id: "owner-1",
  name: "TestBot",
  provider: "openai",
  model: "gpt-4o",
  soul: "You are helpful.",
  agents: "",
  user: "",
  tools: "",
  identity: "",
  base_url: null,
  avatar_url: "https://example.com/avatar.png",
  channels: JSON.stringify({ telegram: { token: "tg-token" } }),
  enabled_skills: JSON.stringify(["memory", "selfie"]),
  max_iterations: 10,
  memory_window: 50,
  context_window: 128000,
  timezone: "Asia/Shanghai",
  image_provider: "openai",
  image_model: "dall-e-3",
  mcp_servers: JSON.stringify({}),
  bot_type: "normal",
  allowed_sender_ids: JSON.stringify([]),
  stt_enabled: 0,
  voice_mode: "off",
  tts_provider: "fish",
  tts_voice: "",
  tts_model: "s2-pro",
  deleted_at: null,
  created_at: "2026-01-01T00:00:00",
  updated_at: "2026-01-01T00:00:00",
};

const sampleGroupRow = {
  group_id: "group-1",
  owner_id: "owner-1",
  name: "TestGroup",
  bot_ids: JSON.stringify(["bot-1", "bot-2"]),
  note: "I am the user",
  orchestrator_provider: "anthropic",
  orchestrator_model: "claude-sonnet-4-6",
  channel: null,
  chat_id: null,
  created_at: "2026-01-01T00:00:00",
  updated_at: "2026-01-01T00:00:00",
};

// ---------------------------------------------------------------------------
// Tests — Bots
// ---------------------------------------------------------------------------

describe("config DAL — bots", () => {
  describe("getBot", () => {
    it("returns parsed BotConfig when found", async () => {
      const db = createChainedMockD1();
      db._setFirst(sampleBotRow);

      const result = await configDb.getBot(db, "owner-1", "bot-1");
      expect(result).not.toBeNull();
      expect(result!.botId).toBe("bot-1");
      expect(result!.name).toBe("TestBot");
      expect(result!.provider).toBe("openai");
      expect(result!.channels).toEqual({ telegram: { token: "tg-token" } });
      expect(result!.enabledSkills).toEqual(["memory", "selfie"]);
      expect(result!.avatarUrl).toBe("https://example.com/avatar.png");
      expect(result!.timezone).toBe("Asia/Shanghai");
      expect(result!.imageProvider).toBe("openai");

      // Verify SQL bindings: botId first, then ownerId
      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].bindings).toEqual(["bot-1", "owner-1"]);
      expect(db._calls[0].sql).toContain("deleted_at IS NULL");
    });

    it("returns null when not found", async () => {
      const db = createChainedMockD1();
      db._setFirst(null);

      const result = await configDb.getBot(db, "owner-1", "nonexistent");
      expect(result).toBeNull();
    });

    it("parses JSON columns with defaults for empty strings", async () => {
      const db = createChainedMockD1();
      db._setFirst({
        ...sampleBotRow,
        channels: "",
        enabled_skills: "",
        mcp_servers: "",
      });

      const result = await configDb.getBot(db, "owner-1", "bot-1");
      expect(result!.channels).toEqual({});
      expect(result!.enabledSkills).toEqual([]);
      expect(result!.mcpServers).toEqual({});
    });
  });

  describe("listBots", () => {
    it("returns array of parsed BotConfigs", async () => {
      const db = createChainedMockD1();
      db._setAll([sampleBotRow, { ...sampleBotRow, bot_id: "bot-2", name: "Bot2" }]);

      const results = await configDb.listBots(db, "owner-1");
      expect(results).toHaveLength(2);
      expect(results[0].botId).toBe("bot-1");
      expect(results[1].botId).toBe("bot-2");
    });

    it("filters by owner", async () => {
      const db = createChainedMockD1();
      db._setAll([]);

      await configDb.listBots(db, "owner-1");
      expect(db._calls[0].bindings).toEqual(["owner-1"]);
      expect(db._calls[0].sql).toContain("owner_id = ?");
      expect(db._calls[0].sql).toContain("deleted_at IS NULL");
    });

    it("returns empty array when no bots", async () => {
      const db = createChainedMockD1();
      db._setAll([]);

      const results = await configDb.listBots(db, "owner-1");
      expect(results).toEqual([]);
    });
  });

  describe("upsertBot", () => {
    it("binds all fields including JSON-serialized columns", async () => {
      const db = createChainedMockD1();
      const config = {
        botId: "bot-1",
        ownerId: "owner-1",
        name: "TestBot",
        provider: "openai" as const,
        model: "gpt-4o",
        soul: "You are helpful.",
        agents: "",
        user: "",
        tools: "",
        identity: "",
        avatarUrl: "https://example.com/avatar.png",
        channels: { telegram: { token: "tg-token" } },
        enabledSkills: ["memory"],
        maxIterations: 10,
        memoryWindow: 50,
        contextWindow: 128000,
        timezone: "Asia/Shanghai",
        imageProvider: "openai" as const,
        imageModel: "dall-e-3",
        mcpServers: {},
        botType: "normal" as const,
        allowedSenderIds: [],
      };

      await configDb.upsertBot(db, config);

      expect(db._calls).toHaveLength(1);
      const bindings = db._calls[0].bindings;
      // Check key positions
      expect(bindings[0]).toBe("bot-1"); // bot_id
      expect(bindings[1]).toBe("owner-1"); // owner_id
      expect(bindings[2]).toBe("TestBot"); // name
      expect(bindings[3]).toBe("openai"); // provider
      expect(bindings[4]).toBe("gpt-4o"); // model
      // JSON-serialized
      expect(bindings[12]).toBe(JSON.stringify({ telegram: { token: "tg-token" } })); // channels
      expect(bindings[13]).toBe(JSON.stringify(["memory"])); // enabled_skills
      expect(bindings[16]).toBe(128000); // context_window
      expect(bindings[20]).toBe(JSON.stringify({})); // mcp_servers
      expect(bindings[21]).toBe(null); // subagent
      expect(bindings[22]).toBe("normal"); // bot_type
      expect(bindings[23]).toBe(JSON.stringify([])); // allowed_sender_ids
      expect(bindings[24]).toBe(0); // stt_enabled
      expect(bindings[25]).toBe("off"); // voice_mode
      expect(bindings[26]).toBe("fish"); // tts_provider
      expect(bindings[27]).toBe(""); // tts_voice
      expect(bindings[28]).toBe("s2-pro"); // tts_model
      expect(bindings).toHaveLength(29);
      // SQL uses ON CONFLICT
      expect(db._calls[0].sql).toContain("ON CONFLICT(bot_id) DO UPDATE");
      // SQL quotes "user" column
      expect(db._calls[0].sql).toContain('"user"');
    });

    it("defaults botType to 'normal' and allowedSenderIds to [] when not provided", async () => {
      const db = createChainedMockD1();
      const config = {
        botId: "bot-1",
        ownerId: "owner-1",
        name: "TestBot",
        provider: "openai" as const,
        model: "gpt-4o",
        soul: "",
        agents: "",
        user: "",
        tools: "",
        identity: "",
        channels: {},
        enabledSkills: [],
        maxIterations: 10,
        memoryWindow: 50,
        mcpServers: {},
      };

      await configDb.upsertBot(db, config as any);

      const bindings = db._calls[0].bindings;
      expect(bindings[22]).toBe("normal"); // bot_type defaults
      expect(bindings[23]).toBe(JSON.stringify([])); // allowed_sender_ids defaults
      expect(bindings[24]).toBe(0); // stt_enabled defaults
      expect(bindings[25]).toBe("off"); // voice_mode defaults
      expect(bindings[26]).toBe("fish"); // tts_provider defaults
      expect(bindings[27]).toBe(""); // tts_voice defaults
      expect(bindings[28]).toBe("s2-pro"); // tts_model defaults
      expect(bindings).toHaveLength(29);
    });

    it("stores admin botType and allowedSenderIds correctly", async () => {
      const db = createChainedMockD1();
      const config = {
        botId: "admin-bot-1",
        ownerId: "owner-1",
        name: "AdminBot",
        provider: "openai" as const,
        model: "gpt-4o",
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
        botType: "admin" as const,
        allowedSenderIds: ["user-123", "user-456"],
      };

      await configDb.upsertBot(db, config);

      const bindings = db._calls[0].bindings;
      expect(bindings[22]).toBe("admin");
      expect(bindings[23]).toBe(JSON.stringify(["user-123", "user-456"]));
      expect(bindings).toHaveLength(29);
    });
  });

  describe("softDeleteBot", () => {
    it("sets deleted_at on the bot scoped by ownerId", async () => {
      const db = createChainedMockD1();
      await configDb.softDeleteBot(db, "owner-1", "bot-1");

      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("deleted_at = datetime('now')");
      expect(db._calls[0].sql).toContain("owner_id = ?");
      expect(db._calls[0].bindings).toEqual(["bot-1", "owner-1"]);
    });
  });

  describe("restoreBot", () => {
    it("clears deleted_at and returns parsed BotConfig scoped by ownerId", async () => {
      const db = createChainedMockD1();
      db._setFirst(sampleBotRow);

      const result = await configDb.restoreBot(db, "owner-1", "bot-1");
      expect(result).not.toBeNull();
      expect(result!.botId).toBe("bot-1");
      expect(db._calls[0].sql).toContain("deleted_at = NULL");
      expect(db._calls[0].sql).toContain("deleted_at IS NOT NULL");
      expect(db._calls[0].sql).toContain("owner_id = ?");
      expect(db._calls[0].sql).toContain("RETURNING *");
      expect(db._calls[0].bindings).toEqual(["bot-1", "owner-1"]);
    });

    it("returns null when bot not found", async () => {
      const db = createChainedMockD1();
      db._setFirst(null);

      const result = await configDb.restoreBot(db, "owner-1", "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("deleteBotPermanently", () => {
    it("deletes bot row scoped by ownerId", async () => {
      const db = createChainedMockD1();
      await configDb.deleteBotPermanently(db, "owner-1", "bot-1");

      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("DELETE FROM bots");
      expect(db._calls[0].sql).toContain("owner_id = ?");
      expect(db._calls[0].bindings).toEqual(["bot-1", "owner-1"]);
    });
  });

  describe("getAdminBot", () => {
    it("returns admin bot when found", async () => {
      const db = createChainedMockD1();
      db._setFirst({ ...sampleBotRow, bot_type: "admin", allowed_sender_ids: JSON.stringify(["user-1"]) });

      const result = await configDb.getAdminBot(db, "owner-1");
      expect(result).not.toBeNull();
      expect(result!.botType).toBe("admin");
      expect(result!.allowedSenderIds).toEqual(["user-1"]);

      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("bot_type = 'admin'");
      expect(db._calls[0].sql).toContain("deleted_at IS NULL");
      expect(db._calls[0].bindings).toEqual(["owner-1"]);
    });

    it("returns null when no admin bot exists", async () => {
      const db = createChainedMockD1();
      db._setFirst(null);

      const result = await configDb.getAdminBot(db, "owner-1");
      expect(result).toBeNull();
    });
  });

  describe("rowToBotConfig — botType and allowedSenderIds", () => {
    it("parses botType and allowedSenderIds from row", async () => {
      const db = createChainedMockD1();
      db._setFirst({
        ...sampleBotRow,
        bot_type: "admin",
        allowed_sender_ids: JSON.stringify(["sender-a", "sender-b"]),
      });

      const result = await configDb.getBot(db, "owner-1", "bot-1");
      expect(result!.botType).toBe("admin");
      expect(result!.allowedSenderIds).toEqual(["sender-a", "sender-b"]);
    });

    it("defaults botType to 'normal' when null", async () => {
      const db = createChainedMockD1();
      db._setFirst({
        ...sampleBotRow,
        bot_type: null,
        allowed_sender_ids: null,
      });

      const result = await configDb.getBot(db, "owner-1", "bot-1");
      expect(result!.botType).toBe("normal");
      expect(result!.allowedSenderIds).toEqual([]);
    });

    it("defaults allowedSenderIds to [] for empty string", async () => {
      const db = createChainedMockD1();
      db._setFirst({
        ...sampleBotRow,
        bot_type: "normal",
        allowed_sender_ids: "",
      });

      const result = await configDb.getBot(db, "owner-1", "bot-1");
      expect(result!.allowedSenderIds).toEqual([]);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — User Keys
// ---------------------------------------------------------------------------

describe("config DAL — user keys", () => {
  describe("getUserKeys", () => {
    it("returns parsed UserKeys when found", async () => {
      const db = createChainedMockD1();
      db._setFirst({
        owner_id: "owner-1",
        openai: "sk-openai",
        anthropic: "sk-anthropic",
        google: null,
        deepseek: null,
        moonshot: null,
        brave: null,
        xai: null,
      });

      const result = await configDb.getUserKeys(db, "owner-1");
      expect(result).not.toBeNull();
      expect(result!.openai).toBe("sk-openai");
      expect(result!.anthropic).toBe("sk-anthropic");
      expect(result!.google).toBeUndefined();
    });

    it("returns null when not found", async () => {
      const db = createChainedMockD1();
      db._setFirst(null);

      const result = await configDb.getUserKeys(db, "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("upsertUserKeys", () => {
    it("binds all key fields", async () => {
      const db = createChainedMockD1();
      const keys = {
        openai: "sk-openai",
        anthropic: "sk-anthropic",
      };

      await configDb.upsertUserKeys(db, "owner-1", keys);

      expect(db._calls).toHaveLength(1);
      const bindings = db._calls[0].bindings;
      expect(bindings[0]).toBe("owner-1");
      expect(bindings[1]).toBe("sk-openai");
      expect(bindings[2]).toBe("sk-anthropic");
      // Remaining keys are null
      expect(bindings[3]).toBeNull(); // google
      expect(bindings[4]).toBeNull(); // deepseek
      expect(bindings[5]).toBeNull(); // moonshot
      expect(bindings[6]).toBeNull(); // brave
      expect(bindings[7]).toBeNull(); // xai
      expect(bindings[8]).toBeNull(); // elevenlabs
      expect(bindings[9]).toBeNull(); // fish
      expect(db._calls[0].sql).toContain("ON CONFLICT(owner_id) DO UPDATE");
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — Groups
// ---------------------------------------------------------------------------

describe("config DAL — groups", () => {
  describe("getGroup", () => {
    it("returns parsed GroupConfig when found", async () => {
      const db = createChainedMockD1();
      db._setFirst(sampleGroupRow);

      const result = await configDb.getGroup(db, "owner-1", "group-1");
      expect(result).not.toBeNull();
      expect(result!.groupId).toBe("group-1");
      expect(result!.name).toBe("TestGroup");
      expect(result!.botIds).toEqual(["bot-1", "bot-2"]);
      expect(result!.note).toBe("I am the user");
      expect(result!.orchestratorProvider).toBe("anthropic");
      expect(result!.orchestratorModel).toBe("claude-sonnet-4-6");
    });

    it("returns null when not found", async () => {
      const db = createChainedMockD1();
      db._setFirst(null);

      const result = await configDb.getGroup(db, "owner-1", "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("listGroups", () => {
    it("returns array of parsed GroupConfigs", async () => {
      const db = createChainedMockD1();
      db._setAll([
        sampleGroupRow,
        { ...sampleGroupRow, group_id: "group-2", name: "Group2" },
      ]);

      const results = await configDb.listGroups(db, "owner-1");
      expect(results).toHaveLength(2);
      expect(results[0].groupId).toBe("group-1");
      expect(results[1].groupId).toBe("group-2");
    });

    it("returns empty array when no groups", async () => {
      const db = createChainedMockD1();
      db._setAll([]);

      const results = await configDb.listGroups(db, "owner-1");
      expect(results).toEqual([]);
    });
  });

  describe("upsertGroup", () => {
    it("serializes botIds as JSON and binds all fields", async () => {
      const db = createChainedMockD1();
      const config = {
        groupId: "group-1",
        ownerId: "owner-1",
        name: "TestGroup",
        botIds: ["bot-1", "bot-2"],
        note: "I am the user",
        orchestratorProvider: "anthropic" as const,
        orchestratorModel: "claude-sonnet-4-6",
      };

      await configDb.upsertGroup(db, config);

      expect(db._calls).toHaveLength(1);
      const bindings = db._calls[0].bindings;
      expect(bindings[0]).toBe("group-1");
      expect(bindings[1]).toBe("owner-1");
      expect(bindings[2]).toBe("TestGroup");
      expect(bindings[3]).toBe(JSON.stringify(["bot-1", "bot-2"]));
      expect(bindings[4]).toBe("I am the user");
      expect(bindings[5]).toBe("anthropic");
      expect(bindings[6]).toBe("claude-sonnet-4-6");
      expect(db._calls[0].sql).toContain("ON CONFLICT(group_id) DO UPDATE");
    });
  });

  describe("deleteGroup", () => {
    it("deletes group row", async () => {
      const db = createChainedMockD1();
      await configDb.deleteGroup(db, "owner-1", "group-1");

      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("DELETE FROM groups");
      expect(db._calls[0].sql).toContain("AND owner_id = ?");
      expect(db._calls[0].bindings).toEqual(["group-1", "owner-1"]);
    });
  });

  describe("findGroupForBot", () => {
    it("returns the matching group via json_each SQL", async () => {
      const db = createChainedMockD1();
      db._setFirst(sampleGroupRow);

      const result = await configDb.findGroupForBot(db, "owner-1", "bot-1");
      expect(result).not.toBeNull();
      expect(result!.groupId).toBe("group-1");
      expect(db._calls[0].sql).toContain("json_each");
      expect(db._calls[0].bindings).toEqual(["owner-1", "owner-1", "bot-1"]);
    });

    it("returns null when no match", async () => {
      const db = createChainedMockD1();
      db._setFirst(null);

      const result = await configDb.findGroupForBot(db, "owner-1", "bot-99");
      expect(result).toBeNull();
    });
  });

  describe("findAllGroupsForBot", () => {
    it("returns matching groups via json_each SQL", async () => {
      const db = createChainedMockD1();
      db._setAll([
        sampleGroupRow,
        { ...sampleGroupRow, group_id: "group-2", bot_ids: JSON.stringify(["bot-1", "bot-3"]) },
      ]);

      const results = await configDb.findAllGroupsForBot(db, "owner-1", "bot-1");
      expect(results).toHaveLength(2);
      expect(results[0].groupId).toBe("group-1");
      expect(results[1].groupId).toBe("group-2");
      expect(db._calls[0].sql).toContain("json_each");
      expect(db._calls[0].bindings).toEqual(["owner-1", "owner-1", "bot-1"]);
    });

    it("returns empty array when no match", async () => {
      const db = createChainedMockD1();
      db._setAll([]);

      const results = await configDb.findAllGroupsForBot(db, "owner-1", "bot-99");
      expect(results).toEqual([]);
    });
  });

  describe("updateGroupChat", () => {
    it("binds channel, chatId, groupId in correct order", async () => {
      const db = createChainedMockD1();
      await configDb.updateGroupChat(db, "owner-1", "group-1", "telegram", "chat-123");

      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("UPDATE groups SET channel = ?");
      expect(db._calls[0].sql).toContain("AND owner_id = ?");
      expect(db._calls[0].bindings).toEqual(["telegram", "chat-123", "group-1", "owner-1"]);
    });
  });

});

// ---------------------------------------------------------------------------
// Tests — Token Mappings
// ---------------------------------------------------------------------------

describe("config DAL — token mappings", () => {
  describe("getTokenMapping", () => {
    it("returns parsed TokenMapping when found", async () => {
      const db = createChainedMockD1();
      db._setFirst({ owner_id: "owner-1", bot_id: "bot-1" });

      const result = await configDb.getTokenMapping(db, "telegram", "tg-token-123");
      expect(result).not.toBeNull();
      expect(result!.ownerId).toBe("owner-1");
      expect(result!.botId).toBe("bot-1");
      expect(db._calls[0].bindings).toEqual(["telegram", "tg-token-123"]);
    });

    it("returns null when not found", async () => {
      const db = createChainedMockD1();
      db._setFirst(null);

      const result = await configDb.getTokenMapping(db, "telegram", "nonexistent");
      expect(result).toBeNull();
    });
  });

  describe("upsertTokenMapping", () => {
    it("binds channel, token, ownerId, botId", async () => {
      const db = createChainedMockD1();
      await configDb.upsertTokenMapping(db, "telegram", "tg-token-123", {
        ownerId: "owner-1",
        botId: "bot-1",
      });

      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].bindings).toEqual(["telegram", "tg-token-123", "owner-1", "bot-1"]);
      expect(db._calls[0].sql).toContain("ON CONFLICT(channel, token) DO UPDATE");
    });
  });

  describe("deleteTokenMapping", () => {
    it("deletes by channel and token", async () => {
      const db = createChainedMockD1();
      await configDb.deleteTokenMapping(db, "telegram", "tg-token-123");

      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("DELETE FROM channel_tokens");
      expect(db._calls[0].bindings).toEqual(["telegram", "tg-token-123"]);
    });
  });

  describe("deleteTokenMappingsForBot", () => {
    it("deletes all tokens for a bot", async () => {
      const db = createChainedMockD1();
      await configDb.deleteTokenMappingsForBot(db, "owner-1", "bot-1");

      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("DELETE FROM channel_tokens WHERE bot_id = ?");
      expect(db._calls[0].sql).toContain("AND owner_id = ?");
      expect(db._calls[0].bindings).toEqual(["bot-1", "owner-1"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — Channel Identity
// ---------------------------------------------------------------------------

describe("config DAL — channel identity", () => {
  describe("updateChannelIdentity", () => {
    it("uses json_set for atomic update without read-modify-write", async () => {
      const db = createChainedMockD1();
      await configDb.updateChannelIdentity(db, "owner-1", "bot-1", "telegram", {
        channelUsername: "mybot",
        channelUserId: "12345",
      });

      // Should be a single UPDATE call (no SELECT/getBot)
      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("UPDATE bots SET channels = json_set");
      expect(db._calls[0].sql).toContain("channelUsername");
      expect(db._calls[0].sql).toContain("channelUserId");
      expect(db._calls[0].sql).toContain("json_extract(channels");
      // Bindings: channel x2 for each field, values, botId, ownerId, channel for WHERE
      expect(db._calls[0].bindings).toEqual([
        "telegram", "mybot", "telegram", "12345",
        "bot-1", "owner-1", "telegram",
      ]);
    });

    it("skips update when no identity fields provided", async () => {
      const db = createChainedMockD1();
      await configDb.updateChannelIdentity(db, "owner-1", "bot-1", "telegram", {});

      expect(db._calls).toHaveLength(0);
    });

    it("updates only channelUsername when channelUserId not provided", async () => {
      const db = createChainedMockD1();
      await configDb.updateChannelIdentity(db, "owner-1", "bot-1", "telegram", {
        channelUsername: "mybot",
      });

      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("channelUsername");
      expect(db._calls[0].sql).not.toContain("channelUserId");
      expect(db._calls[0].bindings).toEqual(["telegram", "mybot", "bot-1", "owner-1", "telegram"]);
    });
  });
});

// ---------------------------------------------------------------------------
// Tests — Skill Secrets
// ---------------------------------------------------------------------------

describe("config DAL — skill secrets", () => {
  describe("getSkillSecrets", () => {
    it("returns empty object when no secrets exist", async () => {
      const db = createChainedMockD1();
      db._setAll([]);

      const result = await configDb.getSkillSecrets(db, "owner-1");
      expect(result).toEqual({});
      expect(db._calls[0].sql).toContain("SELECT skill_name, env_vars FROM skill_secrets");
      expect(db._calls[0].bindings).toEqual(["owner-1"]);
    });

    it("returns all secrets for owner, parsed from JSON", async () => {
      const db = createChainedMockD1();
      db._setAll([
        { skill_name: "weather", env_vars: JSON.stringify({ WEATHER_API_KEY: "abc123" }) },
        { skill_name: "github", env_vars: JSON.stringify({ GITHUB_TOKEN: "ghp_xxx", GITHUB_ORG: "myorg" }) },
      ]);

      const result = await configDb.getSkillSecrets(db, "owner-1");
      expect(result).toEqual({
        weather: { WEATHER_API_KEY: "abc123" },
        github: { GITHUB_TOKEN: "ghp_xxx", GITHUB_ORG: "myorg" },
      });
    });

    it("skips malformed JSON rows", async () => {
      const db = createChainedMockD1();
      db._setAll([
        { skill_name: "good", env_vars: JSON.stringify({ KEY: "val" }) },
        { skill_name: "bad", env_vars: "not-json{" },
      ]);

      const result = await configDb.getSkillSecrets(db, "owner-1");
      expect(result).toEqual({ good: { KEY: "val" } });
    });
  });

  describe("upsertSkillSecret", () => {
    it("calls INSERT...ON CONFLICT with correct SQL and bindings", async () => {
      const db = createChainedMockD1();
      await configDb.upsertSkillSecret(db, "owner-1", "weather", { WEATHER_API_KEY: "abc123" });

      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("INSERT INTO skill_secrets");
      expect(db._calls[0].sql).toContain("ON CONFLICT(owner_id, skill_name) DO UPDATE");
      expect(db._calls[0].sql).toContain("excluded.env_vars");
      const serialized = JSON.stringify({ WEATHER_API_KEY: "abc123" });
      expect(db._calls[0].bindings).toEqual(["owner-1", "weather", serialized]);
    });
  });

  describe("deleteSkillSecret", () => {
    it("calls DELETE with correct params", async () => {
      const db = createChainedMockD1();
      await configDb.deleteSkillSecret(db, "owner-1", "weather");

      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("DELETE FROM skill_secrets");
      expect(db._calls[0].bindings).toEqual(["owner-1", "weather"]);
    });
  });

  describe("getSkillSecretsForBot", () => {
    it("returns empty when enabledSkills is empty and no botId", async () => {
      const db = createChainedMockD1();
      const result = await configDb.getSkillSecretsForBot(db, "owner-1", []);
      expect(result).toEqual({ flat: {}, perSkill: {} });
      // Should not even query the database
      expect(db._calls).toHaveLength(0);
    });

    it("filters by enabledSkills and returns both flat and perSkill", async () => {
      const db = createChainedMockD1();
      db._setAll([
        { skill_name: "weather", env_vars: JSON.stringify({ WEATHER_KEY: "w123" }) },
        { skill_name: "github", env_vars: JSON.stringify({ GH_TOKEN: "ghp_abc" }) },
        { skill_name: "slack", env_vars: JSON.stringify({ SLACK_TOKEN: "xoxb-xxx" }) },
      ]);

      // Only enable weather and slack
      const result = await configDb.getSkillSecretsForBot(db, "owner-1", ["weather", "slack"]);
      expect(result.flat).toEqual({
        WEATHER_KEY: "w123",
        SLACK_TOKEN: "xoxb-xxx",
      });
      expect(result.perSkill).toEqual({
        weather: { WEATHER_KEY: "w123" },
        slack: { SLACK_TOKEN: "xoxb-xxx" },
      });
      // github should not be included
      expect(result.flat).not.toHaveProperty("GH_TOKEN");
    });

    it("returns empty when enabled skills have no secrets", async () => {
      const db = createChainedMockD1();
      db._setAll([
        { skill_name: "weather", env_vars: JSON.stringify({ WEATHER_KEY: "w123" }) },
      ]);

      const result = await configDb.getSkillSecretsForBot(db, "owner-1", ["nonexistent"]);
      expect(result).toEqual({ flat: {}, perSkill: {} });
    });

    it("loads secrets for all skills in enabledSkills (bundled + installed unified)", async () => {
      const db = createChainedMockD1();
      db._setAll([
        { skill_name: "weather", env_vars: JSON.stringify({ WEATHER_KEY: "w123" }) },
        { skill_name: "firecrawl", env_vars: JSON.stringify({ FIRECRAWL_API_KEY: "fc-xxx" }) },
      ]);

      // enabledSkills now includes both bundled and installed skill names
      const result = await configDb.getSkillSecretsForBot(db, "owner-1", ["weather", "firecrawl"]);
      expect(result.flat).toEqual({
        WEATHER_KEY: "w123",
        FIRECRAWL_API_KEY: "fc-xxx",
      });
      expect(result.perSkill).toEqual({
        weather: { WEATHER_KEY: "w123" },
        firecrawl: { FIRECRAWL_API_KEY: "fc-xxx" },
      });
    });
  });
});


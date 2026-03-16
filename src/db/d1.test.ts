import { describe, it, expect, vi, beforeEach } from "vitest";
import * as d1 from "./d1";
import type { ChatContext } from "./d1";

/**
 * Minimal D1Database mock that tracks prepared statements.
 * Each test configures expected results before calling d1 functions.
 */
function createMockD1() {
  let firstResult: any = null;
  let allResults: any[] = [];
  let batchResults: any[] = [];

  const mockStmt = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn(async () => firstResult),
    all: vi.fn(async () => ({ results: allResults })),
    run: vi.fn(async () => ({ success: true, meta: { last_row_id: 1 } })),
  };

  const db = {
    prepare: vi.fn(() => ({ ...mockStmt, bind: vi.fn().mockReturnValue({ ...mockStmt }) })),
    batch: vi.fn(async () => batchResults),
    _setFirst(val: any) { firstResult = val; },
    _setAll(val: any[]) { allResults = val; },
    _setBatch(val: any[]) { batchResults = val; },
    _mockStmt: mockStmt,
  } as unknown as D1Database & {
    _setFirst: (val: any) => void;
    _setAll: (val: any[]) => void;
    _setBatch: (val: any[]) => void;
    _mockStmt: typeof mockStmt;
  };

  return db;
}

// A more detailed mock that chains properly
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
      async run() { return { success: true, meta: { last_row_id: 1 } }; },
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

describe("d1 data access layer", () => {
  const ctx: ChatContext = {
    channel: "telegram",
    chatId: "123",
  };

  describe("getOrCreateSession", () => {
    it("returns existing session if found", async () => {
      const db = createChainedMockD1();
      db._setFirst({ id: "telegram-123-20260224-120000-abcd" });
      const result = await d1.getOrCreateSession(db, ctx);
      expect(result).toBe("telegram-123-20260224-120000-abcd");
    });

    it("creates new session if none found", async () => {
      const db = createChainedMockD1();
      let callCount = 0;
      const origPrepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => {
        const stmt = origPrepare(sql);
        const origFirst = stmt.first.bind(stmt);
        stmt.first = async () => {
          callCount++;
          // First call (SELECT) returns null, rest are INSERT
          if (callCount === 1) return null;
          return origFirst();
        };
        return stmt;
      };
      const result = await d1.getOrCreateSession(db, ctx);
      expect(result).toMatch(/^telegram-123-/);
    });

    it("scopes lookup by bot_id for private chat (botId set, no groupId)", async () => {
      const db = createChainedMockD1();
      db._setFirst({ id: "sess-bot-a" });
      const ctxWithBot: ChatContext = { channel: "telegram", chatId: "123", botId: "bot-a" };
      await d1.getOrCreateSession(db, ctxWithBot);
      const selectCall = db._calls.find(c => c.sql.includes("SELECT"));
      expect(selectCall!.sql).toContain("bot_id = ?");
      expect(selectCall!.bindings).toContain("bot-a");
    });

    it("does NOT scope by bot_id for group chat (groupId set)", async () => {
      const db = createChainedMockD1();
      db._setFirst({ id: "sess-group" });
      const ctxGroup: ChatContext = { channel: "telegram", chatId: "-100123", groupId: "grp-1", botId: "bot-a" };
      await d1.getOrCreateSession(db, ctxGroup);
      const selectCall = db._calls.find(c => c.sql.includes("SELECT"));
      expect(selectCall!.sql).not.toContain("bot_id");
    });
  });

  describe("createNewSession", () => {
    it("returns session ID with correct format (includes random suffix)", async () => {
      const db = createChainedMockD1();
      const result = await d1.createNewSession(db, ctx);
      expect(result).toMatch(/^telegram-123-\d{8}-\d{6}-[a-z0-9]{4}$/);
    });

    it("writes bot_id to sessions table", async () => {
      const db = createChainedMockD1();
      const ctxWithBot: ChatContext = { channel: "telegram", chatId: "123", botId: "bot-a" };
      await d1.createNewSession(db, ctxWithBot);
      const insertCall = db._calls.find(c => c.sql.includes("INSERT"));
      expect(insertCall!.sql).toContain("bot_id");
      expect(insertCall!.bindings).toContain("bot-a");
    });

    it("writes null bot_id for group chat", async () => {
      const db = createChainedMockD1();
      const ctxGroup: ChatContext = { channel: "telegram", chatId: "-100123", groupId: "grp-1" };
      await d1.createNewSession(db, ctxGroup);
      const insertCall = db._calls.find(c => c.sql.includes("INSERT"));
      expect(insertCall!.bindings).toContain(null);
    });
  });

  describe("persistMessages", () => {
    it("batches insert statements (filters out tool messages)", async () => {
      const db = createChainedMockD1();
      const batchSpy = vi.spyOn(db as any, "batch");
      await d1.persistMessages(db, "sess-1", [
        { role: "assistant", content: "Hello!", botId: "bot-1", requestId: "req-1" },
        { role: "tool", content: "result", toolCallId: "tc-1", toolName: "search" },
        { role: "assistant", content: "World!", botId: "bot-1", requestId: "req-1" },
      ]);
      expect(batchSpy).toHaveBeenCalledTimes(1);
      // Only 2 assistant messages, tool is filtered out
      expect(batchSpy.mock.calls[0][0]).toHaveLength(2);
    });

    it("skips batch for empty messages", async () => {
      const db = createChainedMockD1();
      const batchSpy = vi.spyOn(db as any, "batch");
      await d1.persistMessages(db, "sess-1", []);
      expect(batchSpy).not.toHaveBeenCalled();
    });

    it("persists assistant messages with attachments column", async () => {
      const db = createChainedMockD1();
      const batchSpy = vi.spyOn(db as any, "batch");
      await d1.persistMessages(db, "sess-1", [
        {
          role: "assistant",
          content: "Here is the photo\n[image: cat]",
          botId: "bot-1",
          attachments: '[{"r2Key":"media/bot-1/123.png","mediaType":"image/png"}]',
          requestId: "req-img-1",
        },
      ]);
      expect(batchSpy).toHaveBeenCalledTimes(1);
      const call = db._calls.find(c => c.sql.includes("INSERT"));
      expect(call!.sql).toContain("attachments");
      expect(call!.bindings).toContain('[{"r2Key":"media/bot-1/123.png","mediaType":"image/png"}]');
      expect(call!.bindings).toContain("Here is the photo\n[image: cat]");
    });

    it("skips batch when all messages are tool results", async () => {
      const db = createChainedMockD1();
      const batchSpy = vi.spyOn(db as any, "batch");
      await d1.persistMessages(db, "sess-1", [
        { role: "tool", content: "result", toolCallId: "tc-1", toolName: "search" },
      ]);
      expect(batchSpy).not.toHaveBeenCalled();
    });
  });

  describe("getConversationHistory", () => {
    it("returns messages in chronological order (reversed)", async () => {
      const db = createChainedMockD1();
      db._setAll([
        { role: "assistant", content: "Second", bot_id: "bot-1", tool_calls: null, created_at: "2026-01-01" },
        { role: "user", content: "First", bot_id: null, tool_calls: null, created_at: "2026-01-01" },
      ]);
      const rows = await d1.getConversationHistory(db, "sess-1");
      // Results from DB come in DESC order, function reverses them
      expect(rows[0].content).toBe("First");
      expect(rows[1].content).toBe("Second");
    });

    it("includes tool_calls field", async () => {
      const db = createChainedMockD1();
      db._setAll([
        { role: "assistant", content: "Here is the image", bot_id: "bot-1", tool_calls: JSON.stringify([{ toolCallId: "tc-1", toolName: "image_generate", input: {} }]), created_at: "2026-01-01" },
      ]);
      const rows = await d1.getConversationHistory(db, "sess-1");
      expect(rows[0].tool_calls).toContain("image_generate");
    });

    it("binds sessionId and limit", async () => {
      const db = createChainedMockD1();
      db._setAll([]);
      await d1.getConversationHistory(db, "sess-1", 100);
      const sql = db._calls[0].sql;
      expect(sql).not.toContain("id <= ?");
      expect(db._calls[0].bindings).toEqual(["sess-1", 100]);
    });
  });

  describe("getRecentMessages", () => {
    it("returns reversed recent messages", async () => {
      const db = createChainedMockD1();
      db._setAll([
        { role: "assistant", content: "B", bot_id: "bot-1", created_at: "2026-01-01" },
        { role: "user", content: "A", bot_id: null, created_at: "2026-01-01" },
      ]);
      const rows = await d1.getRecentMessages(db, "sess-1", 10);
      expect(rows).toHaveLength(2);
      expect(rows[0].content).toBe("A");
    });
  });

  describe("cleanupRequestTraceIndex", () => {
    it("deletes expired request trace indexes using log_date retention", async () => {
      const db = createChainedMockD1();
      await d1.cleanupRequestTraceIndex(db, 90);
      const deleteCall = db._calls.find((c) =>
        c.sql.includes("DELETE FROM request_trace_index")
      );
      expect(deleteCall).toBeDefined();
      expect(deleteCall!.sql).toContain("log_date < date('now', '-' || ? || ' days')");
      expect(deleteCall!.bindings).toEqual([90]);
    });
  });

  describe("persistUserMessage", () => {
    it("inserts a user message with requestId and returns last_row_id", async () => {
      const db = createChainedMockD1();
      const id = await d1.persistUserMessage(db, "sess-1", "Hello", "req-123");
      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].bindings).toContain("req-123");
      expect(id).toBe(1);
    });

    it("uses null for requestId when not provided", async () => {
      const db = createChainedMockD1();
      await d1.persistUserMessage(db, "sess-1", "Hello");
      // bindings: [sessionId, content, attachmentsJson(null), requestId(null)]
      expect(db._calls[0].bindings[3]).toBeNull();
    });

    it("persists attachments as JSON when provided", async () => {
      const db = createChainedMockD1();
      const attachments = [
        { id: "a1b2c3d4", r2Key: "media/bot-1/123_abc.jpeg", mediaType: "image/jpeg" },
        { id: "e5f6g7h8", r2Key: "media/bot-1/123_def.png", mediaType: "image/png" },
      ];
      await d1.persistUserMessage(db, "sess-1", "Look at this", "req-1", attachments);
      expect(db._calls[0].sql).toContain("attachments");
      // bindings: [sessionId, content, attachmentsJson, requestId]
      const attachmentsJson = db._calls[0].bindings[2];
      expect(JSON.parse(attachmentsJson)).toEqual(attachments);
    });

    it("stores null attachments when none provided", async () => {
      const db = createChainedMockD1();
      await d1.persistUserMessage(db, "sess-1", "Hello", "req-1");
      // bindings: [sessionId, content, attachmentsJson(null), requestId]
      expect(db._calls[0].bindings[2]).toBeNull();
    });

    it("stores null attachments for empty array", async () => {
      const db = createChainedMockD1();
      await d1.persistUserMessage(db, "sess-1", "Hello", "req-1", []);
      expect(db._calls[0].bindings[2]).toBeNull();
    });
  });

  describe("getSessionLastConsolidated", () => {
    it("returns last_consolidated value for session+bot pair", async () => {
      const db = createChainedMockD1();
      db._setFirst({ last_consolidated: 100 });
      const val = await d1.getSessionLastConsolidated(db, "sess-1", "bot-1");
      expect(val).toBe(100);
    });

    it("returns 0 when no consolidation state found", async () => {
      const db = createChainedMockD1();
      db._setFirst(null);
      const val = await d1.getSessionLastConsolidated(db, "sess-1", "bot-1");
      expect(val).toBe(0);
    });
  });

  describe("getMessagesForConsolidation", () => {
    it("returns messages after given ID filtered by botId", async () => {
      const db = createChainedMockD1();
      db._setAll([
        { id: 5, session_id: "sess-1", role: "user", content: "Hi", bot_id: null, tool_calls: null, created_at: "2026-01-01" },
      ]);
      const msgs = await d1.getMessagesForConsolidation(db, "sess-1", "bot-1", 3);
      expect(msgs).toHaveLength(1);
      expect(msgs[0].id).toBe(5);
    });
  });

  describe("updateSessionConsolidated", () => {
    it("calls run with correct params (UPSERT)", async () => {
      const db = createChainedMockD1();
      await d1.updateSessionConsolidated(db, "sess-1", "bot-1", 50);
      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].bindings).toEqual(["sess-1", "bot-1", 50]);
    });
  });

  describe("ensureSessionExists", () => {
    it("does nothing if session exists", async () => {
      const db = createChainedMockD1();
      db._setFirst({ id: "sess-1" });
      await d1.ensureSessionExists(db, ctx, "sess-1");
      // Only 1 call (SELECT), no INSERT
      expect(db._calls).toHaveLength(1);
    });

    it("creates session if not found", async () => {
      const db = createChainedMockD1();
      let callCount = 0;
      const origPrepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => {
        const stmt = origPrepare(sql);
        const origFirst = stmt.first.bind(stmt);
        stmt.first = async () => {
          callCount++;
          if (callCount === 1) return null;
          return origFirst();
        };
        return stmt;
      };
      await d1.ensureSessionExists(db, ctx, "cron-123");
      // Should have 2 calls: SELECT + INSERT
      expect(db._calls).toHaveLength(2);
    });

    it("writes bot_id when creating new session", async () => {
      const db = createChainedMockD1();
      let callCount = 0;
      const origPrepare = db.prepare.bind(db);
      (db as any).prepare = (sql: string) => {
        const stmt = origPrepare(sql);
        const origFirst = stmt.first.bind(stmt);
        stmt.first = async () => {
          callCount++;
          if (callCount === 1) return null;
          return origFirst();
        };
        return stmt;
      };
      const ctxWithBot: ChatContext = { channel: "telegram", chatId: "123", botId: "bot-a" };
      await d1.ensureSessionExists(db, ctxWithBot, "cron-123");
      const insertCall = db._calls.find(c => c.sql.includes("INSERT"));
      expect(insertCall!.sql).toContain("bot_id");
      expect(insertCall!.bindings).toContain("bot-a");
    });
  });

  describe("countSessionMessages", () => {
    it("returns count from D1", async () => {
      const db = createChainedMockD1();
      db._setFirst({ cnt: 42 });
      const count = await d1.countSessionMessages(db, "sess-1", "bot-1");
      expect(count).toBe(42);
    });

    it("returns 0 when no rows found", async () => {
      const db = createChainedMockD1();
      db._setFirst(null);
      const count = await d1.countSessionMessages(db, "sess-1", "bot-1");
      expect(count).toBe(0);
    });
  });

  describe("deleteConsolidatedMessages", () => {
    it("deletes bot's own assistant messages with 30-day retention", async () => {
      const db = createChainedMockD1();
      await d1.deleteConsolidatedMessages(db, "sess-1", "bot-1", 100);
      // First call: delete this bot's assistant messages
      const assistantDelete = db._calls.find(c =>
        c.sql.includes("DELETE FROM messages") && c.sql.includes("bot_id = ?") && !c.sql.includes("IS NULL")
      );
      expect(assistantDelete).toBeDefined();
      expect(assistantDelete!.bindings).toEqual(["sess-1", 100, "bot-1", d1.MESSAGE_RETENTION_DAYS]);
      // Must include retention condition (parameterized)
      expect(assistantDelete!.sql).toContain("created_at < datetime('now'");
      expect(assistantDelete!.sql).toContain("|| ? || ' days'");
    });

    it("queries min consolidation boundary before deleting user messages", async () => {
      const db = createChainedMockD1();
      // Mock: MIN(last_consolidated) returns null → no user message deletion
      db._setFirst(null);
      await d1.deleteConsolidatedMessages(db, "sess-1", "bot-1", 100);
      // Should have queried consolidation_state for min boundary
      const minQuery = db._calls.find(c =>
        c.sql.includes("MIN(last_consolidated)")
      );
      expect(minQuery).toBeDefined();
      // No user message DELETE should have been issued (safeBoundary is null)
      const userDelete = db._calls.find(c =>
        c.sql.includes("bot_id IS NULL")
      );
      expect(userDelete).toBeUndefined();
    });

    it("includes retention condition when deleting user messages", async () => {
      const db = createChainedMockD1();
      // Mock: MIN(last_consolidated) returns a positive value → user deletion proceeds
      db._setFirst({ min_boundary: 50 });
      await d1.deleteConsolidatedMessages(db, "sess-1", "bot-1", 100);
      const userDelete = db._calls.find(c =>
        c.sql.includes("bot_id IS NULL") && c.sql.includes("DELETE")
      );
      expect(userDelete).toBeDefined();
      expect(userDelete!.sql).toContain("created_at < datetime('now'");
      expect(userDelete!.sql).toContain("|| ? || ' days'");
    });
  });

  describe("deleteBotData", () => {
    it("deletes consolidation state for the bot", async () => {
      const db = createChainedMockD1();
      await d1.deleteBotData(db, "bot-1");
      // Should have calls for: SELECT solo sessions, DELETE consolidation_state, DELETE orphaned sessions
      const consolidationDelete = db._calls.find(c =>
        c.sql.includes("DELETE FROM consolidation_state")
      );
      expect(consolidationDelete).toBeDefined();
      expect(consolidationDelete!.bindings).toEqual(["bot-1"]);
    });

    it("cleans up orphaned sessions (calls prepare with correct SQL)", async () => {
      const db = createChainedMockD1();
      const prepareSpy = vi.spyOn(db as any, "prepare");
      await d1.deleteBotData(db, "bot-1");
      const sqlCalls = prepareSpy.mock.calls.map(c => c[0] as string);
      const orphanCleanup = sqlCalls.find(sql =>
        sql.includes("DELETE FROM sessions WHERE id NOT IN")
      );
      expect(orphanCleanup).toBeDefined();
    });

    it("cleans up orphaned consolidation_state after session deletion", async () => {
      const db = createChainedMockD1();
      const prepareSpy = vi.spyOn(db as any, "prepare");
      await d1.deleteBotData(db, "bot-1");
      const sqlCalls = prepareSpy.mock.calls.map(c => c[0] as string);
      const orphanCsCleanup = sqlCalls.find(sql =>
        sql.includes("DELETE FROM consolidation_state WHERE session_id NOT IN")
      );
      expect(orphanCsCleanup).toBeDefined();
    });
  });

  describe("reply hints", () => {
    it("insertReplyHint calls INSERT with correct params", async () => {
      const db = createMockD1();
      await d1.insertReplyHint(db, {
        channel: "telegram",
        chatId: "chat-1",
        messageDate: 1700000000,
        userId: "user-1",
        replyToName: "Alice",
        replyToText: "Hello there",
      });
      expect(db.prepare).toHaveBeenCalled();
      const sql = (db.prepare as any).mock.calls[0][0];
      expect(sql).toContain("INSERT");
      expect(sql).toContain("reply_hints");
    });

    it("getReplyHint calls SELECT and returns result", async () => {
      const db = createMockD1();
      db._setFirst({ reply_to_name: "Alice", reply_to_text: "Hello" });
      const result = await d1.getReplyHint(db, {
        channel: "telegram",
        chatId: "chat-1",
        messageDate: 1700000000,
        userId: "user-1",
      });
      expect(result).toEqual({ replyToName: "Alice", replyToText: "Hello" });
    });

    it("getReplyHint returns null when not found", async () => {
      const db = createMockD1();
      db._setFirst(null);
      const result = await d1.getReplyHint(db, {
        channel: "telegram",
        chatId: "chat-1",
        messageDate: 1700000000,
        userId: "user-1",
      });
      expect(result).toBeNull();
    });
  });
});

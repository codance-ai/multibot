import { describe, it, expect, vi } from "vitest";
import * as d1 from "./d1";

/**
 * Chained D1Database mock that tracks prepared statements and their bindings.
 * Same pattern as d1.test.ts — each test configures expected results before calling.
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
      async run() { return { success: true }; },
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

describe("d1 memory data access", () => {
  const botId = "bot-test-123";

  describe("getMemory", () => {
    it("returns empty string when no memory exists", async () => {
      const db = createChainedMockD1();
      db._setFirst(null);
      const result = await d1.getMemory(db, botId);
      expect(result).toBe("");
    });

    it("returns content when memory exists", async () => {
      const db = createChainedMockD1();
      db._setFirst({ content: "# User\n- Name: Alice" });
      const result = await d1.getMemory(db, botId);
      expect(result).toBe("# User\n- Name: Alice");
    });

    it("queries bot_memory table with correct botId", async () => {
      const db = createChainedMockD1();
      db._setFirst(null);
      await d1.getMemory(db, botId);
      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("SELECT content FROM bot_memory");
      expect(db._calls[0].bindings).toEqual([botId]);
    });
  });

  describe("upsertMemory", () => {
    it("calls INSERT ... ON CONFLICT DO UPDATE with correct params", async () => {
      const db = createChainedMockD1();
      await d1.upsertMemory(db, botId, "# Updated memory");
      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("INSERT INTO bot_memory");
      expect(db._calls[0].sql).toContain("ON CONFLICT");
      expect(db._calls[0].sql).toContain("DO UPDATE SET content");
      expect(db._calls[0].bindings).toEqual([botId, "# Updated memory"]);
    });

    it("includes updated_at in upsert", async () => {
      const db = createChainedMockD1();
      await d1.upsertMemory(db, botId, "test");
      expect(db._calls[0].sql).toContain("updated_at");
      expect(db._calls[0].sql).toContain("datetime('now')");
    });
  });

  describe("insertHistoryEntry", () => {
    it("inserts into memory_history_entries with correct params", async () => {
      const db = createChainedMockD1();
      await d1.insertHistoryEntry(db, botId, "[2026-03-01] User discussed cats");
      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("INSERT INTO memory_history_entries");
      expect(db._calls[0].bindings).toEqual([botId, "[2026-03-01] User discussed cats"]);
    });
  });

  describe("getHistoryEntries", () => {
    it("queries with ORDER BY and LIMIT and reverses results for chronological order", async () => {
      const db = createChainedMockD1();
      db._setAll([
        { id: 3, content: "[2026-03-03] Newer", created_at: "2026-03-03 10:00" },
        { id: 1, content: "[2026-03-01] Older", created_at: "2026-03-01 10:00" },
      ]);
      const results = await d1.getHistoryEntries(db, botId, 10);

      // Should reverse: oldest first
      expect(results[0].content).toBe("[2026-03-01] Older");
      expect(results[1].content).toBe("[2026-03-03] Newer");
    });

    it("uses default limit of 50 when not specified", async () => {
      const db = createChainedMockD1();
      db._setAll([]);
      await d1.getHistoryEntries(db, botId);
      expect(db._calls[0].bindings).toEqual([botId, 50]);
    });

    it("uses custom limit when specified", async () => {
      const db = createChainedMockD1();
      db._setAll([]);
      await d1.getHistoryEntries(db, botId, 20);
      expect(db._calls[0].bindings).toEqual([botId, 20]);
    });

    it("queries correct SQL with ORDER BY DESC and LIMIT", async () => {
      const db = createChainedMockD1();
      db._setAll([]);
      await d1.getHistoryEntries(db, botId);
      expect(db._calls[0].sql).toContain("ORDER BY created_at DESC");
      expect(db._calls[0].sql).toContain("LIMIT ?");
    });

    it("returns empty array when no entries exist", async () => {
      const db = createChainedMockD1();
      db._setAll([]);
      const results = await d1.getHistoryEntries(db, botId);
      expect(results).toEqual([]);
    });
  });

  describe("searchHistoryEntries", () => {
    it("uses LIKE pattern with wildcards", async () => {
      const db = createChainedMockD1();
      db._setAll([
        { id: 2, content: "[2026-03-02] User likes cats", created_at: "2026-03-02 10:00" },
      ]);
      const results = await d1.searchHistoryEntries(db, botId, "cats");
      expect(results).toHaveLength(1);
      expect(db._calls[0].sql).toContain("content LIKE ?");
      expect(db._calls[0].bindings).toEqual([botId, "%cats%", 50]);
    });

    it("uses custom limit when specified", async () => {
      const db = createChainedMockD1();
      db._setAll([]);
      await d1.searchHistoryEntries(db, botId, "dogs", 10);
      expect(db._calls[0].bindings).toEqual([botId, "%dogs%", 10]);
    });

    it("does not reverse results (keeps DESC order for relevance)", async () => {
      const db = createChainedMockD1();
      db._setAll([
        { id: 3, content: "Newer match", created_at: "2026-03-03 10:00" },
        { id: 1, content: "Older match", created_at: "2026-03-01 10:00" },
      ]);
      const results = await d1.searchHistoryEntries(db, botId, "match");
      // Should NOT be reversed (search results stay in DESC order)
      expect(results[0].content).toBe("Newer match");
      expect(results[1].content).toBe("Older match");
    });

    it("returns empty array when no matches", async () => {
      const db = createChainedMockD1();
      db._setAll([]);
      const results = await d1.searchHistoryEntries(db, botId, "nonexistent");
      expect(results).toEqual([]);
    });
  });

  describe("deleteExpiredHistoryEntries", () => {
    it("uses parameterized retention days with datetime concatenation", async () => {
      const db = createChainedMockD1();
      await d1.deleteExpiredHistoryEntries(db, botId, 90);
      expect(db._calls).toHaveLength(1);
      expect(db._calls[0].sql).toContain("DELETE FROM memory_history_entries");
      expect(db._calls[0].sql).toContain("datetime('now', '-' || ? || ' days')");
      expect(db._calls[0].bindings).toEqual([botId, 90]);
    });

    it("uses default retention of 180 days when not specified", async () => {
      const db = createChainedMockD1();
      await d1.deleteExpiredHistoryEntries(db, botId);
      expect(db._calls[0].bindings).toEqual([botId, 180]);
    });

    it("filters by bot_id", async () => {
      const db = createChainedMockD1();
      await d1.deleteExpiredHistoryEntries(db, botId);
      expect(db._calls[0].sql).toContain("bot_id = ?");
      expect(db._calls[0].bindings[0]).toBe(botId);
    });
  });

  describe("deleteMemoryForBot", () => {
    it("deletes from both bot_memory and memory_history_entries", async () => {
      const db = createChainedMockD1();
      const prepareSpy = vi.spyOn(db as any, "prepare");
      await d1.deleteMemoryForBot(db, botId);

      const sqlCalls = prepareSpy.mock.calls.map(c => c[0] as string);
      expect(sqlCalls).toHaveLength(2);

      const botMemoryDelete = sqlCalls.find(sql => sql.includes("DELETE FROM bot_memory"));
      expect(botMemoryDelete).toBeDefined();

      const historyDelete = sqlCalls.find(sql => sql.includes("DELETE FROM memory_history_entries"));
      expect(historyDelete).toBeDefined();
    });

    it("binds botId for both delete operations", async () => {
      const db = createChainedMockD1();
      await d1.deleteMemoryForBot(db, botId);

      // Both calls should bind the botId
      expect(db._calls).toHaveLength(2);
      expect(db._calls[0].bindings).toEqual([botId]);
      expect(db._calls[1].bindings).toEqual([botId]);
    });

    it("deletes bot_memory first, then history entries", async () => {
      const db = createChainedMockD1();
      await d1.deleteMemoryForBot(db, botId);

      expect(db._calls[0].sql).toContain("bot_memory");
      expect(db._calls[1].sql).toContain("memory_history_entries");
    });
  });

  describe("getBotsWithMemory", () => {
    it("queries bot_memory joined with bots", async () => {
      const db = createChainedMockD1();
      db._setAll([
        { bot_id: "bot-1", owner_id: "owner-1" },
        { bot_id: "bot-2", owner_id: "owner-2" },
      ]);

      const results = await d1.getBotsWithMemory(db);
      expect(results).toEqual([
        { bot_id: "bot-1", owner_id: "owner-1" },
        { bot_id: "bot-2", owner_id: "owner-2" },
      ]);
    });

    it("returns empty array when no bots have memory", async () => {
      const db = createChainedMockD1();
      db._setAll([]);

      const results = await d1.getBotsWithMemory(db);
      expect(results).toEqual([]);
    });
  });
});

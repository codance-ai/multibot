import { describe, it, expect, vi } from "vitest";
import { handleListSessions, handleListMessages, handleListLogs } from "./logs";
import type { Env } from "../config/schema";

function createMockD1() {
  let allResults: any[] = [];
  let firstResult: any = null;
  let allQueue: any[][] = [];
  let firstQueue: any[] = [];
  let lastBindings: any[] = [];

  const db: any = {
    prepare(sql: string) {
      return {
        _sql: sql,
        bind(...args: any[]) {
          lastBindings = args;
          return this;
        },
        async all() {
          if (allQueue.length > 0) {
            return { results: allQueue.shift()! };
          }
          return { results: allResults };
        },
        async first() {
          if (firstQueue.length > 0) {
            return firstQueue.shift()!;
          }
          return firstResult;
        },
        async run() {
          return { success: true };
        },
      };
    },
    _setAll(val: any[]) {
      allResults = val;
    },
    _setAllQueue(val: any[][]) {
      allQueue = [...val];
    },
    _setFirst(val: any) {
      firstResult = val;
    },
    _setFirstQueue(val: any[]) {
      firstQueue = [...val];
    },
    _getLastBindings() {
      return lastBindings;
    },
  };

  return db as D1Database & {
    _setAll: (val: any[]) => void;
    _setAllQueue: (val: any[][]) => void;
    _setFirst: (val: any) => void;
    _setFirstQueue: (val: any[]) => void;
    _getLastBindings: () => any[];
  };
}

function createMockBucket(pages: Array<{ cursor?: string; truncated?: boolean; objects: any[] }>, bodies: Record<string, unknown> = {}) {
  let callIndex = 0;

  return {
    async list() {
      const page = pages[Math.min(callIndex, pages.length - 1)] ?? {
        objects: [],
        truncated: false,
      };
      callIndex++;
      return {
        objects: page.objects,
        truncated: page.truncated ?? false,
        cursor: page.cursor,
      };
    },
    async get(key: string) {
      const body = bodies[key];
      if (body === undefined) return null;
      return {
        async text() {
          return JSON.stringify(body);
        },
      };
    },
  } as unknown as R2Bucket;
}

function createEnv(db: D1Database, extra: Partial<Env> = {}): Env {
  return {
    D1_DB: db,
    MULTIBOT_AGENT: {} as any,
    SANDBOX: {} as any,
    DISCORD_GATEWAY: {} as any,
    WEBHOOK_SECRET: "test",
    CHAT_COORDINATOR: {} as any,
    ...extra,
  };
}

describe("handleListSessions", () => {
  it("returns sessions for a date", async () => {
    const db = createMockD1();
    db._setAll([
      {
        session_id: "telegram-123-20260228-120000-abcd",
        channel: "telegram",
        chat_id: "123",
        group_id: null,
        bot_id: "bot-1",
        message_count: 5,
        latest_at: "2026-02-28 12:00:00",
        latest_message_id: 42,
      },
    ]);

    const req = new Request("https://test/api/logs/sessions?date=2026-02-28");
    const res = await handleListSessions(req, createEnv(db), { ownerId: "owner1" });
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].sessionId).toBe("telegram-123-20260228-120000-abcd");
    expect(body[0].channel).toBe("telegram");
    expect(body[0].chatId).toBe("123");
    expect(body[0].botId).toBe("bot-1");
    expect(body[0].messageCount).toBe(5);
    expect(body[0].latestMessageId).toBe(42);
  });

  it("returns empty array when no sessions found", async () => {
    const db = createMockD1();
    db._setAll([]);

    const req = new Request("https://test/api/logs/sessions?date=2026-02-28");
    const res = await handleListSessions(req, createEnv(db), { ownerId: "owner1" });
    const body = await res.json() as any;

    expect(body).toEqual([]);
  });

  it("supports botId filter using session-level bot_id", async () => {
    const db = createMockD1();
    const prepareSpy = vi.spyOn(db, "prepare");
    db._setAll([]);

    const req = new Request(
      "https://test/api/logs/sessions?date=2026-02-28&botId=bot-1",
    );
    await handleListSessions(req, createEnv(db), { ownerId: "owner1" });

    expect(prepareSpy).toHaveBeenCalledTimes(1);
    const sql = prepareSpy.mock.calls[0][0] as string;
    // Should use s.bot_id (session level), not m.bot_id (message level)
    expect(sql).toContain("s.bot_id = ?");
    expect(sql).not.toContain("m.bot_id");
  });

  it("returns bot_id from session", async () => {
    const db = createMockD1();
    const prepareSpy = vi.spyOn(db, "prepare");
    db._setAll([]);

    const req = new Request("https://test/api/logs/sessions?date=2026-02-28");
    await handleListSessions(req, createEnv(db), { ownerId: "owner1" });

    const sql = prepareSpy.mock.calls[0][0] as string;
    expect(sql).toContain("s.bot_id as bot_id");
    expect(sql).toContain("MAX(m.id) as latest_message_id");
    expect(sql).toContain("ORDER BY latest_at DESC, latest_message_id DESC");
  });

  it("uses local-day timezone offset for UTC range", async () => {
    const db = createMockD1();
    db._setAll([]);

    const req = new Request(
      "https://test/api/logs/sessions?date=2026-03-04&tzOffsetMinutes=480",
    );
    await handleListSessions(req, createEnv(db), { ownerId: "owner1" });

    const bindings = db._getLastBindings();
    expect(bindings[0]).toBe("2026-03-04 08:00:00");
    expect(bindings[1]).toBe("2026-03-05 08:00:00");
  });

  it("returns 400 for calendar-invalid date values", async () => {
    const db = createMockD1();
    const req = new Request("https://test/api/logs/sessions?date=2026-13-01");
    const res = await handleListSessions(req, createEnv(db), { ownerId: "owner1" });
    expect(res.status).toBe(400);
  });
});

describe("handleListMessages", () => {
  it("returns messages for a session", async () => {
    const db = createMockD1();
    db._setAll([
      {
        id: 1,
        session_id: "sess-1",
        role: "user",
        content: "Hello",
        bot_id: null,
        tool_calls: null,
        request_id: "req-1",
        created_at: "2026-02-28 12:00:00",
      },
      {
        id: 2,
        session_id: "sess-1",
        role: "assistant",
        content: "Hi there!",
        bot_id: "bot-1",
        tool_calls: null,
        request_id: "req-1",
        created_at: "2026-02-28 12:00:01",
      },
    ]);

    const req = new Request("https://test/api/logs/messages?sessionId=sess-1");
    const res = await handleListMessages(req, createEnv(db), { ownerId: "owner1" });
    const body = await res.json() as any;

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[0].role).toBe("user");
    expect(body[0].content).toBe("Hello");
    expect(body[0].requestId).toBe("req-1");
    expect(body[1].role).toBe("assistant");
    expect(body[1].botId).toBe("bot-1");
  });

  it("returns 400 when sessionId is missing", async () => {
    const db = createMockD1();

    const req = new Request("https://test/api/logs/messages");
    const res = await handleListMessages(req, createEnv(db), { ownerId: "owner1" });

    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error).toContain("sessionId");
  });
});

describe("handleListLogs", () => {
  it("uses D1 index for requestId lookups", async () => {
    const db = createMockD1();
    const targetKey = "logs/bot-1/2026-03-06/req-target.json";
    db._setFirst({
      request_id: "req-target",
      parent_request_id: "req-parent",
      bot_id: "bot-1",
      log_date: "2026-03-06",
      r2_key: targetKey,
      status: "ok",
      created_at: "2026-03-06 00:00:00",
    });

    const listSpy = vi.fn().mockResolvedValue({ objects: [], truncated: false });
    const bucket = {
      list: listSpy,
      get: vi.fn().mockResolvedValue({
        text: async () => JSON.stringify({
          trace: {
            requestId: "req-target",
            parentRequestId: "req-parent",
            botId: "bot-1",
            status: "ok",
            durationMs: 123,
            llmCalls: 1,
            inputTokens: 10,
            outputTokens: 20,
            skillCalls: [],
            iterations: 1,
          },
          entries: [],
        }),
      }),
    } as unknown as R2Bucket;

    const req = new Request("https://test/api/logs?requestId=req-target&botId=bot-1&date=2026-03-06");
    const res = await handleListLogs(req, createEnv(db, { LOG_BUCKET: bucket } as Partial<Env>), {
      ownerId: "owner1",
    });
    const body = await res.json() as any[];

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].trace.parentRequestId).toBe("req-parent");
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("uses D1 index for parentRequestId chain lookups", async () => {
    const db = createMockD1();
    db._setAll([
      {
        request_id: "req-parent",
        parent_request_id: null,
        bot_id: "orchestrator:g1",
        log_date: "2026-03-06",
        r2_key: "logs/orchestrator:g1/2026-03-06/req-parent.json",
        status: "ok",
        created_at: "2026-03-06 00:00:00",
      },
      {
        request_id: "req-child",
        parent_request_id: "req-parent",
        bot_id: "bot-1",
        log_date: "2026-03-06",
        r2_key: "logs/bot-1/2026-03-06/req-child.json",
        status: "ok",
        created_at: "2026-03-06 00:00:01",
      },
    ]);

    const listSpy = vi.fn().mockResolvedValue({ objects: [], truncated: false });
    const bucket = {
      list: listSpy,
      get: vi.fn()
        .mockResolvedValueOnce({
          text: async () => JSON.stringify({
            trace: {
              requestId: "req-parent",
              botId: "orchestrator:g1",
              status: "ok",
              durationMs: 50,
              llmCalls: 1,
              inputTokens: 1,
              outputTokens: 1,
              skillCalls: [],
              iterations: 1,
            },
            entries: [],
          }),
        })
        .mockResolvedValueOnce({
          text: async () => JSON.stringify({
            trace: {
              requestId: "req-child",
              parentRequestId: "req-parent",
              botId: "bot-1",
              status: "ok",
              durationMs: 80,
              llmCalls: 1,
              inputTokens: 2,
              outputTokens: 3,
              skillCalls: [],
              iterations: 1,
            },
            entries: [],
          }),
        }),
    } as unknown as R2Bucket;

    const req = new Request("https://test/api/logs?parentRequestId=req-parent&date=2026-03-06");
    const res = await handleListLogs(req, createEnv(db, { LOG_BUCKET: bucket } as Partial<Env>), {
      ownerId: "owner1",
    });
    const body = await res.json() as any[];

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[1].trace.parentRequestId).toBe("req-parent");
    expect(listSpy).not.toHaveBeenCalled();
  });

  it("falls back to R2 scan when indexed parent chain is incomplete", async () => {
    const db = createMockD1();
    db._setAll([
      {
        request_id: "req-parent",
        parent_request_id: null,
        bot_id: "orchestrator:g1",
        log_date: "2026-03-06",
        r2_key: "logs/orchestrator:g1/2026-03-06/req-parent.json",
        status: "ok",
        created_at: "2026-03-06 00:00:00",
      },
      {
        request_id: "req-child",
        parent_request_id: "req-parent",
        bot_id: "bot-1",
        log_date: "2026-03-06",
        r2_key: "logs/bot-1/2026-03-06/req-child.json",
        status: "ok",
        created_at: "2026-03-06 00:00:01",
      },
    ]);

    const bucket = {
      list: vi
        .fn()
        .mockResolvedValueOnce({
          delimitedPrefixes: ["logs/orchestrator:g1/", "logs/bot-1/"],
          objects: [],
          truncated: false,
        })
        .mockResolvedValueOnce({
          objects: [
            {
              key: "logs/orchestrator:g1/2026-03-06/req-parent.json",
              customMetadata: { t: JSON.stringify({ requestId: "req-parent" }) },
            },
          ],
          truncated: false,
        })
        .mockResolvedValueOnce({
          objects: [
            {
              key: "logs/bot-1/2026-03-06/req-child.json",
              customMetadata: { t: JSON.stringify({ requestId: "req-child", parentRequestId: "req-parent" }) },
            },
          ],
          truncated: false,
        }),
      get: vi
        .fn()
        // Indexed fetch: parent exists, child missing -> should force fallback
        .mockResolvedValueOnce({
          text: async () => JSON.stringify({
            trace: {
              requestId: "req-parent",
              botId: "orchestrator:g1",
              status: "ok",
              durationMs: 50,
              llmCalls: 1,
              inputTokens: 1,
              outputTokens: 1,
              skillCalls: [],
              iterations: 1,
            },
            entries: [],
          }),
        })
        .mockResolvedValueOnce(null)
        // Fallback fetches
        .mockResolvedValueOnce({
          text: async () => JSON.stringify({
            trace: {
              requestId: "req-parent",
              botId: "orchestrator:g1",
              status: "ok",
              durationMs: 50,
              llmCalls: 1,
              inputTokens: 1,
              outputTokens: 1,
              skillCalls: [],
              iterations: 1,
            },
            entries: [],
          }),
        })
        .mockResolvedValueOnce({
          text: async () => JSON.stringify({
            trace: {
              requestId: "req-child",
              parentRequestId: "req-parent",
              botId: "bot-1",
              status: "ok",
              durationMs: 80,
              llmCalls: 1,
              inputTokens: 2,
              outputTokens: 3,
              skillCalls: [],
              iterations: 1,
            },
            entries: [],
          }),
        }),
    } as unknown as R2Bucket;

    const req = new Request("https://test/api/logs?parentRequestId=req-parent&date=2026-03-06");
    const res = await handleListLogs(req, createEnv(db, { LOG_BUCKET: bucket } as Partial<Env>), {
      ownerId: "owner1",
    });
    const body = await res.json() as any[];

    expect(res.status).toBe(200);
    expect(body).toHaveLength(2);
    expect(body[1].trace.parentRequestId).toBe("req-parent");
    expect((bucket.list as any).mock.calls.length).toBeGreaterThan(0);
  });

  it("paginates requestId lookups within a bot prefix", async () => {
    const db = createMockD1();
    const targetKey = "logs/bot-1/2026-03-06/req-target.json";
    const bucket = createMockBucket(
      [
        {
          truncated: true,
          cursor: "page-2",
          objects: [{ key: "logs/bot-1/2026-03-05/req-old.json" }],
        },
        {
          truncated: false,
          objects: [{ key: targetKey }],
        },
      ],
      {
        [targetKey]: {
          trace: {
            requestId: "req-target",
            parentRequestId: "req-parent",
            botId: "bot-1",
            status: "ok",
            durationMs: 123,
            llmCalls: 1,
            inputTokens: 10,
            outputTokens: 20,
            skillCalls: [],
            iterations: 1,
          },
          entries: [],
        },
      },
    );

    const req = new Request("https://test/api/logs?requestId=req-target&botId=bot-1&date=2026-03-06");
    const res = await handleListLogs(req, createEnv(db, { LOG_BUCKET: bucket } as Partial<Env>), {
      ownerId: "owner1",
    });
    const body = await res.json() as any[];

    expect(res.status).toBe(200);
    expect(body).toHaveLength(1);
    expect(body[0].trace.requestId).toBe("req-target");
    expect(body[0].trace.parentRequestId).toBe("req-parent");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Logger, createLogger } from "./logger";
import type { RequestTrace } from "./logger";

describe("Logger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("createLogger auto-generates requestId", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger();
    log.info("test");
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
    );
  });

  it("createLogger merges provided context", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = createLogger({ botId: "bot-1", channel: "telegram" });
    log.info("hello");
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.botId).toBe("bot-1");
    expect(entry.channel).toBe("telegram");
    expect(entry.requestId).toBeDefined();
  });

  it("child() merges extra context", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const parent = new Logger({ requestId: "r1", botId: "b1" });
    const child = parent.child({ sessionId: "s1" });
    child.info("test");
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.requestId).toBe("r1");
    expect(entry.botId).toBe("b1");
    expect(entry.sessionId).toBe("s1");
  });

  it("child() overrides parent context", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const parent = new Logger({ requestId: "r1", botId: "b1" });
    const child = parent.child({ botId: "b2" });
    child.info("test");
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.botId).toBe("b2");
  });

  it("debug uses console.debug", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    const log = new Logger({ requestId: "r1" });
    log.debug("msg");
    expect(spy).toHaveBeenCalledOnce();
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.level).toBe("debug");
  });

  it("info uses console.log", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = new Logger({ requestId: "r1" });
    log.info("msg");
    expect(spy).toHaveBeenCalledOnce();
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.level).toBe("info");
  });

  it("warn uses console.warn", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const log = new Logger({ requestId: "r1" });
    log.warn("msg");
    expect(spy).toHaveBeenCalledOnce();
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.level).toBe("warn");
  });

  it("error uses console.error", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = new Logger({ requestId: "r1" });
    log.error("msg");
    expect(spy).toHaveBeenCalledOnce();
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.level).toBe("error");
  });

  it("output is valid JSON with required fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = new Logger({ requestId: "r1" });
    log.info("hello world", { extra: 42 });
    const raw = spy.mock.calls[0][0] as string;
    const entry = JSON.parse(raw);
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("hello world");
    expect(entry.requestId).toBe("r1");
    expect(entry.extra).toBe(42);
    expect(typeof entry.ts).toBe("number");
  });

  it("data fields override context fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const log = new Logger({ requestId: "r1", botId: "b1" });
    log.info("test", { botId: "override" });
    const entry = JSON.parse(spy.mock.calls[0][0] as string);
    expect(entry.botId).toBe("override");
  });
});

describe("Logger buffer", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("accumulates entries in buffer", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});

    const log = new Logger({ requestId: "r1" });
    log.info("first");
    log.warn("second");
    log.error("third");

    const entries = log.getEntries();
    expect(entries).toHaveLength(3);
    expect(entries[0].msg).toBe("first");
    expect(entries[0].level).toBe("info");
    expect(entries[1].msg).toBe("second");
    expect(entries[1].level).toBe("warn");
    expect(entries[2].msg).toBe("third");
    expect(entries[2].level).toBe("error");
  });

  it("child shares parent buffer", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const parent = new Logger({ requestId: "r1" });
    parent.info("parent msg");

    const child = parent.child({ sessionId: "s1" });
    child.info("child msg");

    // Both parent and child see the same entries
    expect(parent.getEntries()).toHaveLength(2);
    expect(child.getEntries()).toHaveLength(2);
    expect(parent.getEntries()).toBe(child.getEntries()); // same reference
  });

  it("flush calls R2 bucket.put with correct key and body", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const log = new Logger({ requestId: "r1", botId: "bot-1" });
    log.info("test entry");

    const mockPut = vi.fn().mockResolvedValue(undefined);
    const mockBucket = { put: mockPut } as unknown as R2Bucket;

    const trace: RequestTrace = {
      requestId: "r1",
      botId: "bot-1",
      status: "ok",
      startedAt: Date.now() - 100,
      durationMs: 100,
      llmCalls: 1,
      inputTokens: 50,
      outputTokens: 30,
      skillCalls: [{ skill: "", tools: [{ name: "web_search", input: "", result: "", isError: false }] }],
      iterations: 1,
    };

    await log.flush(mockBucket, trace);

    expect(mockPut).toHaveBeenCalledOnce();
    const [key, body, options] = mockPut.mock.calls[0];
    expect(key).toMatch(/^logs\/bot-1\/\d{4}-\d{2}-\d{2}\/r1\.json$/);

    const parsed = JSON.parse(body);
    expect(parsed.trace).toEqual(trace);
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].msg).toBe("test entry");

    // Verify customMetadata contains trace summary
    expect(options).toBeDefined();
    expect(options.customMetadata).toBeDefined();
    const metaTrace = JSON.parse(options.customMetadata.t);
    expect(metaTrace.requestId).toBe("r1");
    expect(metaTrace.botId).toBe("bot-1");
    expect(metaTrace.status).toBe("ok");
  });

  it("flush truncates userMessage and reply in customMetadata", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const log = new Logger({ requestId: "r-trunc" });
    log.info("msg");

    const mockPut = vi.fn().mockResolvedValue(undefined);
    const mockBucket = { put: mockPut } as unknown as R2Bucket;

    const longText = "a".repeat(500);
    const trace: RequestTrace = {
      requestId: "r-trunc",
      botId: "bot-1",
      status: "ok",
      startedAt: Date.now(),
      durationMs: 50,
      llmCalls: 1,
      inputTokens: 10,
      outputTokens: 20,
      skillCalls: [],
      iterations: 1,
      userMessage: longText,
      reply: longText,
      errorStack: "some stack trace",
    };

    await log.flush(mockBucket, trace);

    const [, , options] = mockPut.mock.calls[0];
    const metaTrace = JSON.parse(options.customMetadata.t);
    expect(metaTrace.userMessage).toHaveLength(200);
    expect(metaTrace.reply).toHaveLength(200);
    expect(metaTrace.errorStack).toBeUndefined();
  });

  it("flush excludes botCalls from customMetadata", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const log = new Logger({ requestId: "r-bc" });
    log.info("msg");

    const mockPut = vi.fn().mockResolvedValue(undefined);
    const mockBucket = { put: mockPut } as unknown as R2Bucket;

    const trace: RequestTrace = {
      requestId: "r-bc",
      botId: "orchestrator:g1",
      status: "ok",
      startedAt: Date.now(),
      durationMs: 500,
      llmCalls: 2,
      inputTokens: 100,
      outputTokens: 50,
      skillCalls: [{ skill: "selfie", tools: [{ name: "web_search", input: "", result: "", isError: false }] }],
      iterations: 1,
      botCalls: [
        { round: 1, wave: 1, botId: "b1", botName: "Bot1", durationMs: 200, status: "ok", inputTokens: 50, outputTokens: 25, skillCalls: [{ skill: "", tools: [{ name: "web_search", input: "", result: "", isError: false }] }] },
        { round: 1, wave: 2, botId: "b2", botName: "Bot2", durationMs: 300, status: "ok", inputTokens: 50, outputTokens: 25 },
      ],
    };

    await log.flush(mockBucket, trace);

    const [, body, options] = mockPut.mock.calls[0];
    // Full body should include botCalls
    const parsed = JSON.parse(body);
    expect(parsed.trace.botCalls).toHaveLength(2);
    // Metadata should exclude botCalls (too large for 2KB limit)
    const metaTrace = JSON.parse(options.customMetadata.t);
    expect(metaTrace.botCalls).toBeUndefined();
  });

  it("flush uses 'unknown' for botId when not set in trace", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const log = new Logger({ requestId: "r2" });
    log.info("msg");

    const mockPut = vi.fn().mockResolvedValue(undefined);
    const mockBucket = { put: mockPut } as unknown as R2Bucket;

    const trace: RequestTrace = {
      requestId: "r2",
      status: "error",
      startedAt: Date.now(),
      durationMs: 0,
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      skillCalls: [],
      iterations: 0,
      errorMessage: "test error",
    };

    await log.flush(mockBucket, trace);

    const [key] = mockPut.mock.calls[0];
    expect(key).toMatch(/^logs\/unknown\//);
  });

  it("flush upserts request trace index when D1 is provided", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    const log = new Logger({ requestId: "r-index", botId: "bot-1" });
    log.info("msg");

    const mockPut = vi.fn().mockResolvedValue(undefined);
    const mockBucket = { put: mockPut } as unknown as R2Bucket;
    const mockRun = vi.fn().mockResolvedValue({ success: true });
    const bindSpy = vi.fn(() => ({ run: mockRun }));
    const prepareSpy = vi.fn(() => ({ bind: bindSpy }));
    const mockDb = { prepare: prepareSpy } as unknown as D1Database;

    const trace: RequestTrace = {
      requestId: "r-index",
      parentRequestId: "r-parent",
      botId: "bot-1",
      status: "ok",
      startedAt: Date.now(),
      durationMs: 10,
      llmCalls: 1,
      inputTokens: 1,
      outputTokens: 1,
      skillCalls: [],
      iterations: 1,
    };

    await log.flush(mockBucket, trace, mockDb);

    expect(prepareSpy).toHaveBeenCalledOnce();
    expect(bindSpy).toHaveBeenCalledOnce();
    const bindArgs = (bindSpy.mock.calls[0] ?? []) as any[];
    expect(bindArgs[0]).toBe("r-index");
    expect(bindArgs[1]).toBe("r-parent");
    expect(bindArgs[2]).toBe("bot-1");
    expect(String(bindArgs[4])).toMatch(/logs\/bot-1\/\d{4}-\d{2}-\d{2}\/r-index\.json/);
    expect(bindArgs[5]).toBe("ok");
    expect(mockRun).toHaveBeenCalledOnce();
  });

  it("flush ignores missing request trace index table", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const log = new Logger({ requestId: "r-missing" });
    log.info("msg");

    const mockPut = vi.fn().mockResolvedValue(undefined);
    const mockBucket = { put: mockPut } as unknown as R2Bucket;
    const mockDb = {
      prepare: vi.fn(() => ({
        bind: vi.fn(() => ({
          run: vi.fn().mockRejectedValue(new Error("no such table: request_trace_index")),
        })),
      })),
    } as unknown as D1Database;

    const trace: RequestTrace = {
      requestId: "r-missing",
      status: "ok",
      startedAt: Date.now(),
      durationMs: 0,
      llmCalls: 0,
      inputTokens: 0,
      outputTokens: 0,
      skillCalls: [],
      iterations: 0,
    };

    await expect(log.flush(mockBucket, trace, mockDb)).resolves.toBeUndefined();
    expect(mockPut).toHaveBeenCalledOnce();
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadMemoryContext, consolidateMemory, reviewMemory, estimateTokens, estimateRowTokens, getMemoryTokenLimit, truncateMemoryBySections, splitIntoBatches, alignToTurnBoundary, extractIdentifiers, auditSummaryQuality } from "./memory";

vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
  };
});

vi.mock("../db/d1", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../db/d1")>();
  return {
    ...actual,
    getMemory: vi.fn(),
    upsertMemory: vi.fn(),
    insertHistoryEntry: vi.fn(),
    deleteExpiredHistoryEntries: vi.fn(),
    getHistoryEntries: vi.fn(),
  };
});

import { generateText } from "ai";
import { getMemory, upsertMemory, insertHistoryEntry, deleteExpiredHistoryEntries, getHistoryEntries } from "../db/d1";

const mockGenerateText = vi.mocked(generateText);
const mockGetMemory = vi.mocked(getMemory);
const mockUpsertMemory = vi.mocked(upsertMemory);
const mockInsertHistoryEntry = vi.mocked(insertHistoryEntry);
const mockDeleteExpiredHistoryEntries = vi.mocked(deleteExpiredHistoryEntries);
const mockGetHistoryEntries = vi.mocked(getHistoryEntries);

const mockDb = {} as D1Database;

/** Helper: mock generateText to return a structured archive_conversation tool call */
function mockToolCall(summary: string, opts?: { decisions?: string; open_todos?: string; key_identifiers?: string }) {
  mockGenerateText.mockResolvedValue({
    toolCalls: [
      {
        toolName: "archive_conversation",
        input: {
          summary,
          decisions: opts?.decisions ?? "None",
          open_todos: opts?.open_todos ?? "None",
          key_identifiers: opts?.key_identifiers ?? "None",
        },
      },
    ],
  } as any);
}

/** Helper: mock generateText to return a structured tool call (for mockResolvedValueOnce) */
function makeToolCallResult(summary: string, opts?: { decisions?: string; open_todos?: string; key_identifiers?: string }) {
  return {
    toolCalls: [
      {
        toolName: "archive_conversation",
        input: {
          summary,
          decisions: opts?.decisions ?? "None",
          open_todos: opts?.open_todos ?? "None",
          key_identifiers: opts?.key_identifiers ?? "None",
        },
      },
    ],
  };
}

beforeEach(() => {
  mockGenerateText.mockReset();
  mockGetMemory.mockReset();
  mockUpsertMemory.mockReset();
  mockInsertHistoryEntry.mockReset();
  mockDeleteExpiredHistoryEntries.mockReset();
  mockGetHistoryEntries.mockReset();
  // Default: no existing memory
  mockGetMemory.mockResolvedValue("");
  mockGetHistoryEntries.mockResolvedValue([]);
});

describe("estimateTokens", () => {
  it("estimates tokens for CJK text (higher than ASCII ratio)", () => {
    const cjk = "你好世界这是一个测试";  // 10 CJK chars → ceil(10 * 1.8) = 18
    expect(estimateTokens(cjk)).toBe(18);
  });

  it("estimates tokens for ASCII text", () => {
    const ascii = "hello world this is a test";  // 26 chars → ceil(26 / 3 * 1.2) = 11
    expect(estimateTokens(ascii)).toBe(11);
  });

  it("estimates tokens for mixed CJK and ASCII text", () => {
    const mixed = "Hello 你好";  // 6 non-CJK + 2 CJK → ceil(6/3*1.2 + 2*1.8) = ceil(2.4 + 3.6) = 6
    expect(estimateTokens(mixed)).toBe(6);
  });

  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });
});

describe("splitIntoBatches", () => {
  const makeMsg = (content: string, role = "user") => ({
    role,
    content,
    tool_calls: null as string | null,
    created_at: "2024-01-01T00:00:00Z",
  });

  it("respects maxCount limit", () => {
    const msgs = Array.from({ length: 5 }, () => makeMsg("short"));
    const batches = splitIntoBatches(msgs, 2, 1_000_000);
    expect(batches.length).toBe(3);
    expect(batches[0].length).toBe(2);
    expect(batches[1].length).toBe(2);
    expect(batches[2].length).toBe(1);
  });

  it("shrinks batch size when tokens exceed budget", () => {
    // Each message ~2000 chars → with CJK could be ~3600+ tokens per message
    const longContent = "这".repeat(2000); // 2000 CJK chars
    const msgs = Array.from({ length: 10 }, () => makeMsg(longContent));
    // Set a tight budget that forces small batches
    const batches = splitIntoBatches(msgs, 200, 5000);
    // Should create more batches than just 1
    expect(batches.length).toBeGreaterThan(1);
    // All messages should still be covered
    const total = batches.reduce((sum, b) => sum + b.length, 0);
    expect(total).toBe(10);
  });

  it("handles empty input", () => {
    const batches = splitIntoBatches([], 200, 100_000);
    expect(batches).toEqual([]);
  });
});

describe("getMemoryTokenLimit", () => {
  it("returns 3% of context window", () => {
    expect(getMemoryTokenLimit(128000)).toBe(3840);
    expect(getMemoryTokenLimit(32000)).toBe(960);
  });
});

describe("loadMemoryContext", () => {
  it("returns empty string when no memory exists", async () => {
    mockGetMemory.mockResolvedValue("");
    const result = await loadMemoryContext(mockDb, "bot-001");
    expect(result).toBe("");
    expect(mockGetMemory).toHaveBeenCalledWith(mockDb, "bot-001");
  });

  it("returns formatted memory when content exists", async () => {
    mockGetMemory.mockResolvedValue("# User\n- Name: Alice");
    const result = await loadMemoryContext(mockDb, "bot-001");
    expect(result).toBe("## Long-term Memory\n# User\n- Name: Alice");
  });
});

describe("consolidateMemory", () => {
  const makeMessages = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}`,
      created_at: "2026-02-21 14:00",
    }));

  it("returns null when message count <= keepCount (normal mode)", async () => {
    const result = await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages: makeMessages(10),
      memoryWindow: 50,
    });
    expect(result).toBeNull();
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns null for empty messages in archiveAll mode", async () => {
    const result = await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages: [],
      memoryWindow: 50,
      archiveAll: true,
    });
    expect(result).toBeNull();
  });

  it("consolidates all messages when archiveAll is true", async () => {
    mockToolCall("[2026-02-21 14:00] Test summary");

    const messages = makeMessages(6);
    const result = await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages,
      memoryWindow: 50,
      archiveAll: true,
    });

    expect(result).toBe(6);
    expect(mockInsertHistoryEntry).toHaveBeenCalledWith(
      mockDb,
      "bot-001",
      "[2026-02-21 14:00] Test summary"  // Only summary, decisions/todos/identifiers are "None" and omitted
    );
    expect(mockUpsertMemory).not.toHaveBeenCalled();
  });

  it("only consolidates old messages in normal mode (turn-aligned)", async () => {
    mockToolCall("[2026-02-21] Summary of messages 1-6");

    // 30 messages, memoryWindow=50 → keepCount=25 → rawSplitIndex=5
    // Message at index 5 is assistant (role alternates: user=0,2,4,...; assistant=1,3,5,...)
    // Turn alignment walks forward to index 6 (next user message)
    // So first 6 messages are consolidated (ids 1-6)
    const messages = makeMessages(30);
    const result = await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages,
      memoryWindow: 50,
    });

    expect(result).toBe(6);
    // Verify the prompt included the first 6 messages
    const callArgs = mockGenerateText.mock.calls[0][0] as any;
    const promptText = callArgs.messages[0].content[0].text;
    expect(promptText).toContain("Message 1");
    expect(promptText).toContain("Message 6");
    expect(promptText).not.toContain("Message 7");
  });

  it("inserts history entry via D1", async () => {
    mockToolCall("[2026-02-21] New entry", { decisions: "Decided to use React", open_todos: "None", key_identifiers: "None" });

    await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages: makeMessages(6),
      memoryWindow: 50,
      archiveAll: true,
    });

    expect(mockInsertHistoryEntry).toHaveBeenCalledWith(
      mockDb,
      "bot-001",
      "[2026-02-21] New entry\n**Decisions:** Decided to use React"
    );
    expect(mockUpsertMemory).not.toHaveBeenCalled();
  });

  it("does NOT advance boundary when LLM fails to call archive_conversation", async () => {
    mockGenerateText.mockResolvedValue({
      toolCalls: [],
    } as any);

    const messages = makeMessages(6);
    const result = await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages,
      memoryWindow: 50,
      archiveAll: true,
    });

    // Returns null — boundary must NOT advance, next cycle will retry
    expect(result).toBeNull();
    expect(mockInsertHistoryEntry).not.toHaveBeenCalled();
  });

  it("advances boundary only up to last successful batch (partial success)", async () => {
    // Batch 1 (messages 1-200): succeeds
    mockGenerateText.mockResolvedValueOnce(makeToolCallResult("batch 1 summary") as any);
    // Batch 2 (messages 201-250): LLM fails to call tool
    mockGenerateText.mockResolvedValueOnce({
      toolCalls: [],
    } as any);

    const messages = Array.from({ length: 250 }, (_, i) => ({
      id: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}`,
      created_at: "2026-02-21 14:00",
    }));

    const result = await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages,
      memoryWindow: 50,
      archiveAll: true,
    });

    // Boundary advances only to end of batch 1 (message 200), NOT 250
    expect(result).toBe(200);
    expect(mockInsertHistoryEntry).toHaveBeenCalledTimes(1);
    expect(mockInsertHistoryEntry).toHaveBeenCalledWith(mockDb, "bot-001", "batch 1 summary");
  });

  it("returns null when all batches fail in multi-batch scenario", async () => {
    mockGenerateText.mockResolvedValue({ toolCalls: [] } as any);

    const messages = Array.from({ length: 250 }, (_, i) => ({
      id: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}`,
      created_at: "2026-02-21 14:00",
    }));

    const result = await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages,
      memoryWindow: 50,
      archiveAll: true,
    });

    expect(result).toBeNull();
    expect(mockInsertHistoryEntry).not.toHaveBeenCalled();
  });

  it("uses structured archive_conversation tool in generateText call", async () => {
    mockToolCall("test");

    await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages: makeMessages(6),
      memoryWindow: 50,
      archiveAll: true,
    });

    const callArgs = mockGenerateText.mock.calls[0][0] as any;
    expect(callArgs.tools).toHaveProperty("archive_conversation");
    expect(callArgs.system).toContain("conversation archiver");
    expect(callArgs.system).toContain("same language");
    expect(callArgs.system).toContain("identifiers");
    expect(callArgs.toolChoice).toEqual({ type: "tool", toolName: "archive_conversation" });
  });

  it("calls insertHistoryEntry with formatted markdown for each consolidation", async () => {
    mockToolCall("[2026-02-21 14:00] New entry", {
      decisions: "Chose PostgreSQL",
      open_todos: "Migrate the data",
      key_identifiers: "https://example.com, d1ea9d49",
    });

    await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages: makeMessages(6),
      memoryWindow: 50,
      archiveAll: true,
    });

    const calledWith = mockInsertHistoryEntry.mock.calls[0][2];
    expect(calledWith).toContain("[2026-02-21 14:00] New entry");
    expect(calledWith).toContain("**Decisions:** Chose PostgreSQL");
    expect(calledWith).toContain("**Open TODOs:** Migrate the data");
    expect(calledWith).toContain("**Identifiers:** https://example.com, d1ea9d49");
    expect(mockUpsertMemory).not.toHaveBeenCalled();
  });

  it("converts timestamps using timezone when provided", async () => {
    mockToolCall("test");

    const messages = [
      {
        id: 1,
        role: "user",
        content: "hello",
        created_at: "2026-02-21 23:00",
      },
      {
        id: 2,
        role: "assistant",
        content: "hi",
        created_at: "2026-02-21 23:01",
      },
    ];
    await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages,
      memoryWindow: 50,
      archiveAll: true,
      timezone: "Asia/Shanghai",
    });

    const callArgs = mockGenerateText.mock.calls[0][0] as any;
    const promptText = callArgs.messages[0].content[0].text;
    // UTC 23:00 → Asia/Shanghai (UTC+8) = next day 07:00
    expect(promptText).toContain("[2026-02-22 07:00]");
    expect(promptText).toContain("[2026-02-22 07:01]");
  });

  it("includes tool_calls in formatted messages", async () => {
    mockToolCall("test");

    const messages = [
      {
        id: 1,
        role: "user",
        content: "search for cats",
        tool_calls: null,
        created_at: "2026-02-21 14:00",
      },
      {
        id: 2,
        role: "assistant",
        content: "Found cats",
        tool_calls: JSON.stringify([{ toolCallId: "tc-1", toolName: "web_search", input: { query: "cats" } }]),
        created_at: "2026-02-21 14:01",
      },
    ];
    await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages,
      memoryWindow: 50,
      archiveAll: true,
    });

    const callArgs = mockGenerateText.mock.calls[0][0] as any;
    const promptText = callArgs.messages[0].content[0].text;
    expect(promptText).toContain("[tools: web_search]");
    expect(promptText).toContain("ASSISTANT [tools: web_search]: Found cats");
  });

  it("omits None sections from formatted history entry", async () => {
    mockToolCall("[2026-03-04] Just a chat", {
      decisions: "None",
      open_todos: "None",
      key_identifiers: "None",
    });

    const messages = makeMessages(6);
    await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages,
      memoryWindow: 50,
      archiveAll: true,
    });

    const calledWith = mockInsertHistoryEntry.mock.calls[0][2];
    // Should only contain the summary, no **Decisions:** etc.
    expect(calledWith).toBe("[2026-03-04] Just a chat");
    expect(calledWith).not.toContain("**Decisions:**");
    expect(calledWith).not.toContain("**Open TODOs:**");
    expect(calledWith).not.toContain("**Identifiers:**");
  });

  it("cleans up expired history entries after consolidation", async () => {
    mockToolCall("[2026-03-04] New entry");

    const messages = makeMessages(6);
    await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages,
      memoryWindow: 50,
      archiveAll: true,
    });

    // Verify deleteExpiredHistoryEntries was called with 180 days retention
    expect(mockDeleteExpiredHistoryEntries).toHaveBeenCalledWith(mockDb, "bot-001", 180);
    expect(mockUpsertMemory).not.toHaveBeenCalled();
  });

  it("truncates long message content to CONSOLIDATION_MSG_TRUNCATE", async () => {
    mockToolCall("test");

    const longContent = "x".repeat(3000);
    const messages = [
      { id: 1, role: "user", content: longContent, created_at: "2026-02-21 14:00" },
      { id: 2, role: "assistant", content: "short", created_at: "2026-02-21 14:01" },
    ];
    await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages,
      memoryWindow: 50,
      archiveAll: true,
    });

    const callArgs = mockGenerateText.mock.calls[0][0] as any;
    const promptText = callArgs.messages[0].content[0].text;
    // Long content should be truncated to 2000 chars + "…"
    expect(promptText).not.toContain("x".repeat(3000));
    expect(promptText).toContain("x".repeat(2000) + "…");
    // Short content should not be truncated
    expect(promptText).toContain("short");
  });

  it("processes messages in batches when exceeding CONSOLIDATION_MSG_LIMIT", async () => {
    mockToolCall("batch summary");

    // Create 250 messages → 2 batches (200 + 50)
    const messages = Array.from({ length: 250 }, (_, i) => ({
      id: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: `Message ${i + 1}`,
      created_at: "2026-02-21 14:00",
    }));

    await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages,
      memoryWindow: 50,
      archiveAll: true,
    });

    // Should call generateText twice (2 batches)
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    // Each batch produces a history entry
    expect(mockInsertHistoryEntry).toHaveBeenCalledTimes(2);
    // deleteExpiredHistoryEntries called once after all batches
    expect(mockDeleteExpiredHistoryEntries).toHaveBeenCalledTimes(1);
  });
});

describe("reviewMemory", () => {
  it("returns false when no history entries exist", async () => {
    mockGetMemory.mockResolvedValue("existing memory");
    mockGetHistoryEntries.mockResolvedValue([]);

    const result = await reviewMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
    });

    expect(result).toBe(false);
    expect(mockGenerateText).not.toHaveBeenCalled();
  });

  it("returns false when no memory and no history", async () => {
    mockGetMemory.mockResolvedValue("");
    mockGetHistoryEntries.mockResolvedValue([]);

    const result = await reviewMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
    });

    expect(result).toBe(false);
  });

  it("calls LLM with review prompt and updates memory", async () => {
    mockGetMemory.mockResolvedValue("old memory with dated logs");
    mockGetHistoryEntries.mockResolvedValue([
      { id: 1, content: "[2026-03-01] User likes cats", created_at: "2026-03-01" },
      { id: 2, content: "[2026-03-02] User set rule: no spam", created_at: "2026-03-02" },
    ]);

    mockGenerateText.mockResolvedValueOnce({
      text: "# User Profile\n- Likes cats\n\n# Rules\n- No spam",
    } as any);

    const result = await reviewMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
    });

    expect(result).toBe(true);
    expect(mockGenerateText).toHaveBeenCalledTimes(1);
    const callArgs = mockGenerateText.mock.calls[0][0] as any;
    expect(callArgs.system).toContain("memory review agent");
    expect(mockUpsertMemory).toHaveBeenCalledWith(
      mockDb,
      "bot-001",
      "# User Profile\n- Likes cats\n\n# Rules\n- No spam"
    );
  });

  it("returns false when LLM returns same memory", async () => {
    const unchanged = "# User\n- Name: Alice";
    mockGetMemory.mockResolvedValue(unchanged);
    mockGetHistoryEntries.mockResolvedValue([
      { id: 1, content: "[2026-03-01] Routine chat", created_at: "2026-03-01" },
    ]);

    mockGenerateText.mockResolvedValueOnce({
      text: unchanged,
    } as any);

    const result = await reviewMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
    });

    expect(result).toBe(false);
    expect(mockUpsertMemory).not.toHaveBeenCalled();
  });

  it("applies overflow compression when review result exceeds token limit", async () => {
    mockGetMemory.mockResolvedValue("old");
    mockGetHistoryEntries.mockResolvedValue([
      { id: 1, content: "[2026-03-01] stuff", created_at: "2026-03-01" },
    ]);

    const oversized = "A".repeat(100);
    // First call: review returns oversized
    mockGenerateText.mockResolvedValueOnce({ text: oversized } as any);
    // Second call: compression
    mockGenerateText.mockResolvedValueOnce({ text: "compressed" } as any);

    const result = await reviewMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      contextWindow: 300, // tokenLimit = 9
    });

    expect(result).toBe(true);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(mockUpsertMemory).toHaveBeenCalledWith(mockDb, "bot-001", "compressed");
  });

  it("review prompt forbids storing tool/skill/system knowledge", async () => {
    mockGetMemory.mockResolvedValue("old");
    mockGetHistoryEntries.mockResolvedValue([
      { id: 1, content: "[2026-03-01] stuff", created_at: "2026-03-01" },
    ]);
    mockGenerateText.mockResolvedValueOnce({ text: "updated" } as any);

    await reviewMemory({ model: {} as any, db: mockDb, botId: "bot-001" });

    const callArgs = mockGenerateText.mock.calls[0][0] as any;
    expect(callArgs.system).toContain("NEVER add to memory");
    expect(callArgs.system).toContain("tool usage");
    expect(callArgs.system).toContain("skill instructions");
  });

  it("review prompt enforces structured output sections", async () => {
    mockGetMemory.mockResolvedValue("old");
    mockGetHistoryEntries.mockResolvedValue([
      { id: 1, content: "[2026-03-01] stuff", created_at: "2026-03-01" },
    ]);
    mockGenerateText.mockResolvedValueOnce({ text: "updated" } as any);

    await reviewMemory({ model: {} as any, db: mockDb, botId: "bot-001" });

    const callArgs = mockGenerateText.mock.calls[0][0] as any;
    expect(callArgs.system).toContain("## User Profile");
    expect(callArgs.system).toContain("## Preferences");
    expect(callArgs.system).toContain("## Rules & Boundaries");
  });
});

describe("truncateMemoryBySections", () => {
  it("drops lowest-priority sections first", () => {
    const memory = [
      "Some preamble",
      "## Ongoing Commitments",
      "Low priority content.",
      "## Rules & Boundaries",
      "High priority content.",
      "## User Profile",
      "Medium priority content.",
      "## Unknown Section",
      "Zero priority content.",
    ].join("\n");

    const tokens = estimateTokens(memory);
    const truncated = truncateMemoryBySections(memory, Math.floor(tokens * 0.6));

    // High priority sections retained
    expect(truncated).toContain("## Rules & Boundaries");
    expect(truncated).toContain("High priority content.");
    expect(truncated).toContain("## User Profile");
    expect(truncated).toContain("Medium priority content.");
    // Low priority sections dropped
    expect(truncated).not.toContain("## Unknown Section");
    expect(truncated).not.toContain("Some preamble");
    expect(truncated).not.toContain("## Ongoing Commitments");
  });

  it("truncates lines from end of section before dropping it", () => {
    const memory = [
      "## Rules & Boundaries",
      "Rule 1",
      "Rule 2",
      "Rule 3",
      "Rule 4",
    ].join("\n");

    const tokens = estimateTokens(memory);
    const truncated = truncateMemoryBySections(memory, Math.floor(tokens * 0.7));

    expect(truncated).toContain("## Rules & Boundaries");
    expect(truncated).toContain("Rule 1");
    expect(truncated).not.toContain("Rule 4");
  });

  it("returns unchanged when already within budget", () => {
    const memory = "## User Profile\nShort content.";
    const truncated = truncateMemoryBySections(memory, 1000);
    expect(truncated).toContain("## User Profile");
    expect(truncated).toContain("Short content.");
  });

  it("preserves section order after truncation", () => {
    const memory = [
      "## Relationships",
      "Friend: Alice",
      "## Rules & Boundaries",
      "No spam.",
      "## Preferences",
      "Likes dark mode.",
    ].join("\n");

    const tokens = estimateTokens(memory);
    const truncated = truncateMemoryBySections(memory, Math.floor(tokens * 0.7));

    // Relationships (priority 1) should be dropped first
    expect(truncated).not.toContain("## Relationships");
    // Rules & Boundaries should appear before Preferences in output
    const rulesIdx = truncated.indexOf("## Rules & Boundaries");
    const prefsIdx = truncated.indexOf("## Preferences");
    expect(rulesIdx).toBeLessThan(prefsIdx);
  });
});

describe("alignToTurnBoundary", () => {
  const msgs = (roles: string[]) => roles.map((role) => ({ role }));

  it("returns splitIndex when already on a user message", () => {
    const messages = msgs(["user", "assistant", "user", "assistant"]);
    expect(alignToTurnBoundary(messages, 2)).toBe(2);
  });

  it("walks forward to find next user message", () => {
    const messages = msgs(["user", "assistant", "assistant", "user", "assistant"]);
    // splitIndex=1 (assistant) → should walk to index 3 (user)
    expect(alignToTurnBoundary(messages, 1)).toBe(3);
  });

  it("falls back to original index when no user message found within range", () => {
    // All assistants after the split point
    const messages = msgs(["user", "assistant", "assistant", "assistant", "assistant"]);
    expect(alignToTurnBoundary(messages, 1)).toBe(1);
  });

  it("handles edge cases: splitIndex 0 and beyond length", () => {
    const messages = msgs(["user", "assistant"]);
    expect(alignToTurnBoundary(messages, 0)).toBe(0);
    expect(alignToTurnBoundary(messages, 5)).toBe(2);
  });
});

describe("extractIdentifiers", () => {
  it("extracts UUIDs/hex identifiers (8+ chars)", () => {
    const text = "Found bot d1ea9d49 and session 5c7c8dfc-4c50-4701-83d5-1f91e0255fca";
    const ids = extractIdentifiers(text);
    expect(ids).toContain("d1ea9d49");
    expect(ids).toContain("5c7c8dfc");
  });

  it("extracts URLs", () => {
    const text = "Check https://example.com/api/v1 and http://localhost:3000";
    const ids = extractIdentifiers(text);
    expect(ids).toContain("https://example.com/api/v1");
    expect(ids).toContain("http://localhost:3000");
  });

  it("extracts file paths", () => {
    const text = "Modified /src/agent/memory.ts and /Users/foo/bar.json";
    const ids = extractIdentifiers(text);
    expect(ids).toContain("/src/agent/memory.ts");
    expect(ids).toContain("/Users/foo/bar.json");
  });

  it("strips trailing punctuation from URLs", () => {
    const text = "See https://example.com. Also check https://other.com,";
    const ids = extractIdentifiers(text);
    expect(ids).toContain("https://example.com");
    expect(ids).toContain("https://other.com");
  });

  it("deduplicates and caps at 12", () => {
    const ids = Array.from({ length: 20 }, (_, i) => `AABBCCDD${i.toString(16).padStart(2, "0")}`);
    const text = ids.join(" ");
    const result = extractIdentifiers(text);
    expect(result.length).toBeLessThanOrEqual(12);
  });

  it("does not match pure decimal numbers", () => {
    const text = "Phone 12345678, timestamp 1700000000, count 100000000";
    const ids = extractIdentifiers(text);
    expect(ids).toEqual([]);
  });

  it("returns empty for text without identifiers", () => {
    expect(extractIdentifiers("Hello world, how are you?")).toEqual([]);
  });
});

describe("auditSummaryQuality", () => {
  it("returns ok when summary is valid and no source identifiers", () => {
    const result = auditSummaryQuality(
      { summary: "A detailed summary of the conversation.", decisions: "None", open_todos: "None", key_identifiers: "None" },
      [],
    );
    expect(result.ok).toBe(true);
  });

  it("fails when summary is too short", () => {
    const result = auditSummaryQuality(
      { summary: "Short", decisions: "None", open_todos: "None", key_identifiers: "None" },
      [],
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("summary_too_short");
  });

  it("fails when source identifiers are missing from key_identifiers", () => {
    const result = auditSummaryQuality(
      { summary: "A detailed summary of the conversation.", decisions: "None", open_todos: "None", key_identifiers: "d1ea9d49" },
      ["d1ea9d49", "5c7c8dfc"],
    );
    expect(result.ok).toBe(false);
    expect(result.reasons[0]).toContain("missing_identifiers");
    expect(result.reasons[0]).toContain("5c7c8dfc");
  });

  it("fails when LLM says None but source has identifiers", () => {
    const result = auditSummaryQuality(
      { summary: "A detailed summary of the conversation.", decisions: "None", open_todos: "None", key_identifiers: "None" },
      ["d1ea9d49"],
    );
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain("identifiers_marked_none_but_source_has_identifiers");
  });

  it("passes when all source identifiers are present (case-insensitive for hex)", () => {
    const result = auditSummaryQuality(
      { summary: "A detailed summary of the conversation.", decisions: "None", open_todos: "None", key_identifiers: "D1EA9D49, https://example.com" },
      ["d1ea9d49", "https://example.com"],
    );
    expect(result.ok).toBe(true);
  });
});

describe("consolidateMemory quality audit retry", () => {
  const makeMessages = (count: number) =>
    Array.from({ length: count }, (_, i) => ({
      id: i + 1,
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0 ? `Check d1ea9d49 session` : `Found session d1ea9d49`,
      created_at: "2026-02-21 14:00",
    }));

  it("retries once when quality audit fails, then accepts best effort", async () => {
    // First call: missing identifier
    mockGenerateText.mockResolvedValueOnce(makeToolCallResult(
      "[2026-02-21] Summary without identifiers",
      { key_identifiers: "None" },
    ) as any);
    // Retry call: includes identifier
    mockGenerateText.mockResolvedValueOnce(makeToolCallResult(
      "[2026-02-21] Summary with d1ea9d49",
      { key_identifiers: "d1ea9d49" },
    ) as any);

    await consolidateMemory({
      model: {} as any,
      db: mockDb,
      botId: "bot-001",
      messages: makeMessages(6),
      memoryWindow: 50,
      archiveAll: true,
    });

    // Should have called generateText twice (original + 1 retry)
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    // Second call should include quality feedback in system prompt
    const retryArgs = mockGenerateText.mock.calls[1][0] as any;
    expect(retryArgs.system).toContain("Quality feedback");
    // History entry should be from the retry
    const calledWith = mockInsertHistoryEntry.mock.calls[0][2];
    expect(calledWith).toContain("d1ea9d49");
  });
});

describe("estimateRowTokens", () => {
  it("estimates tokens for plain text content", () => {
    const row = { content: "Hello world", tool_calls: null, created_at: "2026-01-01T00:00:00Z" };
    const tokens = estimateRowTokens(row, true);
    // estimateTokens("Hello world") + 30 overhead
    const expectedContentTokens = estimateTokens("Hello world");
    expect(tokens).toBe(expectedContentTokens + 30);
  });

  it("applies older truncation limit (2000 chars) when isRecent=false", () => {
    const longContent = "x".repeat(3000);
    const row = { content: longContent, tool_calls: null, created_at: "2026-01-01T00:00:00Z" };
    const tokens = estimateRowTokens(row, false);
    // Should truncate to 2000 chars, not use full 3000
    const expectedContentTokens = estimateTokens("x".repeat(2000));
    expect(tokens).toBe(expectedContentTokens + 30);
  });

  it("applies recent truncation limit (4000 chars) when isRecent=true", () => {
    const longContent = "x".repeat(5000);
    const row = { content: longContent, tool_calls: null, created_at: "2026-01-01T00:00:00Z" };
    const tokens = estimateRowTokens(row, true);
    // Should truncate to 4000 chars, not use full 5000
    const expectedContentTokens = estimateTokens("x".repeat(4000));
    expect(tokens).toBe(expectedContentTokens + 30);
    // Verify it's different from what full content would give
    const fullTokens = estimateTokens(longContent) + 30;
    expect(tokens).toBeLessThan(fullTokens);
  });

  it("includes tool_calls in estimation", () => {
    const toolCallsJson = JSON.stringify([{ toolName: "web_search", input: { query: "cats" } }]);
    const row = { content: "Found results", tool_calls: toolCallsJson, created_at: "2026-01-01T00:00:00Z" };
    const tokens = estimateRowTokens(row, true);
    const expectedContentTokens = estimateTokens("Found results");
    const expectedToolTokens = estimateTokens(toolCallsJson);
    expect(tokens).toBe(expectedContentTokens + expectedToolTokens + 30);
  });

  it("returns just overhead (30) for null content without tool_calls", () => {
    const row = { content: null, tool_calls: null, created_at: "2026-01-01T00:00:00Z" };
    const tokens = estimateRowTokens(row, true);
    // estimateTokens("") = 0, no tool_calls, just 30 overhead
    expect(tokens).toBe(30);
  });

  it("caps tool_calls estimation at 4000 chars", () => {
    const longToolCalls = "t".repeat(8000);
    const row = { content: "short", tool_calls: longToolCalls, created_at: "2026-01-01T00:00:00Z" };
    const tokens = estimateRowTokens(row, true);
    const expectedContentTokens = estimateTokens("short");
    const expectedToolTokens = estimateTokens("t".repeat(4000));
    expect(tokens).toBe(expectedContentTokens + expectedToolTokens + 30);
    // Verify it's less than what uncapped would give
    const uncappedToolTokens = estimateTokens(longToolCalls);
    expect(expectedToolTokens).toBeLessThan(uncappedToolTokens);
  });
});

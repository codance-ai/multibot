import { describe, it, expect } from "vitest";
import type { ModelMessage } from "ai";
import {
  pruneContextMessages,
  softTrimText,
  findFirstUserIndex,
  findToolAssistantCutoffIndex,
  SOFT_TRIM_RATIO,
  HARD_CLEAR_RATIO,
  SOFT_TRIM_MAX_CHARS,
  SOFT_TRIM_HEAD_CHARS,
  SOFT_TRIM_TAIL_CHARS,
  KEEP_LAST_TOOL_ASSISTANTS,
} from "./context-pruning";

// ── Helpers ────────────────────────────────────────────────────────────

function userMsg(text: string): ModelMessage {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): ModelMessage {
  return { role: "assistant", content: [{ type: "text", text }] };
}

function assistantWithToolCall(toolCallId: string, toolName: string, input: unknown = {}, text?: string): ModelMessage {
  const parts: any[] = [];
  if (text) parts.push({ type: "text", text });
  parts.push({ type: "tool-call", toolCallId, toolName, input });
  return { role: "assistant", content: parts };
}

function toolResult(toolCallId: string, toolName: string, value: string): ModelMessage {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId, toolName, output: { type: "text", value } },
    ],
  } as any;
}

function toolResultWithResult(toolCallId: string, toolName: string, result: string): ModelMessage {
  return {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId, toolName, result },
    ],
  } as any;
}

/** Create a long string of given length */
function longText(length: number, char = "x"): string {
  return char.repeat(length);
}

// ── softTrimText ───────────────────────────────────────────────────────

describe("softTrimText", () => {
  it("does not trim text shorter than head + tail", () => {
    const text = "short text";
    expect(softTrimText(text)).toBe(text);
  });

  it("does not trim text exactly equal to head + tail", () => {
    const text = longText(SOFT_TRIM_HEAD_CHARS + SOFT_TRIM_TAIL_CHARS);
    expect(softTrimText(text)).toBe(text);
  });

  it("trims text longer than head + tail", () => {
    const text = "A".repeat(1500) + "B".repeat(5000) + "C".repeat(1500);
    const result = softTrimText(text);
    expect(result).toContain("A".repeat(1500));
    expect(result).toContain("C".repeat(1500));
    expect(result).toContain("[...trimmed 5000 chars...]");
    expect(result).not.toContain("B".repeat(100));
  });

  it("respects custom head/tail sizes", () => {
    const text = "A".repeat(100) + "B".repeat(800) + "C".repeat(100);
    const result = softTrimText(text, 100, 100);
    expect(result).toContain("A".repeat(100));
    expect(result).toContain("C".repeat(100));
    expect(result).toContain("[...trimmed 800 chars...]");
  });
});

// ── findFirstUserIndex ─────────────────────────────────────────────────

describe("findFirstUserIndex", () => {
  it("returns index of first user message", () => {
    const messages: ModelMessage[] = [
      assistantWithToolCall("tc-boot", "read_file", { path: "SOUL.md" }),
      toolResult("tc-boot", "read_file", "I am a bot"),
      userMsg("Hello"),
    ];
    expect(findFirstUserIndex(messages)).toBe(2);
  });

  it("returns messages.length when no user message exists", () => {
    const messages: ModelMessage[] = [
      assistantMsg("boot"),
    ];
    expect(findFirstUserIndex(messages)).toBe(1);
  });

  it("returns 0 when first message is user", () => {
    const messages: ModelMessage[] = [userMsg("Hi")];
    expect(findFirstUserIndex(messages)).toBe(0);
  });
});

// ── findToolAssistantCutoffIndex ────────────────────────────────────────

describe("findToolAssistantCutoffIndex", () => {
  it("returns index of the Nth-from-last assistant with tool calls", () => {
    const messages: ModelMessage[] = [
      userMsg("1"),
      assistantWithToolCall("tc-1", "exec"),
      toolResult("tc-1", "exec", "r1"),
      userMsg("2"),
      assistantWithToolCall("tc-2", "exec"),
      toolResult("tc-2", "exec", "r2"),
      userMsg("3"),
      assistantWithToolCall("tc-3", "exec"),
      toolResult("tc-3", "exec", "r3"),
      userMsg("4"),
      assistantWithToolCall("tc-4", "exec"),
      toolResult("tc-4", "exec", "r4"),
    ];
    // With keepCount=3, should protect tc-2, tc-3, tc-4 → cutoff at index 4
    expect(findToolAssistantCutoffIndex(messages, 3)).toBe(4);
  });

  it("skips plain-text assistant messages when counting", () => {
    const messages: ModelMessage[] = [
      userMsg("1"),
      assistantWithToolCall("tc-1", "exec"),
      toolResult("tc-1", "exec", "r1"),
      assistantMsg("thinking out loud"), // no tool call — should not count
      userMsg("2"),
      assistantWithToolCall("tc-2", "exec"),
      toolResult("tc-2", "exec", "r2"),
    ];
    // keepCount=2: protect tc-1 and tc-2 → cutoff at index 1
    expect(findToolAssistantCutoffIndex(messages, 2)).toBe(1);
  });

  it("returns 0 when fewer than keepCount tool-call assistants exist", () => {
    const messages: ModelMessage[] = [
      userMsg("1"),
      assistantWithToolCall("tc-1", "exec"),
      toolResult("tc-1", "exec", "r1"),
    ];
    expect(findToolAssistantCutoffIndex(messages, 3)).toBe(0);
  });
});

// ── pruneContextMessages ───────────────────────────────────────────────

describe("pruneContextMessages", () => {
  it("does not prune when context ratio is below soft-trim threshold", () => {
    const messages: ModelMessage[] = [
      userMsg("Hello"),
      assistantMsg("Hi there"),
    ];
    const { messages: result, stats } = pruneContextMessages(messages, { contextWindowTokens: 128_000 });
    expect(result).toBe(messages); // same reference — no copy
    expect(stats.softTrimmed).toBe(0);
    expect(stats.hardCleared).toBe(0);
  });

  it("soft-trims large tool results when above soft-trim threshold", () => {
    // Create messages that push context to ~35% of a small window
    // 10000 chars ≈ 4000 tokens. 4 results = ~16000 tokens. Window = 50000 → ratio ~32% (soft-trim only)
    const bigResult = longText(10000);
    const messages: ModelMessage[] = [
      userMsg("Do something"),
      assistantWithToolCall("tc-1", "exec"),
      toolResult("tc-1", "exec", bigResult),
      userMsg("Next"),
      assistantWithToolCall("tc-2", "read_file"),
      toolResult("tc-2", "read_file", bigResult),
      userMsg("More"),
      assistantWithToolCall("tc-3", "exec"),
      toolResult("tc-3", "exec", bigResult),
      userMsg("And more"),
      assistantWithToolCall("tc-4", "exec"),
      toolResult("tc-4", "exec", bigResult),
    ];

    // Window large enough to trigger soft-trim (>30%) but not hard-clear (<50%)
    const { messages: result, stats } = pruneContextMessages(messages, { contextWindowTokens: 50000 });

    expect(stats.softTrimmed).toBeGreaterThan(0);
    expect(stats.hardCleared).toBe(0);
    // First tool result (tc-1) should be soft-trimmed (not protected)
    const firstToolMsg = result[2] as any;
    const firstOutput = firstToolMsg.content[0].output.value;
    expect(firstOutput).toContain("[...trimmed");
    expect(firstOutput.length).toBeLessThan(bigResult.length);
  });

  it("protects bootstrap messages (before first user message)", () => {
    const bootResult = longText(10000);
    const messages: ModelMessage[] = [
      assistantWithToolCall("tc-boot", "read_file", { path: "SOUL.md" }),
      toolResult("tc-boot", "read_file", bootResult),
      userMsg("Hello"),
      assistantWithToolCall("tc-1", "exec"),
      toolResult("tc-1", "exec", longText(10000)),
    ];

    const { messages: result } = pruneContextMessages(messages, { contextWindowTokens: 3000 });

    // Bootstrap tool result (index 1) should NOT be trimmed
    const bootToolMsg = result[1] as any;
    expect(bootToolMsg.content[0].output.value).toBe(bootResult);
  });

  it("protects recent tool-call assistant blocks", () => {
    const bigResult = longText(10000);
    const messages: ModelMessage[] = [
      userMsg("1"),
      assistantWithToolCall("tc-1", "exec"),
      toolResult("tc-1", "exec", bigResult),
      userMsg("2"),
      assistantWithToolCall("tc-2", "exec"),
      toolResult("tc-2", "exec", bigResult),
      userMsg("3"),
      assistantWithToolCall("tc-3", "exec"),
      toolResult("tc-3", "exec", bigResult),
      userMsg("4"),
      assistantWithToolCall("tc-4", "exec"),
      toolResult("tc-4", "exec", bigResult),
    ];

    const { messages: result } = pruneContextMessages(messages, { contextWindowTokens: 5000 });

    // Last 3 tool-call assistants (tc-2, tc-3, tc-4) should be protected
    // tc-1 should be trimmed/cleared
    const tc1Result = (result[2] as any).content[0].output.value;
    expect(tc1Result).not.toBe(bigResult); // was modified

    // tc-4 (last) should be intact
    const tc4Result = (result[11] as any).content[0].output.value;
    expect(tc4Result).toBe(bigResult);
  });

  it("hard-clears when context ratio exceeds hard-clear threshold", () => {
    const hugeResult = longText(50000);
    const messages: ModelMessage[] = [
      userMsg("1"),
      assistantWithToolCall("tc-1", "exec"),
      toolResult("tc-1", "exec", hugeResult),
      userMsg("2"),
      assistantWithToolCall("tc-2", "exec"),
      toolResult("tc-2", "exec", hugeResult),
      userMsg("3"),
      assistantWithToolCall("tc-3", "exec"),
      toolResult("tc-3", "exec", hugeResult),
      userMsg("4"),
      assistantWithToolCall("tc-4", "exec"),
      toolResult("tc-4", "exec", "short result"),
      userMsg("5"),
      assistantWithToolCall("tc-5", "exec"),
      toolResult("tc-5", "exec", "short result"),
      userMsg("6"),
      assistantWithToolCall("tc-6", "exec"),
      toolResult("tc-6", "exec", "short result"),
    ];

    // Very small window to force hard-clear
    const { messages: result, stats } = pruneContextMessages(messages, { contextWindowTokens: 3000 });

    expect(stats.hardCleared).toBeGreaterThan(0);

    // tc-1 should be hard-cleared
    const tc1Result = (result[2] as any).content[0].output.value;
    expect(tc1Result).toContain("[Tool result cleared: exec,");
    expect(tc1Result).toContain("chars]");
  });

  it("does not hard-clear error results", () => {
    const errorResult = "[Error] Something went wrong\n\nDo not retry.";
    const bigResult = longText(50000);
    const messages: ModelMessage[] = [
      userMsg("1"),
      assistantWithToolCall("tc-err", "exec"),
      toolResult("tc-err", "exec", errorResult),
      userMsg("2"),
      assistantWithToolCall("tc-big1", "read_file"),
      toolResult("tc-big1", "read_file", bigResult),
      userMsg("3"),
      assistantWithToolCall("tc-big2", "exec"),
      toolResult("tc-big2", "exec", bigResult),
      userMsg("4"),
      // Need enough recent tool-call assistants to protect (3)
      assistantWithToolCall("tc-3", "exec"),
      toolResult("tc-3", "exec", "ok"),
      userMsg("5"),
      assistantWithToolCall("tc-4", "exec"),
      toolResult("tc-4", "exec", "ok"),
      userMsg("6"),
      assistantWithToolCall("tc-5", "exec"),
      toolResult("tc-5", "exec", "ok"),
    ];

    // Very small window to force hard-clear
    const { messages: result, stats } = pruneContextMessages(messages, { contextWindowTokens: 5000 });

    expect(stats.hardCleared).toBeGreaterThan(0);

    // Error result should NOT be cleared
    const errResult = (result[2] as any).content[0].output.value;
    expect(errResult).toContain("[Error]");

    // Big non-error result should be cleared
    const big1Cleared = (result[5] as any).content[0].output.value;
    expect(big1Cleared).toContain("[Tool result cleared:");
  });

  it("hard-clear placeholder includes toolName and original char count", () => {
    const bigResult = longText(20000);
    const messages: ModelMessage[] = [
      userMsg("1"),
      assistantWithToolCall("tc-1", "read_file"),
      toolResult("tc-1", "read_file", bigResult),
      userMsg("2"),
      assistantWithToolCall("tc-2", "exec"),
      toolResult("tc-2", "exec", bigResult),
      userMsg("3"),
      assistantWithToolCall("tc-3", "exec"),
      toolResult("tc-3", "exec", "ok"),
      userMsg("4"),
      assistantWithToolCall("tc-4", "exec"),
      toolResult("tc-4", "exec", "ok"),
      userMsg("5"),
      assistantWithToolCall("tc-5", "exec"),
      toolResult("tc-5", "exec", "ok"),
    ];

    const { messages: result, stats } = pruneContextMessages(messages, { contextWindowTokens: 4000 });

    expect(stats.hardCleared).toBeGreaterThan(0);
    // Placeholder should report original char count (20000), not post-soft-trim count
    const cleared = (result[2] as any).content[0].output.value;
    expect(cleared).toBe("[Tool result cleared: read_file, 20000 chars]");
  });

  it("does not mutate the original messages array", () => {
    const bigResult = longText(10000);
    const messages: ModelMessage[] = [
      userMsg("Hello"),
      assistantWithToolCall("tc-1", "exec"),
      toolResult("tc-1", "exec", bigResult),
      userMsg("More"),
      assistantWithToolCall("tc-2", "exec"),
      toolResult("tc-2", "exec", "ok"),
      userMsg("3"),
      assistantWithToolCall("tc-3", "exec"),
      toolResult("tc-3", "exec", "ok"),
      userMsg("4"),
      assistantWithToolCall("tc-4", "exec"),
      toolResult("tc-4", "exec", "ok"),
    ];

    const originalContent = (messages[2] as any).content[0].output.value;
    pruneContextMessages(messages, { contextWindowTokens: 3000 });

    // Original should be unchanged
    const afterContent = (messages[2] as any).content[0].output.value;
    expect(afterContent).toBe(originalContent);
  });

  it("handles tool results using 'result' field (D1 reconstructed format)", () => {
    const bigResult = longText(10000);
    const messages: ModelMessage[] = [
      userMsg("Hello"),
      assistantWithToolCall("tc-1", "exec"),
      toolResultWithResult("tc-1", "exec", bigResult),
      userMsg("More"),
      assistantWithToolCall("tc-2", "exec"),
      toolResultWithResult("tc-2", "exec", "ok"),
      userMsg("3"),
      assistantWithToolCall("tc-3", "exec"),
      toolResultWithResult("tc-3", "exec", "ok"),
      userMsg("4"),
      assistantWithToolCall("tc-4", "exec"),
      toolResultWithResult("tc-4", "exec", "ok"),
    ];

    const { messages: result, stats } = pruneContextMessages(messages, { contextWindowTokens: 3000 });

    // Should trim the result field
    expect(stats.softTrimmed).toBeGreaterThan(0);
    const trimmedResult = (result[2] as any).content[0].result;
    expect(trimmedResult).toContain("[...trimmed");
  });

  it("returns stats with token estimates", () => {
    const bigResult = longText(10000);
    const messages: ModelMessage[] = [
      userMsg("Hello"),
      assistantWithToolCall("tc-1", "exec"),
      toolResult("tc-1", "exec", bigResult),
      userMsg("More"),
      assistantWithToolCall("tc-2", "exec"),
      toolResult("tc-2", "exec", "ok"),
      userMsg("3"),
      assistantWithToolCall("tc-3", "exec"),
      toolResult("tc-3", "exec", "ok"),
      userMsg("4"),
      assistantWithToolCall("tc-4", "exec"),
      toolResult("tc-4", "exec", "ok"),
    ];

    const { stats } = pruneContextMessages(messages, { contextWindowTokens: 3000 });

    expect(stats.estimatedTokensBefore).toBeGreaterThan(0);
    expect(stats.estimatedTokensAfter).toBeGreaterThan(0);
    expect(stats.estimatedTokensAfter).toBeLessThanOrEqual(stats.estimatedTokensBefore);
  });

  it("handles empty messages array", () => {
    const { messages: result, stats } = pruneContextMessages([]);
    expect(result).toEqual([]);
    expect(stats.softTrimmed).toBe(0);
  });

  it("handles messages with no tool results", () => {
    const messages: ModelMessage[] = [
      userMsg("Hello"),
      assistantMsg("Hi"),
      userMsg("Bye"),
    ];
    const { messages: result, stats } = pruneContextMessages(messages, { contextWindowTokens: 100 });
    expect(stats.softTrimmed).toBe(0);
    expect(stats.hardCleared).toBe(0);
  });

  it("does not trim short tool results even when over soft-trim ratio", () => {
    // All tool results are short (< SOFT_TRIM_MAX_CHARS)
    const shortResult = longText(500);
    const messages: ModelMessage[] = [];
    // Create many messages to push ratio over 30%
    for (let i = 0; i < 20; i++) {
      messages.push(userMsg(`msg ${i}`));
      messages.push(assistantWithToolCall(`tc-${i}`, "exec"));
      messages.push(toolResult(`tc-${i}`, "exec", shortResult));
    }

    const { stats } = pruneContextMessages(messages, { contextWindowTokens: 3000 });

    // Short results should NOT be soft-trimmed (they're under SOFT_TRIM_MAX_CHARS)
    expect(stats.softTrimmed).toBe(0);
  });

  it("handles Anthropic system message (role=system in messages array)", () => {
    // Anthropic system prompt is embedded as the first message in the array
    const messages: ModelMessage[] = [
      { role: "system", content: [{ type: "text", text: "You are a helpful bot." }] } as any,
      userMsg("Hello"),
      assistantWithToolCall("tc-1", "exec"),
      toolResult("tc-1", "exec", longText(10000)),
      userMsg("More"),
      assistantWithToolCall("tc-2", "exec"),
      toolResult("tc-2", "exec", "ok"),
      userMsg("3"),
      assistantWithToolCall("tc-3", "exec"),
      toolResult("tc-3", "exec", "ok"),
      userMsg("4"),
      assistantWithToolCall("tc-4", "exec"),
      toolResult("tc-4", "exec", "ok"),
    ];

    // System message should not be touched, and first user at index 1
    const { messages: result } = pruneContextMessages(messages, { contextWindowTokens: 3000 });
    expect((result[0] as any).content[0].text).toBe("You are a helpful bot.");
  });
});

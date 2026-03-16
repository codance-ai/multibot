import { describe, it, expect, vi } from "vitest";

import { buildPromptAndHistory } from "./multibot-build";
import type { BotConfig } from "../config/schema";

// Minimal botConfig for tests
function makeBotConfig(overrides?: Partial<BotConfig>): BotConfig {
  return {
    ownerId: "owner1",
    botId: "bot1",
    name: "TestBot",
    botType: "normal",
    provider: "openai",
    model: "gpt-4o",
    channels: {},
    enabledSkills: [],
    memoryWindow: 50,
    maxIterations: 10,
    timezone: "UTC",
    ...overrides,
  } as BotConfig;
}

// Mock D1 database
// Rows must be in DESC order (newest first) to match real D1 behavior.
// getConversationHistory reverses them to ASC internally.
function mockDb(rows: Array<{ role: string; content: string | null; attachments?: string | null; bot_id?: string | null; tool_calls?: string | null; created_at?: string }>) {
  return {
    prepare: () => ({
      bind: () => ({
        all: async () => ({ results: rows }),
        run: async () => ({}),
        first: async () => null,
      }),
    }),
    batch: async () => [],
  } as unknown as D1Database;
}

describe("buildPromptAndHistory - tool call reconstruction", () => {
  it("reconstructs tool call + tool result messages from tool_calls JSON", async () => {
    const toolCalls = JSON.stringify([
      { toolCallId: "tc-1", toolName: "exec", input: { command: "echo hi" }, result: "hi" },
    ]);
    // DESC order: newest first
    const db = mockDb([
      { role: "assistant", content: "Done! Output was hi" },
      { role: "assistant", content: "Let me run that", tool_calls: toolCalls },
      { role: "user", content: "run echo hi" },
    ]);
    const { conversationHistory } = await buildPromptAndHistory({
      db, botConfig: makeBotConfig(), sessionId: "s1",
      channel: "telegram", chatId: "c1",
    });

    // Should have: user, assistant(tool-call), tool(result), assistant(text)
    expect(conversationHistory).toHaveLength(4);

    // First: user message
    expect(conversationHistory[0].role).toBe("user");

    // Second: assistant with tool-call part
    const assistantWithTool = conversationHistory[1];
    expect(assistantWithTool.role).toBe("assistant");
    const parts = assistantWithTool.content as any[];
    expect(parts).toHaveLength(2); // text + tool-call
    expect(parts[0]).toEqual({ type: "text", text: "Let me run that" });
    expect(parts[1]).toMatchObject({ type: "tool-call", toolCallId: "tc-1", toolName: "exec" });

    // Third: tool result
    const toolResult = conversationHistory[2];
    expect(toolResult.role).toBe("tool");
    const resultParts = toolResult.content as any[];
    expect(resultParts[0]).toMatchObject({ type: "tool-result", toolCallId: "tc-1", toolName: "exec", output: { type: "text", value: "hi" } });

    // Fourth: plain assistant text
    expect(conversationHistory[3].role).toBe("assistant");
  });

  it("handles assistant row with tool_calls but no text content", async () => {
    const toolCalls = JSON.stringify([
      { toolCallId: "tc-1", toolName: "load_skill", input: { name: "selfie" }, result: "loaded" },
    ]);
    // DESC order
    const db = mockDb([
      { role: "assistant", content: "Here's your photo" },
      { role: "assistant", content: null, tool_calls: toolCalls },
      { role: "user", content: "take a selfie" },
    ]);
    const { conversationHistory } = await buildPromptAndHistory({
      db, botConfig: makeBotConfig(), sessionId: "s1",
      channel: "telegram", chatId: "c1",
    });

    expect(conversationHistory).toHaveLength(4);

    // Assistant with tool-call only (no text part)
    const assistantWithTool = conversationHistory[1];
    const parts = assistantWithTool.content as any[];
    expect(parts).toHaveLength(1); // only tool-call, no text
    expect(parts[0]).toMatchObject({ type: "tool-call", toolCallId: "tc-1", toolName: "load_skill" });
  });

  it("does NOT inject <_ctx> tags into assistant messages", async () => {
    const toolCalls = JSON.stringify([
      { toolCallId: "tc-1", toolName: "exec", input: {}, result: "ok" },
    ]);
    const attachments = JSON.stringify([
      { r2Key: "media/bot1/img.png", mediaType: "image/png" },
    ]);
    // DESC order
    const db = mockDb([
      { role: "assistant", content: "Here it is", tool_calls: toolCalls, attachments },
      { role: "user", content: "generate image" },
    ]);
    const { conversationHistory } = await buildPromptAndHistory({
      db, botConfig: makeBotConfig(), sessionId: "s1",
      channel: "telegram", chatId: "c1",
    });

    // Check no <_ctx> in any message content
    for (const msg of conversationHistory) {
      const content = msg.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if ("text" in part && typeof part.text === "string") {
            expect(part.text).not.toContain("<_ctx");
          }
        }
      }
    }
  });

  it("handles multiple tool calls in one assistant message", async () => {
    const toolCalls = JSON.stringify([
      { toolCallId: "tc-1", toolName: "load_skill", input: { name: "selfie" }, result: "loaded" },
      { toolCallId: "tc-2", toolName: "exec", input: { command: "gen.py" }, result: "![img](image:/workspace/images/a.png)" },
    ]);
    // DESC order
    const db = mockDb([
      { role: "assistant", content: "Sure", tool_calls: toolCalls },
      { role: "user", content: "selfie" },
    ]);
    const { conversationHistory } = await buildPromptAndHistory({
      db, botConfig: makeBotConfig(), sessionId: "s1",
      channel: "telegram", chatId: "c1",
    });

    // user, assistant(text + 2 tool-calls), tool(2 results)
    expect(conversationHistory).toHaveLength(3);
    const assistantParts = conversationHistory[1].content as any[];
    expect(assistantParts).toHaveLength(3); // text + 2 tool-calls
    const toolParts = conversationHistory[2].content as any[];
    expect(toolParts).toHaveLength(2); // 2 results
  });

  it("falls back to plain text for assistant without tool_calls", async () => {
    // DESC order
    const db = mockDb([
      { role: "assistant", content: "hi there" },
      { role: "user", content: "hello" },
    ]);
    const { conversationHistory } = await buildPromptAndHistory({
      db, botConfig: makeBotConfig(), sessionId: "s1",
      channel: "telegram", chatId: "c1",
    });

    expect(conversationHistory).toHaveLength(2);
    expect(conversationHistory[0].role).toBe("user");
    expect(conversationHistory[1].role).toBe("assistant");
    const parts = conversationHistory[1].content as any[];
    expect(parts).toEqual([{ type: "text", text: "hi there" }]);
  });

  it("annotates user attachments with plain text (not XML)", async () => {
    const attachments = JSON.stringify([
      { r2Key: "media/bot1/img.png", mediaType: "image/jpeg" },
      { r2Key: "media/bot1/doc.pdf", mediaType: "application/pdf" },
    ]);
    // DESC order
    const db = mockDb([
      { role: "assistant", content: "I see an image and a PDF" },
      { role: "user", content: "check this", attachments },
    ]);
    const { conversationHistory } = await buildPromptAndHistory({
      db, botConfig: makeBotConfig(), sessionId: "s1",
      channel: "telegram", chatId: "c1",
    });

    // First message should be user with attachment annotation
    expect(conversationHistory[0].role).toBe("user");
    const userParts = conversationHistory[0].content as any[];
    expect(userParts[0].text).toContain("[User attached 1 image, 1 file]");
    expect(userParts[0].text).not.toContain("<_ctx");
  });

  it("skips generic fallback when message already contains [Attached:] metadata", async () => {
    const attachments = JSON.stringify([
      { r2Key: "media/bot1/data.bin", mediaType: "application/octet-stream" },
    ]);
    // Simulate effectiveUserMessage with metadata already appended (as coordinator does)
    const content = "check this file\n\n[Attached: data.bin (1.5 MB), type: application/octet-stream]";
    // DESC order
    const db = mockDb([
      { role: "assistant", content: "I see a binary file" },
      { role: "user", content, attachments },
    ]);
    const { conversationHistory } = await buildPromptAndHistory({
      db, botConfig: makeBotConfig(), sessionId: "s1",
      channel: "telegram", chatId: "c1",
    });

    expect(conversationHistory[0].role).toBe("user");
    const userParts = conversationHistory[0].content as any[];
    // Should contain the specific metadata but NOT the generic fallback
    expect(userParts[0].text).toContain("[Attached: data.bin");
    expect(userParts[0].text).not.toContain("[User attached");
  });

  it("reconstructs text file attachments from R2 in history", async () => {
    const csvContent = "name,age\nAlice,30\nBob,25";
    const attachments = JSON.stringify([
      { r2Key: "media/bot1/data.csv", mediaType: "text/csv", fileName: "data.csv" },
    ]);
    // DESC order: newest first
    const db = mockDb([
      { role: "assistant", content: "I see CSV data" },
      { role: "user", content: "analyze this", attachments },
    ]);
    const mockBucket = {
      get: async (key: string) => {
        if (key === "media/bot1/data.csv") {
          const bytes = new TextEncoder().encode(csvContent);
          return { arrayBuffer: async () => bytes.buffer };
        }
        return null;
      },
    } as unknown as R2Bucket;

    const { conversationHistory } = await buildPromptAndHistory({
      db, assetsBucket: mockBucket, botConfig: makeBotConfig(), sessionId: "s1",
      channel: "telegram", chatId: "c1",
    });

    expect(conversationHistory[0].role).toBe("user");
    const userParts = conversationHistory[0].content as any[];
    // Should have text part + text file content part
    expect(userParts.length).toBeGreaterThanOrEqual(2);
    const textFilePart = userParts.find((p: any) => p.type === "text" && p.text.includes("[File: data.csv]"));
    expect(textFilePart).toBeDefined();
    expect(textFilePart.text).toContain(csvContent);
  });

  it("truncates older text file attachments in history", async () => {
    // Create a text file larger than HISTORY_TEXT_ATTACHMENT_LIMIT (2000 chars)
    const longContent = "x".repeat(3000);
    const recentContent = "recent data here";
    const oldAttachments = JSON.stringify([
      { r2Key: "media/bot1/old.txt", mediaType: "text/plain", fileName: "old.txt" },
    ]);
    const recentAttachments = JSON.stringify([
      { r2Key: "media/bot1/recent.csv", mediaType: "text/csv", fileName: "recent.csv" },
    ]);
    // DESC order: newest first
    const db = mockDb([
      { role: "assistant", content: "got the new file" },
      { role: "user", content: "here is another", attachments: recentAttachments },
      { role: "assistant", content: "got it" },
      { role: "user", content: "check this old file", attachments: oldAttachments },
    ]);
    const mockBucket = {
      get: async (key: string) => {
        if (key === "media/bot1/old.txt") {
          const bytes = new TextEncoder().encode(longContent);
          return { arrayBuffer: async () => bytes.buffer };
        }
        if (key === "media/bot1/recent.csv") {
          const bytes = new TextEncoder().encode(recentContent);
          return { arrayBuffer: async () => bytes.buffer };
        }
        return null;
      },
    } as unknown as R2Bucket;

    const { conversationHistory } = await buildPromptAndHistory({
      db, assetsBucket: mockBucket, botConfig: makeBotConfig(), sessionId: "s1",
      channel: "telegram", chatId: "c1",
    });

    // Find the old text file part (first user message)
    const oldUserParts = conversationHistory[0].content as any[];
    const oldFilePart = oldUserParts.find((p: any) => p.type === "text" && p.text.includes("[File: old.txt]"));
    expect(oldFilePart).toBeDefined();
    // Should be truncated
    expect(oldFilePart.text).toContain("\u2026[truncated]");
    expect(oldFilePart.text.length).toBeLessThan(longContent.length);

    // Find the recent text file part (third message = second user message)
    const recentUserParts = conversationHistory[2].content as any[];
    const recentFilePart = recentUserParts.find((p: any) => p.type === "text" && p.text.includes("[File: recent.csv]"));
    expect(recentFilePart).toBeDefined();
    // Should NOT be truncated (latest attachment row)
    expect(recentFilePart.text).toContain(recentContent);
    expect(recentFilePart.text).not.toContain("[truncated]");
  });

  it("uses mediaType as label when fileName is not available", async () => {
    const jsonContent = '{"key": "value"}';
    const attachments = JSON.stringify([
      { r2Key: "media/bot1/data.json", mediaType: "application/json" },
    ]);
    const db = mockDb([
      { role: "assistant", content: "got it" },
      { role: "user", content: "check this", attachments },
    ]);
    const mockBucket = {
      get: async (key: string) => {
        if (key === "media/bot1/data.json") {
          const bytes = new TextEncoder().encode(jsonContent);
          return { arrayBuffer: async () => bytes.buffer };
        }
        return null;
      },
    } as unknown as R2Bucket;

    const { conversationHistory } = await buildPromptAndHistory({
      db, assetsBucket: mockBucket, botConfig: makeBotConfig(), sessionId: "s1",
      channel: "telegram", chatId: "c1",
    });

    const userParts = conversationHistory[0].content as any[];
    const filePart = userParts.find((p: any) => p.type === "text" && p.text.includes("[File: application/json]"));
    expect(filePart).toBeDefined();
    expect(filePart.text).toContain(jsonContent);
  });

  it("shows generic fallback for attachments without [Attached:] metadata in message", async () => {
    const attachments = JSON.stringify([
      { r2Key: "media/bot1/img.png", mediaType: "image/png" },
      { r2Key: "media/bot1/data.bin", mediaType: "application/octet-stream" },
    ]);
    // Message without metadata — old-style persistence
    const db = mockDb([
      { role: "assistant", content: "ok" },
      { role: "user", content: "check these", attachments },
    ]);
    const { conversationHistory } = await buildPromptAndHistory({
      db, botConfig: makeBotConfig(), sessionId: "s1",
      channel: "telegram", chatId: "c1",
    });

    expect(conversationHistory[0].role).toBe("user");
    const userParts = conversationHistory[0].content as any[];
    // Should still show generic fallback for old messages without metadata
    expect(userParts[0].text).toContain("[User attached 1 image, 1 file]");
  });
});

describe("buildPromptAndHistory - token budget trimming", () => {
  it("returns tokenUsage in result", async () => {
    const db = mockDb([
      { role: "assistant", content: "hi there", created_at: "2026-01-01 00:01" },
      { role: "user", content: "hello", created_at: "2026-01-01 00:00" },
    ]);
    const config = makeBotConfig({ contextWindow: 128000 });
    const result = await buildPromptAndHistory({
      db, botConfig: config, sessionId: "s1", channel: "test", chatId: "c1",
    });
    expect(result.tokenUsage).toBeDefined();
    expect(result.tokenUsage.contextWindow).toBe(128000);
    expect(result.tokenUsage.systemPromptTokens).toBeGreaterThan(0);
    expect(result.tokenUsage.historyTokens).toBeGreaterThanOrEqual(0);
    expect(result.tokenUsage.totalTokens).toBe(
      result.tokenUsage.systemPromptTokens + result.tokenUsage.historyTokens
    );
    expect(result.tokenUsage.usageRatio).toBeGreaterThan(0);
    expect(result.tokenUsage.usageRatio).toBeLessThan(1);
    expect(result.tokenUsage.trimmedCount).toBe(0);
  });

  it("trims oldest messages when history exceeds token budget", async () => {
    // Create messages with large CJK content
    const longContent = "这是一条很长的消息内容用于测试。".repeat(200);
    const rows = [];
    for (let i = 10; i >= 1; i--) {
      rows.push({
        role: i % 2 === 0 ? "assistant" : "user",
        content: longContent,
        created_at: `2026-01-01 00:${String(i).padStart(2, "0")}`,
      });
    }
    const db = mockDb(rows);
    const config = makeBotConfig({ contextWindow: 8000, memoryWindow: 50 });
    const result = await buildPromptAndHistory({
      db, botConfig: config, sessionId: "s1", channel: "test", chatId: "c1",
    });
    expect(result.tokenUsage.trimmedCount).toBeGreaterThan(0);
    // After trimming, usage ratio should be within budget (0.75) for history portion;
    // total ratio can be higher since it includes system prompt tokens
    expect(result.tokenUsage.usageRatio).toBeLessThan(1.0);
  });

  it("does not trim when context window is large enough", async () => {
    const rows = [
      { role: "assistant", content: "response", created_at: "2026-01-01 00:02" },
      { role: "user", content: "question", created_at: "2026-01-01 00:01" },
    ];
    const db = mockDb(rows);
    const config = makeBotConfig({ contextWindow: 128000, memoryWindow: 50 });
    const result = await buildPromptAndHistory({
      db, botConfig: config, sessionId: "s1", channel: "test", chatId: "c1",
    });
    expect(result.tokenUsage.trimmedCount).toBe(0);
    expect(result.conversationHistory.length).toBe(2);
  });
});

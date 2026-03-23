import { describe, it, expect, vi } from "vitest";
import { resolveAndNormalizeReply } from "./multibot-image";
import type { StoredMessage } from "./loop";

// Minimal sandbox client stub
const stubSandbox = { exec: vi.fn(), kill: vi.fn() };

function callResolve(params: {
  reply: string;
  toolResults?: string[];
  newMessages: StoredMessage[];
}) {
  return resolveAndNormalizeReply({
    reply: params.reply,
    toolResults: params.toolResults ?? [],
    newMessages: params.newMessages,
    sandboxClient: stubSandbox as any,
    botId: "bot1",
    webhookSecret: "secret",
    // No baseUrl → workspace resolution skipped; use pre-resolved /media/ refs in reply
  });
}

describe("resolveAndNormalizeReply", () => {
  it("preserves original content when normalized text is empty (single-iteration image bug)", async () => {
    // Bug scenario: LLM output text + tool_call in one iteration, loop ended.
    // reply (accumulatedText) contains only the image ref (text was sent via onProgress).
    // resolveAndNormalizeReply strips the image ref → normalized.text = "".
    // Without fix, lastAssistant.content would be overwritten to "".
    const messages: StoredMessage[] = [
      { role: "assistant", content: "既然你点名要这个，那......只给你看哦。", toolCalls: '[{"toolCallId":"tc1","toolName":"exec"}]', botId: "bot1", requestId: "req1" },
    ];

    const result = await callResolve({
      reply: "![selfie](image:/media/bot1/123.png)",
      newMessages: messages,
    });

    const lastAssistant = messages[0];
    // Content should be preserved, not overwritten to ""
    expect(lastAssistant.content).toBe("既然你点名要这个，那......只给你看哦。");
    // Return value normalizedText should be empty (for Telegram, avoid duplication)
    expect(result.normalizedText).toBe("");
  });

  it("uses normalized text when it is non-empty (normal two-iteration case)", async () => {
    // Normal case: LLM called tool without text (iteration 1), then output text + image ref (iteration 2).
    const messages: StoredMessage[] = [
      { role: "assistant", content: null, toolCalls: '[{"toolCallId":"tc1","toolName":"exec"}]', botId: "bot1", requestId: "req1" },
      { role: "tool", content: "image generated", toolCallId: "tc1", toolName: "exec" },
      { role: "assistant", content: "行行行，这就给你发。\n![selfie](image:/media/bot1/456.png)", botId: "bot1", requestId: "req1" },
    ];

    const result = await callResolve({
      reply: "行行行，这就给你发。\n![selfie](image:/media/bot1/456.png)",
      newMessages: messages,
    });

    const lastAssistant = [...messages].reverse().find(m => m.role === "assistant")!;
    // Normalized text should be used (image ref stripped, text preserved)
    expect(lastAssistant.content).toBe("行行行，这就给你发。");
    expect(result.normalizedText).toBe("行行行，这就给你发。");
  });

  it("keeps empty content when both normalized and original are empty", async () => {
    const messages: StoredMessage[] = [
      { role: "assistant", content: "", botId: "bot1", requestId: "req1" },
    ];

    const result = await callResolve({
      reply: "",
      newMessages: messages,
    });

    expect(messages[0].content).toBe("");
    expect(result.normalizedText).toBe("");
  });

  it("keeps null content when normalized text is empty and original is null", async () => {
    const messages: StoredMessage[] = [
      { role: "assistant", content: null, botId: "bot1", requestId: "req1" },
    ];

    const result = await callResolve({
      reply: "",
      newMessages: messages,
    });

    expect(messages[0].content).toBeNull();
    expect(result.normalizedText).toBe("");
  });
});

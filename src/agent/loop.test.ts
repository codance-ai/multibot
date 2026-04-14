import { describe, it, expect, vi, beforeEach } from "vitest";
import { convertToStoredMessages, formatToolHint, wrapToolsWithErrorHandling, runAgentLoop, mergeConsecutiveUserMessages, mergeConsecutiveMessages, TOOL_RESULT_MAX_LENGTH } from "./loop";
import type { ModelMessage, ToolSet } from "ai";
import { tool } from "ai";
import { z } from "zod";

// Mock generateText for runAgentLoop tests
vi.mock("ai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("ai")>();
  return {
    ...actual,
    generateText: vi.fn(),
    stepCountIs: () => 1, // stub — not used in assertions
  };
});

import { generateText } from "ai";
const mockGenerateText = vi.mocked(generateText);

beforeEach(() => {
  mockGenerateText.mockReset();
});

describe("convertToStoredMessages", () => {
  it("converts assistant text message", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello!" }],
      },
    ];
    const stored = convertToStoredMessages(messages, "bot-1", "req-1");
    expect(stored).toEqual([
      {
        role: "assistant",
        content: "Hello!",
        toolCalls: null,
        botId: "bot-1",
        requestId: "req-1",
      },
    ]);
  });

  it("converts assistant message with tool calls", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Let me search." },
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "web_search",
            input: { query: "test" },
          },
        ],
      },
    ];
    const stored = convertToStoredMessages(messages, "bot-1", "req-1");
    expect(stored).toHaveLength(1);
    expect(stored[0].role).toBe("assistant");
    expect(stored[0].content).toBe("Let me search.");
    const toolCalls = JSON.parse(stored[0].toolCalls!);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolCallId).toBe("tc-1");
    expect(toolCalls[0].toolName).toBe("web_search");
    expect(stored[0].botId).toBe("bot-1");
    expect(stored[0].requestId).toBe("req-1");
  });

  it("converts tool result messages (in-memory, not persisted to D1)", () => {
    const messages: ModelMessage[] = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "web_search",
            output: { type: "text", value: "Search results here" },
          },
        ],
      },
    ];
    const stored = convertToStoredMessages(messages);
    expect(stored).toEqual([
      {
        role: "tool",
        content: "Search results here",
        toolCallId: "tc-1",
        toolName: "web_search",
      },
    ]);
  });

  it("stores all tool calls including duplicated tool names", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "memory_read",
            input: { file: "MEMORY.md" },
          },
          {
            type: "tool-call",
            toolCallId: "tc-2",
            toolName: "memory_read",
            input: { file: "HISTORY.md" },
          },
        ],
      },
    ];
    const stored = convertToStoredMessages(messages);
    expect(JSON.parse(stored[0].toolCalls!)).toHaveLength(2);
  });

  it("handles assistant message with only tool calls (no text)", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "web_search",
            input: { query: "test" },
          },
        ],
      },
    ];
    const stored = convertToStoredMessages(messages);
    expect(stored[0].content).toBeNull();
    expect(stored[0].toolCalls).not.toBeNull();
  });

  it("handles mixed assistant and tool messages in sequence", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "Searching..." },
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "web_search",
            input: { query: "test" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "web_search",
            output: { type: "text", value: "Found results" },
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here are the results." }],
      },
    ];
    const stored = convertToStoredMessages(messages);
    expect(stored).toHaveLength(3);
    expect(stored[0].role).toBe("assistant");
    expect(stored[0].toolCalls).not.toBeNull();
    expect(stored[1].role).toBe("tool");
    expect(stored[2].role).toBe("assistant");
    expect(stored[2].toolCalls).toBeNull();
  });

  it("returns empty array for empty input", () => {
    expect(convertToStoredMessages([])).toEqual([]);
  });

  it("ignores user messages", () => {
    const messages: ModelMessage[] = [
      {
        role: "user",
        content: [{ type: "text", text: "hello" }],
      },
    ];
    expect(convertToStoredMessages(messages)).toEqual([]);
  });

  it("merges tool result into preceding assistant tool call", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "web_search",
            input: { query: "test" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "web_search",
            output: { type: "text", value: "Search results here" },
          },
        ],
      },
    ];
    const stored = convertToStoredMessages(messages);
    expect(stored).toHaveLength(2);
    const toolCalls = JSON.parse(stored[0].toolCalls!);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].toolCallId).toBe("tc-1");
    expect(toolCalls[0].result).toBe("Search results here");
  });

  it("truncates long tool results to TOOL_RESULT_MAX_LENGTH chars", () => {
    const longResult = "x".repeat(1000);
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "exec",
            input: { command: "cat big_file.txt" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "exec",
            output: { type: "text", value: longResult },
          },
        ],
      },
    ];
    const stored = convertToStoredMessages(messages);
    const toolCalls = JSON.parse(stored[0].toolCalls!);
    expect(toolCalls[0].result).toHaveLength(TOOL_RESULT_MAX_LENGTH);
    expect(toolCalls[0].result).toBe("x".repeat(TOOL_RESULT_MAX_LENGTH));
  });

  it("merges multiple tool results to matching tool calls", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "web_search",
            input: { query: "cats" },
          },
          {
            type: "tool-call",
            toolCallId: "tc-2",
            toolName: "exec",
            input: { command: "echo hi" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "web_search",
            output: { type: "text", value: "cat pics" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-2",
            toolName: "exec",
            output: { type: "text", value: "hi" },
          },
        ],
      },
    ];
    const stored = convertToStoredMessages(messages);
    const toolCalls = JSON.parse(stored[0].toolCalls!);
    expect(toolCalls).toHaveLength(2);
    expect(toolCalls[0].toolCallId).toBe("tc-1");
    expect(toolCalls[0].result).toBe("cat pics");
    expect(toolCalls[1].toolCallId).toBe("tc-2");
    expect(toolCalls[1].result).toBe("hi");
  });

  it("handles interleaved assistant/tool blocks", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "web_search",
            input: { query: "q1" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "web_search",
            output: { type: "text", value: "result-1" },
          },
        ],
      },
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-2",
            toolName: "exec",
            input: { command: "ls" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-2",
            toolName: "exec",
            output: { type: "text", value: "result-2" },
          },
        ],
      },
    ];
    const stored = convertToStoredMessages(messages);
    expect(stored).toHaveLength(4);
    // First assistant gets result-1
    const tc1 = JSON.parse(stored[0].toolCalls!);
    expect(tc1[0].result).toBe("result-1");
    // Second assistant gets result-2
    const tc2 = JSON.parse(stored[2].toolCalls!);
    expect(tc2[0].result).toBe("result-2");
  });

  it("handles object-valued tool results", () => {
    const messages: ModelMessage[] = [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "tc-1",
            toolName: "api_call",
            input: { url: "https://example.com" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "tc-1",
            toolName: "api_call",
            output: { type: "json", value: { status: "ok", count: 42 } },
          },
        ],
      },
    ];
    const stored = convertToStoredMessages(messages);
    const toolCalls = JSON.parse(stored[0].toolCalls!);
    // Object results get JSON.stringified by existing logic, so result should be a string
    expect(typeof toolCalls[0].result).toBe("string");
    expect(toolCalls[0].result).toBe('{"status":"ok","count":42}');
  });
});

describe("wrapToolsWithErrorHandling", () => {
  it("passes through successful tool results unchanged", async () => {
    const tools: ToolSet = {
      my_tool: tool({
        description: "test",
        inputSchema: z.object({ x: z.string() }),
        execute: async ({ x }) => `ok: ${x}`,
      }),
    };
    const wrapped = wrapToolsWithErrorHandling(tools);
    const result = await (wrapped.my_tool as any).execute({ x: "hello" }, {} as any);
    expect(result).toBe("ok: hello");
  });

  it("catches thrown Error and returns formatted message", async () => {
    const tools: ToolSet = {
      failing_tool: tool({
        description: "test",
        inputSchema: z.object({}),
        execute: async () => { throw new Error("API key expired"); },
      }),
    };
    const wrapped = wrapToolsWithErrorHandling(tools);
    const result = await (wrapped.failing_tool as any).execute({}, {} as any);
    expect(result).toContain("[Error] API key expired");
    expect(result).toContain("Do not retry automatically");
  });

  it("catches thrown non-Error and returns formatted message", async () => {
    const tools: ToolSet = {
      failing_tool: tool({
        description: "test",
        inputSchema: z.object({}),
        execute: async () => { throw "string error"; },
      }),
    };
    const wrapped = wrapToolsWithErrorHandling(tools);
    const result = await (wrapped.failing_tool as any).execute({}, {} as any);
    expect(result).toContain("[Error] string error");
  });

  it("preserves tools without execute (declaration-only)", () => {
    const tools: ToolSet = {
      no_exec: {
        description: "no execute",
        parameters: z.object({}),
      } as any,
    };
    const wrapped = wrapToolsWithErrorHandling(tools);
    expect(wrapped.no_exec).toBe(tools.no_exec);
  });

  it("calls onToolStart before executing tool", async () => {
    const callOrder: string[] = [];
    const onToolStart = vi.fn(async () => { callOrder.push("hint"); });
    const tools: ToolSet = {
      web_search: tool({
        description: "test",
        inputSchema: z.object({ query: z.string() }),
        execute: async ({ query }) => { callOrder.push("execute"); return `results for ${query}`; },
      }),
    };
    const wrapped = wrapToolsWithErrorHandling(tools, onToolStart);
    const result = await (wrapped.web_search as any).execute({ query: "test" }, {} as any);

    expect(onToolStart).toHaveBeenCalledWith("web_search", { query: "test" });
    expect(result).toBe("results for test");
    expect(callOrder).toEqual(["hint", "execute"]);
  });

  it("does not send hint when onToolStart is undefined", async () => {
    const tools: ToolSet = {
      my_tool: tool({
        description: "test",
        inputSchema: z.object({ x: z.string() }),
        execute: async ({ x }) => `ok: ${x}`,
      }),
    };
    const wrapped = wrapToolsWithErrorHandling(tools); // no onToolStart
    const result = await (wrapped.my_tool as any).execute({ x: "hello" }, {} as any);
    expect(result).toBe("ok: hello");
  });

  it("still executes tool if onToolStart throws", async () => {
    const onToolStart = vi.fn(async () => { throw new Error("channel send failed"); });
    const tools: ToolSet = {
      my_tool: tool({
        description: "test",
        inputSchema: z.object({ x: z.string() }),
        execute: async ({ x }) => `ok: ${x}`,
      }),
    };
    const wrapped = wrapToolsWithErrorHandling(tools, onToolStart);
    const result = await (wrapped.my_tool as any).execute({ x: "hello" }, {} as any);
    expect(result).toBe("ok: hello");
    expect(onToolStart).toHaveBeenCalled();
  });
});

describe("formatToolHint", () => {
  it("formats a single tool call with string arg", () => {
    const result = formatToolHint([
      { toolName: "exec", input: { command: "ls -la" } },
    ]);
    expect(result).toBe('exec("ls -la")');
  });

  it("truncates args longer than 40 chars", () => {
    const longArg = "a".repeat(50);
    const result = formatToolHint([
      { toolName: "exec", input: { command: longArg } },
    ]);
    expect(result).toBe(`exec("${"a".repeat(40)}…")`);
  });

  it("joins multiple tool calls with comma", () => {
    const result = formatToolHint([
      { toolName: "exec", input: { command: "ls" } },
      { toolName: "web_search", input: { query: "test" } },
    ]);
    expect(result).toBe('exec("ls"), web\\_search("test")');
  });

  it("shows only tool name when first arg is not a string", () => {
    const result = formatToolHint([
      { toolName: "memory_read", input: { lines: 10 } },
    ]);
    expect(result).toBe("memory\\_read");
  });

  it("shows only tool name when args is empty", () => {
    const result = formatToolHint([{ toolName: "list_schedules", input: {} }]);
    expect(result).toBe("list\\_schedules");
  });

  it("escapes multiple underscores to prevent Markdown italic", () => {
    const result = formatToolHint([
      { toolName: "send_to_group", input: { message: "hello" } },
    ]);
    expect(result).toBe('send\\_to\\_group("hello")');
  });
});

describe("mergeConsecutiveUserMessages", () => {
  it("merges two consecutive user text messages", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "user", content: "world" },
    ];
    const result = mergeConsecutiveUserMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    expect(result[0].content).toEqual([{ type: "text", text: "hello\n\nworld" }]);
  });

  it("merges three consecutive user messages", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "one" },
      { role: "user", content: "two" },
      { role: "user", content: "three" },
    ];
    const result = mergeConsecutiveUserMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toEqual([{ type: "text", text: "one\n\ntwo\n\nthree" }]);
  });

  it("does not merge user messages separated by assistant", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
      { role: "user", content: "bye" },
    ];
    const result = mergeConsecutiveUserMessages(messages);
    expect(result).toHaveLength(3);
    expect(result[0].content).toBe("hello");
    expect(result[2].content).toBe("bye");
  });

  it("merges array content (text + images)", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: [{ type: "text", text: "look at this" }] as any },
      { role: "user", content: [
        { type: "image", image: new Uint8Array([1]), mediaType: "image/png" },
        { type: "text", text: "what is it?" },
      ] as any },
    ];
    const result = mergeConsecutiveUserMessages(messages);
    expect(result).toHaveLength(1);
    const content = result[0].content as any[];
    expect(content).toHaveLength(3);
    expect(content[0]).toEqual({ type: "text", text: "look at this" });
    expect(content[1]).toEqual({ type: "image", image: new Uint8Array([1]), mediaType: "image/png" });
    expect(content[2]).toEqual({ type: "text", text: "what is it?" });
  });

  it("returns empty array for empty input", () => {
    expect(mergeConsecutiveUserMessages([])).toEqual([]);
  });

  it("returns single message unchanged", () => {
    const messages: ModelMessage[] = [{ role: "user", content: "solo" }];
    const result = mergeConsecutiveUserMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("solo");
  });

  it("does not merge system messages", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "sys1" },
      { role: "system", content: "sys2" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ];
    const result = mergeConsecutiveUserMessages(messages);
    expect(result).toHaveLength(4);
  });

  it("preserves non-user messages around merged user messages", () => {
    const messages: ModelMessage[] = [
      { role: "system", content: "prompt" },
      { role: "user", content: "msg1" },
      { role: "user", content: "msg2" },
      { role: "assistant", content: "reply" },
      { role: "user", content: "msg3" },
    ];
    const result = mergeConsecutiveUserMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[0].role).toBe("system");
    expect(result[1].role).toBe("user");
    expect(result[1].content).toEqual([{ type: "text", text: "msg1\n\nmsg2" }]);
    expect(result[2].role).toBe("assistant");
    expect(result[3].role).toBe("user");
    expect(result[3].content).toBe("msg3");
  });

  it("skips empty-content user messages during merge", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "user", content: "" },
      { role: "user", content: "world" },
    ];
    const result = mergeConsecutiveUserMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toEqual([{ type: "text", text: "hello\n\nworld" }]);
  });

  it("replaces empty previous with non-empty current", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "" },
      { role: "user", content: "hello" },
    ];
    const result = mergeConsecutiveUserMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("hello");
  });

  it("handles mixed string and array content", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "text message" },
      { role: "user", content: [{ type: "text", text: "array message" }] as any },
    ];
    const result = mergeConsecutiveUserMessages(messages);
    expect(result).toHaveLength(1);
    expect(result[0].content).toEqual([{ type: "text", text: "text message\n\narray message" }]);
  });
});

describe("mergeConsecutiveMessages — assistant merging", () => {
  it("merges two consecutive text-only assistant messages", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "how are you?" },
    ];
    const result = mergeConsecutiveMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[1].role).toBe("assistant");
    expect(result[1].content).toEqual([{ type: "text", text: "hello\n\nhow are you?" }]);
  });

  it("merges three consecutive text-only assistant messages", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "one" },
      { role: "assistant", content: "two" },
      { role: "assistant", content: "three" },
    ];
    const result = mergeConsecutiveMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[1].content).toEqual([{ type: "text", text: "one\n\ntwo\n\nthree" }]);
  });

  it("does not merge assistant message with tool-call parts into previous", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "let me check" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "exec", args: {} }] as any },
    ];
    const result = mergeConsecutiveMessages(messages);
    expect(result).toHaveLength(3);
    expect(result[1].content).toBe("let me check");
    expect(result[2].content).toEqual([{ type: "tool-call", toolCallId: "1", toolName: "exec", args: {} }]);
  });

  it("does not merge text into previous assistant message with tool-call parts", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "exec", args: {} }] as any },
      { role: "assistant", content: "done" },
    ];
    const result = mergeConsecutiveMessages(messages);
    expect(result).toHaveLength(3);
  });

  it("does not merge across tool result messages", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "1", toolName: "exec", args: {} }] as any },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "1", result: "ok" }] as any },
      { role: "assistant", content: "first reply" },
      { role: "assistant", content: "second reply" },
    ];
    const result = mergeConsecutiveMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[3].content).toEqual([{ type: "text", text: "first reply\n\nsecond reply" }]);
  });

  it("still merges consecutive user messages", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hello" },
      { role: "user", content: "world" },
      { role: "assistant", content: "hi" },
    ];
    const result = mergeConsecutiveMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[0].content).toEqual([{ type: "text", text: "hello\n\nworld" }]);
  });

  it("handles group chat pattern: cron messages creating consecutive assistants", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "some message" },
      { role: "assistant", content: "selfie reply with image" },
      { role: "assistant", content: "cron daily post" },
      { role: "user", content: "<group_reply from=\"小晚\">nice</group_reply>" },
      { role: "assistant", content: "thanks!" },
    ];
    const result = mergeConsecutiveMessages(messages);
    expect(result).toHaveLength(4);
    expect(result[1].content).toEqual([{ type: "text", text: "selfie reply with image\n\ncron daily post" }]);
    expect(result[2].content).toBe("<group_reply from=\"小晚\">nice</group_reply>");
    expect(result[3].content).toBe("thanks!");
  });

  it("skips empty assistant messages during merge", () => {
    const messages: ModelMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "" },
      { role: "assistant", content: "world" },
    ];
    const result = mergeConsecutiveMessages(messages);
    expect(result).toHaveLength(2);
    expect(result[1].content).toEqual([{ type: "text", text: "hello\n\nworld" }]);
  });
});

describe("runAgentLoop", () => {
  const dummyModel = {} as any;
  const baseParams = {
    model: dummyModel,
    systemPrompt: "You are a bot.",
    userMessage: "take a selfie",
    conversationHistory: [] as ModelMessage[],
    tools: {},
    maxIterations: 5,
  };

  /** Helper: create a mock generateText result */
  function mockResult(opts: {
    text?: string;
    toolCalls?: Array<{ toolCallId: string; toolName: string; input: unknown }>;
    finishReason?: string;
    messages?: ModelMessage[];
  }) {
    return {
      text: opts.text ?? "",
      toolCalls: opts.toolCalls ?? [],
      finishReason: opts.finishReason ?? "end-turn",
      usage: { inputTokens: 10, outputTokens: 5 },
      response: {
        modelId: "test-model",
        messages: opts.messages ?? ([] as ModelMessage[]),
      },
    };
  }

  it("groups tool calls under detected skill via skillCalls", async () => {
    // Iteration 1: LLM calls load_skill("selfie") → tool-calls finish reason
    // Iteration 2: LLM produces final text → end-turn
    mockGenerateText
      .mockResolvedValueOnce(mockResult({
        toolCalls: [
          { toolCallId: "tc-1", toolName: "load_skill", input: { name: "selfie" } },
        ],
        finishReason: "tool-calls",
      }) as any)
      .mockResolvedValueOnce(mockResult({
        text: "Here is your selfie!",
        finishReason: "end-turn",
      }) as any);

    const result = await runAgentLoop(baseParams);
    expect(result.skillCalls).toHaveLength(1);
    expect(result.skillCalls[0].skill).toBe("selfie");
    expect(result.skillCalls[0].tools[0].name).toBe("load_skill");
  });

  it("groups multiple load_skill calls for same skill together", async () => {
    mockGenerateText
      .mockResolvedValueOnce(mockResult({
        toolCalls: [
          { toolCallId: "tc-1", toolName: "load_skill", input: { name: "selfie" } },
        ],
        finishReason: "tool-calls",
      }) as any)
      .mockResolvedValueOnce(mockResult({
        toolCalls: [
          { toolCallId: "tc-2", toolName: "load_skill", input: { name: "selfie" } },
        ],
        finishReason: "tool-calls",
      }) as any)
      .mockResolvedValueOnce(mockResult({
        text: "Done",
        finishReason: "end-turn",
      }) as any);

    const result = await runAgentLoop(baseParams);
    expect(result.skillCalls).toHaveLength(1);
    expect(result.skillCalls[0].skill).toBe("selfie");
    expect(result.skillCalls[0].tools).toHaveLength(2);
  });

  it("tracks multiple different skills in separate skillCalls", async () => {
    mockGenerateText
      .mockResolvedValueOnce(mockResult({
        toolCalls: [
          { toolCallId: "tc-1", toolName: "load_skill", input: { name: "selfie" } },
          { toolCallId: "tc-2", toolName: "load_skill", input: { name: "weather" } },
        ],
        finishReason: "tool-calls",
      }) as any)
      .mockResolvedValueOnce(mockResult({
        text: "Done",
        finishReason: "end-turn",
      }) as any);

    const result = await runAgentLoop(baseParams);
    // Each load_skill sets currentSkill before the tool call is bucketed
    expect(result.skillCalls).toHaveLength(2);
    const skillNames = result.skillCalls.map(s => s.skill);
    expect(skillNames).toContain("selfie");
    expect(skillNames).toContain("weather");
  });

  it("puts non-skill tool calls under empty-string skill", async () => {
    mockGenerateText
      .mockResolvedValueOnce(mockResult({
        toolCalls: [
          { toolCallId: "tc-1", toolName: "read_file", input: { path: "/workspace/notes.txt" } },
        ],
        finishReason: "tool-calls",
      }) as any)
      .mockResolvedValueOnce(mockResult({
        text: "Result",
        finishReason: "end-turn",
      }) as any);

    const result = await runAgentLoop(baseParams);
    expect(result.skillCalls).toHaveLength(1);
    expect(result.skillCalls[0].skill).toBe("");
    expect(result.skillCalls[0].tools[0].name).toBe("read_file");
  });

  it("marks isError when tool result starts with [Error]", async () => {
    mockGenerateText
      .mockResolvedValueOnce(mockResult({
        toolCalls: [
          { toolCallId: "tc-err", toolName: "exec", input: { command: "bad" } },
        ],
        finishReason: "tool-calls",
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool-call", toolCallId: "tc-err", toolName: "exec", args: { command: "bad" } }],
          },
          {
            role: "tool",
            content: [{ type: "tool-result", toolCallId: "tc-err", toolName: "exec", output: { type: "text", value: "[Error] Command failed\n\nDo not retry." } }],
          },
        ] as ModelMessage[],
      }) as any)
      .mockResolvedValueOnce(mockResult({
        text: "The command failed.",
        finishReason: "end-turn",
      }) as any);

    const result = await runAgentLoop(baseParams);
    expect(result.skillCalls).toHaveLength(1);
    const toolCall = result.skillCalls[0].tools[0];
    expect(toolCall.name).toBe("exec");
    expect(toolCall.isError).toBe(true);
    expect(toolCall.result).toContain("[Error]");
  });

  it("sends intermediate text via onProgress and only returns final text in reply", async () => {
    const onProgress = vi.fn();
    // Iteration 1: LLM says text + tool call
    mockGenerateText
      .mockResolvedValueOnce(mockResult({
        text: "Let me take a photo for you.",
        toolCalls: [
          { toolCallId: "tc-1", toolName: "exec", input: { command: "gen.py" } },
        ],
        finishReason: "tool-calls",
      }) as any)
      // Iteration 2: LLM says final text
      .mockResolvedValueOnce(mockResult({
        text: "Here you go!",
        finishReason: "end-turn",
      }) as any);

    const result = await runAgentLoop({ ...baseParams, onProgress });
    // Intermediate text NOT in reply
    expect(result.reply).toBe("Here you go!");
    // Intermediate text sent via onProgress (before tool hint)
    expect(onProgress).toHaveBeenCalledWith("Let me take a photo for you.");
  });

  it("suppresses tool hints when sendToolHints is false", async () => {
    const onProgress = vi.fn();
    mockGenerateText
      .mockResolvedValueOnce(mockResult({
        text: "Let me check.",
        toolCalls: [
          { toolCallId: "tc-1", toolName: "exec", input: { command: "ls" } },
        ],
        finishReason: "tool-calls",
      }) as any)
      .mockResolvedValueOnce(mockResult({
        text: "Done.",
        finishReason: "end-turn",
      }) as any);

    await runAgentLoop({ ...baseParams, onProgress, sendToolHints: false });
    // Text progress should still be sent
    expect(onProgress).toHaveBeenCalledWith("Let me check.");
    // Tool hints should NOT be sent
    const calls = onProgress.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.every((c: string) => !c.includes("exec"))).toBe(true);
  });

  it("sends intermediate text via onProgress during tool call iterations", async () => {
    const onProgress = vi.fn();
    mockGenerateText
      .mockResolvedValueOnce(mockResult({
        text: "Checking...",
        toolCalls: [
          { toolCallId: "tc-1", toolName: "web_search", input: { query: "test" } },
        ],
        finishReason: "tool-calls",
      }) as any)
      .mockResolvedValueOnce(mockResult({
        text: "Found it.",
        finishReason: "end-turn",
      }) as any);

    await runAgentLoop({ ...baseParams, onProgress, sendToolHints: true });
    const calls = onProgress.mock.calls.map((c: any[]) => c[0] as string);
    expect(calls.some((c: string) => c.includes("Checking..."))).toBe(true);
  });

  it("wires onToolStart to onProgress when sendToolHints is true", async () => {
    // Provide a real tool so we can verify hint is sent when tool executes.
    // Mock generateText to call the tool's execute directly (simulating AI SDK behavior).
    const onProgress = vi.fn();
    const realTool = tool({
      description: "test search",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => `results for ${query}`,
    });

    mockGenerateText.mockImplementationOnce(async (opts: any) => {
      // Simulate AI SDK calling the tool's execute during generateText
      if (opts.tools?.web_search?.execute) {
        await opts.tools.web_search.execute({ query: "hello" }, {} as any);
      }
      return mockResult({
        toolCalls: [
          { toolCallId: "tc-1", toolName: "web_search", input: { query: "hello" } },
        ],
        finishReason: "tool-calls",
      });
    }).mockResolvedValueOnce(mockResult({
      text: "Done.",
      finishReason: "end-turn",
    }) as any);

    await runAgentLoop({
      ...baseParams,
      tools: { web_search: realTool },
      onProgress,
      sendToolHints: true,
    });

    const calls = onProgress.mock.calls.map((c: any[]) => c[0] as string);
    // Verify the hint was sent with tool name (underscores escaped for Markdown)
    expect(calls.some((c: string) => c.includes("web\\_search"))).toBe(true);
  });

  it("does not wire onToolStart when sendToolHints is false", async () => {
    const onProgress = vi.fn();
    const realTool = tool({
      description: "test search",
      inputSchema: z.object({ query: z.string() }),
      execute: async ({ query }) => `results for ${query}`,
    });

    mockGenerateText.mockImplementationOnce(async (opts: any) => {
      if (opts.tools?.web_search?.execute) {
        await opts.tools.web_search.execute({ query: "hello" }, {} as any);
      }
      return mockResult({
        toolCalls: [
          { toolCallId: "tc-1", toolName: "web_search", input: { query: "hello" } },
        ],
        finishReason: "tool-calls",
      });
    }).mockResolvedValueOnce(mockResult({
      text: "Done.",
      finishReason: "end-turn",
    }) as any);

    await runAgentLoop({
      ...baseParams,
      tools: { web_search: realTool },
      onProgress,
      sendToolHints: false,
    });

    const calls = onProgress.mock.calls.map((c: any[]) => c[0] as string);
    // No tool hint should be sent
    expect(calls.every((c: string) => !c.includes("web\\_search"))).toBe(true);
  });

  it("accumulates intermediate text into reply when onProgress is undefined (group chat)", async () => {
    mockGenerateText
      .mockResolvedValueOnce(mockResult({
        text: "Thinking out loud...",
        toolCalls: [
          { toolCallId: "tc-1", toolName: "exec", input: { command: "search" } },
        ],
        finishReason: "tool-calls",
      }) as any)
      .mockResolvedValueOnce(mockResult({
        text: "Final answer.",
        finishReason: "end-turn",
      }) as any);

    // No onProgress provided (group chat scenario)
    const result = await runAgentLoop(baseParams);
    expect(result.reply).toBe("Thinking out loud...\n\nFinal answer.");
  });

  it("returns single text when only one iteration produces text", async () => {
    mockGenerateText
      .mockResolvedValueOnce(mockResult({
        toolCalls: [
          { toolCallId: "tc-1", toolName: "load_skill", input: { name: "selfie" } },
        ],
        finishReason: "tool-calls",
      }) as any)
      .mockResolvedValueOnce(mockResult({
        text: "Done!",
        finishReason: "end-turn",
      }) as any);

    const result = await runAgentLoop(baseParams);
    expect(result.reply).toBe("Done!");
  });

  it("omits empty text part for image-only input", async () => {
    mockGenerateText.mockResolvedValueOnce(mockResult({
      text: "Nice photo!",
      finishReason: "end-turn",
    }) as any);

    const attachmentParts = [
      { type: "image" as const, image: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" },
    ];

    await runAgentLoop({ ...baseParams, userMessage: "", attachmentParts });

    // Inspect the messages passed to generateText
    const callArgs = mockGenerateText.mock.calls[0][0] as any;
    const lastMessage = callArgs.messages[callArgs.messages.length - 1];
    expect(lastMessage.role).toBe("user");
    // Should only have image part, no empty text part
    const textParts = lastMessage.content.filter((p: any) => p.type === "text");
    expect(textParts).toHaveLength(0);
    const imgParts = lastMessage.content.filter((p: any) => p.type === "image");
    expect(imgParts).toHaveLength(1);
  });

  it("includes text part when userMessage is non-empty with images", async () => {
    mockGenerateText.mockResolvedValueOnce(mockResult({
      text: "I see!",
      finishReason: "end-turn",
    }) as any);

    const attachmentParts = [
      { type: "image" as const, image: new Uint8Array([1, 2, 3]), mediaType: "image/jpeg" },
    ];

    await runAgentLoop({ ...baseParams, userMessage: "What is this?", attachmentParts });

    const callArgs = mockGenerateText.mock.calls[0][0] as any;
    const lastMessage = callArgs.messages[callArgs.messages.length - 1];
    const textParts = lastMessage.content.filter((p: any) => p.type === "text");
    expect(textParts).toHaveLength(1);
    expect(textParts[0].text).toBe("What is this?");
  });

  it("keeps empty text when no images provided (fallback)", async () => {
    mockGenerateText.mockResolvedValueOnce(mockResult({
      text: "Hi",
      finishReason: "end-turn",
    }) as any);

    await runAgentLoop({ ...baseParams, userMessage: "" });

    const callArgs = mockGenerateText.mock.calls[0][0] as any;
    const lastMessage = callArgs.messages[callArgs.messages.length - 1];
    const textParts = lastMessage.content.filter((p: any) => p.type === "text");
    // Fallback: empty text kept when there are no images either
    expect(textParts).toHaveLength(1);
  });

  it("returns empty skillCalls for pure text reply", async () => {
    mockGenerateText.mockResolvedValueOnce(mockResult({
      text: "Hello!",
      finishReason: "end-turn",
    }) as any);

    const result = await runAgentLoop(baseParams);
    expect(result.skillCalls).toEqual([]);
    expect(result.reply).toBe("Hello!");
  });

  it("retries with a system notice when provider content-filter produces an empty reply", async () => {
    mockGenerateText
      .mockResolvedValueOnce(mockResult({
        text: "",
        finishReason: "content-filter",
        messages: [{ role: "assistant", content: "" } as ModelMessage],
      }) as any)
      .mockResolvedValueOnce(mockResult({
        text: "Sorry, that reply was blocked. Could you rephrase?",
        finishReason: "end-turn",
        messages: [{ role: "assistant", content: "Sorry, that reply was blocked. Could you rephrase?" } as ModelMessage],
      }) as any);

    const result = await runAgentLoop(baseParams);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe("Sorry, that reply was blocked. Could you rephrase?");
    expect(result.iterations).toBe(2);
    // Retry call must include the synthetic system-notice user message.
    // (Vitest records arg references, so we scan rather than peek at length-1.)
    const retryCall = mockGenerateText.mock.calls[1][0] as { messages: ModelMessage[] };
    const hasNotice = retryCall.messages.some(
      m => m.role === "user" && typeof m.content === "string" && m.content.includes("content filter")
    );
    expect(hasNotice).toBe(true);
    // Filtered empty-assistant turn must not leak into persisted history
    const assistants = result.newMessages.filter(m => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("Sorry, that reply was blocked. Could you rephrase?");
  });

  it("does not retry more than once if content-filter repeats", async () => {
    mockGenerateText
      .mockResolvedValueOnce(mockResult({
        text: "",
        finishReason: "content-filter",
      }) as any)
      .mockResolvedValueOnce(mockResult({
        text: "",
        finishReason: "content-filter",
      }) as any);

    const result = await runAgentLoop(baseParams);
    expect(mockGenerateText).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe("");
  });
});

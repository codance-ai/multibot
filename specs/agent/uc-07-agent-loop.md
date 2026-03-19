# UC-07: Agent Loop Mechanics

## Trigger

Called by `processChat()` (for both `/chat` and `/group-chat`) and `executeCronJob()` after the system prompt and tools are assembled. The loop drives the core LLM interaction cycle.

## Expected Behavior

1. **Setup**: Wrap all tools with error handling (`wrapToolsWithErrorHandling`), apply Anthropic cache control to system prompt (`buildCachedSystemPrompt`), merge system messages + conversation history + current user turn
2. **Consecutive message merging**: Before sending to the LLM, `mergeConsecutiveMessages()` combines adjacent same-role messages. Prevents provider rejections (Gemini requires strict user/model alternation) and improves LLM comprehension. User messages are merged unconditionally; assistant messages are merged only when both are text-only (messages with tool-call parts are never merged, to preserve tool result pairing)
3. **Loop iteration**: Up to `maxIterations` (from `botConfig.maxIterations`):
   a. Call `generateText()` with `stopWhen: stepCountIs(1)` — one LLM step per iteration
   b. Per-step timeout: 90 seconds (`STEP_TIMEOUT_MS`), combined with the parent abort signal via `AbortSignal.any()`
   c. Retry: Uses `withRetry()` with `isRetryableError` (retries transient failures like 5xx)
   d. Convert response messages to `StoredMessage[]` format for persistence
   e. Accumulate token usage across iterations
4. **Text handling**:
   - Text WITH tool calls AND onProgress: send text immediately via `onProgress` (user sees intermediate reasoning)
   - Text WITH tool calls but NO onProgress: accumulate into final reply (group chat)
   - Text WITHOUT tool calls: accumulate into final reply (this is the final answer)
5. **Tool call processing**: For each tool call:
   - Track skill activation via `load_skill` tool name detection
   - Record tool calls grouped by skill in `skillCallsMap`
   - Log tool call details (name, input, result) for trace inspection
   - Send formatted tool hints via `onProgress` if enabled (e.g., `exec("python script.py")`)
6. **Termination**: Loop ends when `finishReason !== "tool-calls"` (LLM produced a final answer) or `maxIterations` reached
7. **Max iterations fallback**: If loop exhausts `maxIterations`, returns accumulated text or "I've reached my thinking limit for this request."

### Tool Error Wrapping & Pre-Execution Hints

`wrapToolsWithErrorHandling()` wraps every tool's `execute` function:
- Sends a tool hint to the user via `onToolStart` callback **before** the tool executes (immediate feedback, ~2s after message send)
- Catches thrown errors (external faults) and returns a formatted error string
- Error message tells the LLM: "Do not retry automatically. Tell the user what happened."
- Business-logic errors that tools return as strings pass through unchanged
- Each tool call is logged with timing
- Hint send failures are caught and logged — they never block tool execution

### Tool Hint Formatting

`formatToolHint()` produces human-readable hints sent to the channel:
- Format: `toolName("firstArg")` truncated at 40 chars
- Underscores escaped to prevent Markdown italic interpretation
- Multiple tool calls joined with `, `

### Stored Message Conversion

`convertToStoredMessages()` transforms AI SDK `ModelMessage[]` to `StoredMessage[]`:
- Assistant messages: extract text content + tool calls JSON
- Tool results: stored with `toolCallId` and `toolName` for matching
- Tool results are merged back into the owning assistant's `toolCalls` JSON (result field, truncated to `TOOL_RESULT_MAX_LENGTH` = 500 chars)
- `botId` and `requestId` injected into assistant messages for D1 tracing

## Example

```
User asks: "Create a Python script that says hello"

→ runAgentLoop():
  Iteration 1:
    → generateText() with 90s step timeout
    → LLM returns text "I'll create that for you" + tool_call exec("echo 'print(\"hello\")' > hello.py")
    → onProgress("I'll create that for you")
    → Tool wrapper sends hint via onProgress: exec("echo 'print(\"hello\")' > hello.py")
    → Tool executes, result stored

  Iteration 2:
    → generateText() with conversation + tool results
    → LLM returns text "I've created hello.py. Here's the script..." (no tool calls)
    → finishReason = "stop"
    → accumulatedText = "I've created hello.py. Here's the script..."
    → Loop ends

→ Return {
    reply: "I've created hello.py...",
    iterations: 2,
    toolCallsTotal: 1,
    newMessages: [...],
    inputTokens: 800,
    outputTokens: 150,
    skillCalls: [{ skill: "", tools: [{ name: "exec", ... }] }],
    toolResults: ["Script created successfully"]
  }
```

## Key Code Path

- Loop: `runAgentLoop()` in `loop.ts`
- Error wrapping: `wrapToolsWithErrorHandling()` in `loop.ts`
- Message merging: `mergeConsecutiveMessages()` in `loop.ts`
- Message conversion: `convertToStoredMessages()` in `loop.ts`
- Tool hints: `formatToolHint()` in `loop.ts`
- Cache control: `buildCachedSystemPrompt()` in `providers/cache.ts`
- Retry logic: `withRetry()` / `isRetryableError()` in `utils/retry.ts`
- Per-step timeout: `combinedAbortSignal()` in `loop.ts`

## Edge Cases

- **Step timeout (90s)**: A single LLM call that takes > 90s is aborted. The parent abort signal (request-level timeout) also propagates
- **Abort during tool execution**: Tool errors from abort are caught by `wrapToolsWithErrorHandling` and returned as error strings. The LLM sees the error and can respond appropriately
- **Empty user message**: If `userMessage.trim()` is empty (e.g., image-only message), the text part is skipped but attachment parts are still included. A fallback ensures at least one content part exists
- **appendUserTurn=false**: When `coordinatorOwned=true` in group chat, the user message is already in D1 history. The loop skips appending it as the current turn to avoid duplication
- **Skill tracking**: Tool calls are grouped by the active skill (set by `load_skill` calls). Tool calls before any `load_skill` are grouped under the empty string skill
- **Max iterations reached**: Returns accumulated text or a fallback message. Does not throw — the conversation can continue normally
- **Consecutive user messages in history**: Can occur from multi-turn group chat where the bot was silent. `mergeConsecutiveMessages()` joins them with `\n\n` for text-only or concatenates arrays for mixed content (text + images)
- **Consecutive assistant messages in history**: Can occur in group chat when the same bot sends multiple messages without interleaving user/other-bot messages (e.g., cron messages). `mergeConsecutiveMessages()` merges text-only assistant messages with `\n\n`. Assistant messages with tool-call parts are never merged (tool-calls need their own turn for proper tool result pairing)

# UC-01: Private Single-Bot Chat

## Trigger

A user sends a message to a bot in a private (non-group) channel. The gateway forwards the message as a POST to the MultibotAgent DO's `/chat` endpoint.

## Expected Behavior

1. **Fire-and-forget**: The DO returns `200 OK` immediately. Processing runs inside `ctx.waitUntil()` to keep the DO alive
2. **Orphan detection**: Before processing, check DO storage for a stale `pendingRequest` from a prior DO eviction. If found (age > `PENDING_ORPHAN_MS` = 3.5 min), notify the user and clear it
3. **Pending tracking**: Store the current request ID as `pendingRequest` in DO storage. Cleared on completion (compare-and-set to avoid clobbering a newer request)
4. **Timeout**: Entire request is wrapped in `withTimeout(REQUEST_TIMEOUT_MS)` (3 minutes). On timeout, the abort signal fires, stopping the agent loop and typing indicator
5. **Typing indicator**: Starts a 4-second polling loop via `startTypingLoop()`. Stopped when the final reply is sent or on timeout/abort
6. **processChat options**: `sendProgressToChannel: true`, `sendFinalToChannel: true`, `sendToolHints: true`, `enableMessageTool: true`, `enableTyping: true`
7. **Progress messages**: Intermediate text (text + tool calls) is sent to the channel immediately via `onProgress`. Tool hints (formatted tool names) are also sent
8. **Final reply**: The normalized reply (with image handling) is sent to the channel
9. **Error handling**: On failure, an appropriate error message is sent to the channel (timeout, auth error, rate limit, or generic)
10. **Trace**: Request trace is flushed to R2 on both success and failure

## Example

```
User sends "What's 2+2?" to bot via Telegram

→ Gateway POSTs to MultibotAgent DO /chat
→ DO returns 200 OK immediately
→ ctx.waitUntil() starts:
  → Check/clear stale pendingRequest
  → Store pendingRequest
  → Start typing indicator
  → processChat():
    → Phase 1: getOrCreateSession, getSkillSecretsFlat, resolveAttachmentsForLLM (parallel)
    → Phase 2: buildAgentTools
    → Phase 3: buildPromptAndHistory (parallel)
    → Persist user message to D1
    → runAgentLoop() → LLM returns "2+2 = 4"
    → Stop typing
    → Send "2+2 = 4" to Telegram
    → maybeConsolidate (background)
    → Flush trace to R2
  → Clear pendingRequest
```

## Key Code Path

- Entry: `MultibotAgent.onRequest()` default path in `multibot.ts`
- Orphan detection: `PENDING_REQUEST_KEY` / `PENDING_ORPHAN_MS` in `multibot-helpers.ts`
- Timeout wrapper: `withTimeout()` in `multibot-helpers.ts`
- Chat processing: `processChat()` in `multibot-chat.ts`
- Typing: `startTypingLoop()` in `multibot-channel.ts`
- Channel send: `sendChannelMessage()` in `multibot-channel.ts`

## Edge Cases

- **DO eviction mid-flight**: The pending request becomes orphaned. On the next request, the user is notified "your previous message wasn't processed"
- **Concurrent requests**: A new request overwrites `pendingRequest`. The old request's `finally` block uses compare-and-set to avoid deleting the new request's entry
- **Timeout during tool execution**: The abort signal propagates to the agent loop's `generateText()` call, which rejects. The typing indicator stops. An error message is sent to the channel
- **Empty reply**: If the LLM returns no text and no media, nothing is sent to the channel (no empty message)
- **`/new` command**: Handled specially by `processChat()` before reaching the agent loop — see UC-03

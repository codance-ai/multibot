# UC-02: Group Chat Bot Processing

## Trigger

The ChatCoordinator DO calls the MultibotAgent DO's `/group-chat` endpoint when a bot is dispatched to respond in a group conversation. This is a synchronous call — the coordinator waits for the response.

## Expected Behavior

1. **Synchronous**: The DO processes the request and returns the result as JSON. The coordinator owns the final channel send and persistence decisions
2. **Timeout**: Wrapped in `withTimeout(REQUEST_TIMEOUT_MS)` (3 minutes) with `keepAliveWhile()`
3. **processChat options**: `sendProgressToChannel: true`, `sendFinalToChannel: false`, `sendToolHints: false`, `enableMessageTool: false`, `enableTyping: true`. When `coordinatorOwned` is true, `appendUserTurn` is set to `false` (user message already persisted by coordinator)
4. **Progress streaming**: Intermediate text is sent to the channel directly (progress messages), so users see activity. But the final reply is NOT sent — the coordinator handles that
5. **Coordinator-owned persistence**: When `coordinatorOwned` is true, the agent skips persisting messages to D1 and instead returns `newMessages` in the response for the coordinator to persist. The user message is already in D1 history (persisted by coordinator before calling bots)
6. **User message prefix**: In round 1, wave 1, the user message is prefixed with `[userName]:` so the LLM knows who is speaking
7. **No message tool**: `enableMessageTool: false` — bots in group chat cannot use `send_to_group` (the coordinator manages multi-bot interaction)
8. **Typing**: Starts typing, but stops after the first successful progress send (unlike single chat which types until the final reply)
9. **Skip detection**: If the LLM's reply matches `[skip]`, the reply is not persisted and no messages are sent. The bot chose silence
10. **Response payload**: Returns `{ reply, inputTokens, outputTokens, skillCalls, model, imageCount, media, newMessages? }`

## Example

```
Coordinator dispatches bot "Alice" for group chat

→ POST /group-chat to MultibotAgent DO
→ processChat():
  → Phase 1: use provided sessionId, getSkillSecretsFlat, resolveAttachmentsForLLM (parallel)
  → Phase 2: buildAgentTools (enableMessageTool=false)
  → Phase 3: buildPromptAndHistory with groupContext
  → coordinatorOwned=true → appendUserTurn=false
  → Start typing with bot's own channel token
  → runAgentLoop()
    → LLM returns "That's a great idea!"
  → Stop typing
  → Messages NOT persisted by agent (returned as newMessages)
  → maybeConsolidate (background)
→ Return { reply: "That's a great idea!", inputTokens: 500, outputTokens: 20, newMessages: [...], ... }
→ Coordinator persists newMessages, sends reply to channel, and evaluates continue
```

## Key Code Path

- Entry: `MultibotAgent.onRequest()` `/group-chat` path in `multibot.ts`
- Chat processing: `processChat()` in `multibot-chat.ts`
- Group context handling: `buildGroupSystemPrompt()` in `context.ts`
- History reconstruction: `buildPromptAndHistory()` in `multibot-build.ts` — other bots' messages shown as `<group_reply from="BotName">` in user role
- Skip detection: `isSkipReply()` from `group/utils.ts`

## Edge Cases

- **Bot chooses [skip]**: Reply is `[skip]`, messages are NOT persisted, coordinator treats it as no response
- **coordinatorOwned=true**: Messages not persisted by agent; `newMessages` returned in response for coordinator to batch-persist
- **coordinatorOwned=false** (legacy): Agent persists messages itself
- **Progress + timeout**: If timeout fires during `runAgentLoop()`, coordinator receives HTTP 500. The coordinator handles sending error messages to the channel
- **Bot's own token**: Progress messages use the bot's own channel token (from `botConfig.channels[channel].token`), not the coordinator's token, so messages appear from the correct bot identity
- **Pacing hints**: System prompt includes round-based pacing hints (e.g., "conversation is nearing its end" at round >= 80% of MAX_ROUNDS)

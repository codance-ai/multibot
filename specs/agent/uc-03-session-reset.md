# UC-03: Session Reset (/new Command)

## Trigger

User sends `/new` (or `/new@botname`) in a private or group chat. Detected by regex `/^\/new(@\S+)?$/i` at the top of `processChat()`, before any LLM processing.

## Expected Behavior

1. **Immediate response**: Send "New session started." to the channel (in private chat; in group chat, the coordinator handles messaging)
2. **Session rotation**: Get the old session ID, then create a new session in D1. In group chat, the coordinator passes the old sessionId and creates the new session itself
3. **Background consolidation**: Kick off `consolidateSession()` via `waitUntil()` — it runs after the response is returned
4. **Consolidation scope**: Archives ALL messages in the old session (`archiveAll: true`), not just overflow beyond the keep window
5. **Post-consolidation cleanup**: After consolidation, delete all consolidated messages from D1 (the user explicitly ended the session, so raw messages are no longer needed)
6. **No LLM call**: The `/new` handler returns immediately without running the agent loop
7. **Trace**: A minimal trace (0 tokens, 0 LLM calls) is flushed to R2

## Example

```
User sends "/new" in private chat

→ processChat() detects /new regex match
→ Get old sessionId from D1
→ Create new session in D1
→ Send "New session started." to channel
→ waitUntil(consolidateSession()):
  → Load all messages from old session
  → consolidateMemory(archiveAll=true):
    → Format messages as timestamped log
    → LLM summarizes into history_entry via archive_conversation tool
    → Insert history_entry into memory_history_entries table
    → Delete expired entries older than 180 days
  → Update session's last_consolidated boundary
  → Delete consolidated messages from D1
→ Return { reply: "New session started...", inputTokens: 0, outputTokens: 0 }
```

## Key Code Path

- Detection: `/new` regex match in `processChat()`, `multibot-chat.ts`
- Session rotation: `d1.getOrCreateSession()` + `d1.createNewSession()` in `db/d1.ts`
- Consolidation: `MultibotAgent.consolidateSession()` in `multibot.ts`
- Memory archival: `consolidateMemory({ archiveAll: true })` in `memory.ts`
- Message cleanup: `d1.deleteConsolidatedMessages()` in `db/d1.ts`

## Edge Cases

- **Empty session**: If the old session has 0 messages, consolidation is skipped (no-op)
- **Concurrent consolidation**: A `_consolidating` Set in the DO prevents duplicate consolidation for the same `sessionId:botId` pair
- **Consolidation failure**: Non-fatal — logged as warning, user is not notified. The new session is already active regardless
- **Group chat /new**: The coordinator passes the old `sessionId` in the payload. The agent does NOT create a new session — the coordinator handles that. The agent only consolidates the old session
- **Bot-specific /new**: `/new@botname` is supported via the regex `(@\S+)?` — channel adapters may strip the `@botname` suffix, but if present, it still matches

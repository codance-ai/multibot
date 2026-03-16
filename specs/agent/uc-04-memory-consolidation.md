# UC-04: Memory Consolidation

## Trigger

Two triggers:

1. **Auto-consolidation** (`maybeConsolidate`): After every successful chat response, `processChat()` kicks off a non-blocking consolidation check via `waitUntil()`. Uses a dual trigger — fires when EITHER condition is met:
   - **Count trigger**: unconsolidated messages exceed `memoryWindow / 2`
   - **Token trigger**: estimated tokens of unconsolidated messages exceed `contextWindow * 0.5`
2. **Manual consolidation** (`consolidateSession`): Triggered by `/new` command — archives ALL messages in the old session (see UC-03)

## Expected Behavior

### Auto-consolidation (`maybeConsolidate`)

1. **Threshold check**: Dual trigger — count unconsolidated messages AND estimate their tokens. If both count <= `memoryWindow / 2` AND estimated tokens <= `contextWindow * 0.5`, skip
2. **Keep window**: Preserve the most recent `memoryWindow / 2` messages. **Turn-aligned**: the split boundary is aligned to a user message start to avoid cutting mid-turn
3. **Batched processing**: Messages are processed in batches of `CONSOLIDATION_MSG_LIMIT` (200 messages per batch). Batches are dynamically shrunk if estimated token count exceeds the consolidation token budget (100K tokens). **Batch boundaries are also turn-aligned** to user message starts (with 30% token budget tolerance for alignment extension)
4. **Per-batch summarization**: Each batch is formatted as a timestamped conversation log, then sent to the LLM with a **structured** `archive_conversation` tool. The LLM produces:
   - `summary`: 2-5 sentence history entry
   - `decisions`: Key decisions made (or "None")
   - `open_todos`: Open action items (or "None")
   - `key_identifiers`: Important UUIDs, URLs, file paths (or "None")
5. **Quality audit**: After LLM generates the summary, identifiers are extracted from the formatted conversation text via regex and compared against the `key_identifiers` field. If quality fails, the LLM is retried once with feedback specifying the missing identifiers. On second failure, the best-effort result is accepted
6. **History entry persistence**: The structured result is formatted into markdown (omitting "None" sections) and inserted into the `memory_history_entries` D1 table
7. **Boundary update**: The `last_consolidated` marker in `bot_sessions` is updated to the ID of the last consolidated message
8. **High-water mark deletion**: If total session messages exceed `memoryWindow * 4`, delete all consolidated messages to control D1 growth
9. **Expired entry cleanup**: After all batches (inside `consolidateMemory`), delete history entries older than 180 days
10. **Eager memory review**: After consolidation completes, if the token threshold triggered the consolidation (high token pressure), immediately runs `reviewMemory()` to fast-track key facts from the newly created history entries into `bot_memory`, instead of waiting for the next cron-scheduled review cycle

### Manual consolidation (`consolidateSession`)

Same as above, but with `archiveAll: true` — consolidates ALL messages, not just overflow. After consolidation, deletes all consolidated messages (session is ending).

### Message formatting

Each message is formatted as:
```
[YYYY-MM-DD HH:MM] ROLE [bot_id] [tools: tool1, tool2]: content
```
- Bot labels only shown for other bots' messages in shared sessions
- Tool names extracted from `tool_calls` JSON
- Content truncated at `CONSOLIDATION_MSG_TRUNCATE` (2000 chars)

### History entry format

Stored as markdown in `memory_history_entries.content`:
```
[2024-01-15 14:30] User asked about deployment. Bot ran exec tool and deployed v2.1.
**Decisions:** Chose blue-green deployment strategy
**Open TODOs:** Monitor error rates for 24h
**Identifiers:** https://api.example.com, d1ea9d49
```
Sections with "None" values are omitted from storage.

## Example

```
Bot has memoryWindow=50. Session has 35 unconsolidated messages.

→ maybeConsolidate():
  → keepCount = 50 / 2 = 25
  → rawSplitIndex = 35 - 25 = 10
  → alignToTurnBoundary: if message[10] is assistant, walk to next user → splitIndex = 11
  → toConsolidate = messages[0..10] (first 11 messages)
  → Batch 1 (11 messages):
    → Format as timestamped log
    → Extract identifiers from formatted text: ["d1ea9d49", "https://example.com"]
    → LLM: archive_conversation({ summary: "...", decisions: "...", open_todos: "None", key_identifiers: "d1ea9d49, https://example.com" })
    → Quality audit: check identifiers present → pass
    → Format to markdown, insert into memory_history_entries
  → Delete expired entries (>180 days)
  → Update last_consolidated = message[10].id
  → Total messages (35) < highWaterMark (200), skip deletion
```

## Key Code Path

- Auto trigger: `deps.maybeConsolidate()` called at end of `processChat()` in `multibot-chat.ts`
- Manual trigger: `deps.consolidateSession()` called from `/new` handler in `multibot-chat.ts`
- Threshold logic: `MultibotAgent.maybeConsolidate()` in `multibot.ts`
- Core consolidation: `consolidateMemory()` in `memory.ts`
- Turn alignment: `alignToTurnBoundary()` in `memory.ts`
- Identifier extraction: `extractIdentifiers()` in `memory.ts`
- Quality audit: `auditSummaryQuality()` in `memory.ts`
- LLM tool: `archive_conversation` tool with structured schema (summary, decisions, open_todos, key_identifiers) + `toolChoice: { type: "tool", toolName: "archive_conversation" }` (forced call)
- D1 operations: `getMessagesForConsolidation()`, `updateSessionConsolidated()`, `deleteConsolidatedMessages()`, `insertHistoryEntry()`, `deleteExpiredHistoryEntries()` in `db/d1.ts`

## Edge Cases

- **Concurrent consolidation**: The `_consolidating` Set prevents duplicate consolidation for the same `sessionId:botId`. If already running, new calls are no-ops
- **LLM fails to call tool**: If the LLM doesn't produce an `archive_conversation` tool call, the batch is skipped and a warning is logged. The boundary only advances up to the last successfully archived batch, so the failed batch will be retried in the next consolidation cycle. If no batch succeeds, boundary does not advance at all (returns null)
- **Quality audit failure**: After 1 retry with feedback, the best-effort result is accepted. Quality audit never blocks consolidation
- **Turn alignment overflow**: If aligning to a user turn boundary would extend a batch beyond 130% of the token budget, the alignment is skipped and the original boundary is used
- **Consolidation error**: Caught and logged as non-fatal warning. The session continues to work — consolidation will retry on the next message
- **Empty batch**: If all messages in a batch have null content, `lines` is empty and the batch is skipped
- **High-water mark**: Only auto-consolidation checks the high-water mark (`memoryWindow * 4`). Manual consolidation always deletes
- **Tool pair integrity**: Not applicable — tool_use and tool_result are stored together in a single `tool_calls` JSON field per message row, so pairs are never orphaned

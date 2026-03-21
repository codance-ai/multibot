# UC-05: Periodic Memory Review

## Trigger

A periodic cron job invokes `reviewMemory()` to curate the bot's long-term memory (MEMORY.md) from accumulated history entries. This is separate from consolidation — consolidation produces raw history entries, memory review curates them into durable knowledge.

## Expected Behavior

1. **Load current state**: Read existing MEMORY.md from D1 (`bot_memory` table) and recent history entries from `memory_history_entries` (last 200 entries)
2. **Skip if empty**: If no history entries exist, return immediately (no review needed)
3. **Token budget**: Memory size target = 3% of context window. Default context window = 128K, so target ~3840 tokens
4. **LLM curation**: Send current memory + recent history to a review LLM with strict instructions:
   - **Add**: User preferences, habits, personality traits, relationship facts, rules, ongoing commitments
   - **Never add**: Tool usage, skill instructions, system capabilities, API details (these come from skills/system prompts)
   - **Remove**: Outdated information that history shows has changed
   - **Format**: Fixed markdown sections: User Profile, Preferences, Rules & Boundaries, Relationships, Ongoing Commitments
5. **Overflow compression**: If the updated memory exceeds the token budget, run a second LLM pass to compress it (merge related facts, remove transactional details)
6. **Hard truncation fallback**: If compression still exceeds 120% of budget, apply section-aware truncation: drop content from lowest-priority sections first (unknown sections → Relationships → Ongoing Commitments → Preferences → User Profile → Rules & Boundaries), removing lines from the end of each section before dropping it entirely
7. **Persistence**: Write updated memory to D1 `bot_memory` table via `upsertMemory()`
8. **No-op detection**: If the updated memory is identical to the current memory, skip the write

## Example

```
Cron fires memory review for bot "Alice"

→ reviewMemory():
  → Load MEMORY.md from D1: "## User Profile\nLikes coffee..."
  → Load 200 recent history entries
  → LLM review:
    Input: current memory + history entries
    Output: "## User Profile\nLikes coffee, prefers dark roast\n## Preferences\n..."
  → estimateTokens(output) = 200 < tokenLimit (3840), skip compression
  → output !== currentMemory, so upsert to D1
  → return true (memory updated)
```

## Key Code Path

- Entry: `reviewMemory()` in `memory.ts`
- Memory I/O: `getMemory()`, `upsertMemory()` in `db/d1.ts`
- History entries: `getHistoryEntries()` in `db/d1.ts`
- Token estimation: `estimateTokens()` — CJK-aware: CJK chars × 1.8, non-CJK chars / 3 × 1.2
- Budget calculation: `getMemoryTokenLimit()` — `contextWindow * 0.03`
- System prompt injection: `loadMemoryContext()` formats memory as `## Long-term Memory\n{content}`

## Edge Cases

- **Admin bot excluded**: Admin bots (`botType === "admin"`) are skipped in both the cron review loop and the eager review path after high-pressure consolidation. Their conversations consist of bot management operations (editing other bots' config/memory), which would pollute their own MEMORY.md with other bots' persona details
- **No history entries**: Returns `false` immediately — nothing to review
- **Empty current memory**: Works fine — LLM creates memory from scratch based on history entries
- **LLM produces empty output**: Returns `false` — no memory update
- **Overflow after review**: If LLM expands memory beyond budget, compression pass runs. If compression still overflows, section-aware truncation drops lowest-priority sections first (preserving Rules & Boundaries and User Profile longest)
- **Token estimation accuracy**: CJK-aware heuristic — CJK characters use 1.8 tokens/char, non-CJK use 0.4 tokens/char. Conservative for both scripts, ensuring memory stays within provider context limits
- **Language matching**: Both review and compression prompts instruct the LLM to write in the same language as the input, preserving the user's language preference

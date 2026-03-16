# UC-03: Memory Tools (read/write/edit/append/grep)

## Trigger

The LLM invokes any of the five memory tools (`memory_read`, `memory_write`, `memory_edit`, `memory_append`, `memory_grep`) to persist information across conversations. Each tool accepts a `file` parameter: either `"MEMORY.md"` or `"HISTORY.md"`.

## Expected Behavior

1. **memory_read**: Reads the specified file. MEMORY.md reads from D1 `bot_memory` table via `getMemory()`. HISTORY.md reads the latest 100 entries from D1 `bot_history` table via `getHistoryEntries()`. Returns `"(empty)"` if no content exists
2. **memory_write**: Overwrites MEMORY.md completely via `upsertMemory()`. **Blocked for HISTORY.md** -- returns an error message directing the user to `memory_append`. Intended for initial writes or full rewrites only
3. **memory_append**: For HISTORY.md, inserts a new row via `insertHistoryEntry()` (append-only log). For MEMORY.md, performs read-modify-write: reads current content, appends new content with a newline separator, writes back
4. **memory_edit**: Find-and-replace on MEMORY.md only. **Blocked for HISTORY.md** -- history entries are immutable log records. Performs a uniqueness check: if `old_string` matches 0 times, returns "not found" with a hint to use `memory_read`. If it matches more than 1 time, returns "found N times" with a hint to add more context. Only replaces when exactly 1 match is found
5. **memory_grep**: Searches for a keyword. For HISTORY.md, uses `searchHistoryEntries()` (D1 LIKE query). For MEMORY.md, does case-insensitive line-by-line filtering in-memory. Returns matching lines/entries or "No matches"

### What to Save vs Not Save

The tool descriptions guide the LLM:
- **Save**: user preferences, personality traits, relationships, ongoing plans, rules, anything the user asks to remember
- **Do NOT save**: tool usage instructions, skill instructions, system capabilities, technical implementation details (these come from skills and update with deployments)

## Example

```
LLM calls: memory_edit({ file: "MEMORY.md", old_string: "favorite color: blue", new_string: "favorite color: green" })

→ file is MEMORY.md → allowed
→ getMemory(db, botId) → "# User Profile\nfavorite color: blue\nlanguage: English"
→ Count occurrences of "favorite color: blue" → 1
→ Replace: "# User Profile\nfavorite color: green\nlanguage: English"
→ upsertMemory(db, botId, updated)
→ Return "Edited MEMORY.md: replaced 20 chars with 21 chars."
```

```
LLM calls: memory_append({ file: "HISTORY.md", content: "2026-03-11: User asked about vacation plans to Japan" })

→ file is HISTORY.md → insertHistoryEntry(db, botId, content)
→ Return "Appended to HISTORY.md"
```

## Key Code Path

- Tool factory: `createMemoryTools()` in `src/tools/memory.ts`
- D1 operations: `getMemory()`, `upsertMemory()`, `insertHistoryEntry()`, `getHistoryEntries()`, `searchHistoryEntries()` in `src/db/d1.ts`
- Bot ID: Uses the full UUID `botId` (not the short 8-char ID) as the key in D1 tables

## Edge Cases

- **memory_edit on empty MEMORY.md**: Returns `"Cannot edit: MEMORY.md is empty."` without attempting replacement
- **memory_edit with ambiguous match**: If `old_string` appears more than once, the edit is rejected to prevent unintended replacements. The LLM must provide more surrounding context
- **memory_write on HISTORY.md**: Hard-blocked -- returns error message. HISTORY.md is append-only by design
- **memory_edit on HISTORY.md**: Hard-blocked -- history entries are immutable log records
- **memory_append on MEMORY.md**: Uses read-modify-write pattern, which is not atomic. Concurrent appends could race, but this is acceptable since a single bot processes one request at a time
- **memory_grep case sensitivity**: MEMORY.md grep is case-insensitive. HISTORY.md grep depends on the D1 `searchHistoryEntries()` implementation (typically case-insensitive via LIKE)
- **MEMORY.md already in system prompt**: The tool description notes that MEMORY.md content is already injected into the system prompt. `memory_read` for MEMORY.md should only be called right before editing, to get the latest version

## Admin Tools for Memory Management

The admin bot has additional tools for managing other bots' memory:

- **read_bot_memory**: Read another bot's MEMORY.md or HISTORY.md (with truncation)
- **edit_bot_memory**: Edit another bot's MEMORY.md only (find-and-replace). Does NOT accept HISTORY.md -- the `file` parameter was removed since HISTORY.md editing is never allowed. Blocked for admin bot targets
- **correct_bot_history**: Append a `[CORRECTION]` entry to another bot's HISTORY.md. Used when a bot has incorrect information in its history that could pollute memory review. This preserves the append-only design -- existing entries are never modified, corrections are appended so the memory review process picks them up. For immediate fixes, the admin should also use `edit_bot_memory` to correct MEMORY.md directly

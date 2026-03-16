# UC-06: System Prompt Construction

## Trigger

Called by `buildPromptAndHistory()` at the start of every chat request (both `/chat` and `/group-chat`). The system prompt is rebuilt fresh for each request — it is not cached across requests.

## Expected Behavior

The system prompt is assembled from 5 orthogonal layers joined by `\n\n---\n\n`. Each layer is independent: identity doesn't know about tools, tools don't assume a persona, memory is independent state.

1. **Layer 1 — Identity**: The bot's persona. If `botConfig.identity` is set, uses `# {name}\n\n{identity}`. Otherwise, a default identity referencing SOUL.md/AGENTS.md
2. **Layer 2 — System**: Runtime context and capabilities. Includes:
   - Current date/time formatted in the bot's timezone
   - Workspace path (`/workspace`)
   - Runtime description (Linux container with pre-installed tools)
   - Sandbox backend specifics (Sprites: persistent `/workspace`; default: ephemeral)
   - Media delivery rules (text-only replies, must use tools for files)
   - Voice delivery hint (when `voiceMode` is `"always"` or `"mirror"`, tells the LLM its replies will be delivered as voice, with guidance on speech-friendly output style and character limits)
   - Tool error handling instructions
   - Message timestamp format note
3. **Layer 3 — Bootstrap**: Content from 4 optional bot config fields rendered as markdown sections:
   - `AGENTS.md` — agent behavior rules
   - `SOUL.md` — personality/voice definition
   - `USER.md` — user context/preferences
   - `TOOLS.md` — tool usage guidelines
4. **Layer 4 — Memory**: Long-term memory from D1 `bot_memory` table. Formatted as `# Memory\n\n## Long-term Memory\n{content}`. Includes a note that memory is already loaded and should not be re-read, and that skill instructions take precedence over memory
5. **Layer 5 — Skills Summary**: XML metadata for on-demand skill loading. Includes:
   - Instructions to check skills before replying
   - `<env>` tags showing which skill secrets are configured
   - Admin bots get `register_skill`/`unregister_skill` mention

After the 5 layers, optional appendices:
- **Session context**: Channel and Chat ID
- **Group chat context**: Group name, user name, other bot names, round/MAX_ROUNDS pacing hints, conversational style rules (short, natural, phone-texting style)

## Example

```
buildSystemPrompt() for bot "Alice" in group chat round 3

→ Layer 1: "# Alice\n\nYou are Alice, a friendly assistant..."
→ Layer 2: "# System\n\n## Current Time\n2024-01-15 14:30 (Monday) Asia/Shanghai\n..."
→ Layer 3: "## SOUL.md\n\nBe warm and empathetic..."
→ Layer 4: "# Memory\n\n## Long-term Memory\nUser likes coffee..."
→ Layer 5: "# Skills\n\n<skills>..."
→ Join with "\n\n---\n\n"
→ Append: "## Current Session\nChannel: telegram\nChat ID: 12345"
→ Append: "## Group Chat [Round 3/8]\nYou are in a group chat..."
```

## Token-Aware History Trimming

`buildPromptAndHistory()` estimates total token usage and trims history to fit within a token budget:

1. **System prompt tokens**: Estimated after assembling all 5 layers + appendices
2. **Token budget**: `contextWindow * 0.75 - systemPromptTokens` (reserves 25% for LLM output, current user turn, and tool schemas)
3. **Trimming**: Iterates history rows from newest to oldest, accumulating estimated tokens. When adding a row would exceed the budget, all older rows are dropped
4. **Safety**: The newest row is never trimmed, even if it alone exceeds the budget. If the system prompt alone exceeds the budget, only the newest row is kept
5. **Tiered estimation**: Recent 10 messages estimated with 4000 char limit, older messages with 2000 char limit (matching actual truncation behavior)
6. **TokenUsage**: Returns `{ systemPromptTokens, historyTokens, totalTokens, contextWindow, usageRatio, trimmedCount }` for observability

This replaces purely count-based history loading (`memoryWindow * 2` fixed limit) with a hybrid approach: messages are still loaded up to `memoryWindow * 2` from D1, but then trimmed by token budget if they exceed it.

## Key Code Path

- Main builder: `buildSystemPrompt()` in `context.ts`
- Default identity: `buildDefaultIdentity()` in `context.ts`
- System context: `buildSystemContext()` in `context.ts`
- Group prompt: `buildGroupSystemPrompt()` in `context.ts`
- Skills summary: `buildSkillsSummaryWithD1()` in `skills/loader.ts`
- Memory loading: `loadMemoryContext()` in `memory.ts`
- Prompt + history: `buildPromptAndHistory()` in `multibot-build.ts`
- Cache control: `buildCachedSystemPrompt()` in `providers/cache.ts` — applies Anthropic cache breakpoints when applicable

## Edge Cases

- **No identity**: Uses default identity template that references SOUL.md/AGENTS.md
- **No bootstrap files**: Layer 3 is omitted entirely (no empty sections)
- **No memory**: Layer 4 is omitted entirely
- **No skills**: Layer 5 is omitted entirely
- **Group chat pacing**: At >= 80% of MAX_ROUNDS, adds "nearing its end, keep brief" hint. At >= 50%, adds "feel free to wind down" hint
- **Skill secrets**: `<env>` tags show `configured="true"` for secrets that exist, `configured="false"` for missing ones. Configured secrets should not be requested from the user
- **Admin bots**: Get extra instructions about `register_skill`/`unregister_skill` tools
- **Voice mode off/unset**: Voice section is omitted entirely
- **Voice mode always**: Voice section tells LLM all replies are delivered as voice
- **Voice mode mirror**: Voice section tells LLM replies are voice when user sends voice. Additionally, a per-turn `[System: ...]` hint is appended to the user message when STT succeeds, confirming this specific reply will be delivered as voice

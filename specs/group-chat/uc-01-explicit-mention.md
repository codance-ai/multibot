# UC-01: Explicit @Mention (Single Bot)

## Trigger

User sends a message that explicitly @mentions one bot in the group.

Channel-specific mention formats:
- Telegram: `@bot_username`
- Discord: `<@bot_user_id>`
- Slack: `<@bot_user_id>`

## Expected Behavior

1. **Dispatch**: Fast-path — no orchestrator LLM call
2. **Respondents**: Only the mentioned bot responds
3. **Waves**: Single wave `[["MentionedBot"]]`
4. **Continue eval**: Yes — LLM evaluates whether other bots should follow up after the mentioned bot responds
5. **Persistence**: User message + bot reply persisted to D1

## Example

```
User: @Alice what's the weather today?

→ Fast-path: mentionedNames = ["Alice"]
→ Dispatch: [["Alice"]]
→ Alice responds with weather info
→ Continue eval: shouldContinue=false ("Direct question answered")
→ Turn ends
```

## Key Code Path

- Mention resolution: `resolveExplicitMentions()` in `handler.ts`
- Fast-path dispatch: `tryFastDispatch()` in `coordinator-utils.ts`
- Continue eval: `callOrchestratorContinue()` evaluates after round 1

## Edge Cases

- **Bot not in group**: If the mentioned username doesn't match any bot in the group, falls through to LLM dispatch
- **Mention + text match overlap**: Structured channel mentions take priority over text-based `@name` parsing
- **Bot identity not yet bound**: If bot hasn't been used in this channel before, `channelUsername`/`channelUserId` may be empty — falls back to text-based mention parsing

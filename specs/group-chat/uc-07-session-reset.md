# UC-07: Session Reset (/new)

## Trigger

User sends `/new` command in the group chat.

## Expected Behavior

1. **Dispatch**: Direct handling — no orchestrator LLM call, no bot dispatch
2. **Session rotation**: New session IDs created for all bots
3. **Memory consolidation**: Each bot's consolidation runs in parallel (`Promise.allSettled`), all bots settle before confirmation is sent
4. **Confirmation**: After consolidation settles, system message sent: "New session started for all bots."

## Example

```
User: /new

→ Command detected
→ Rotate session IDs for all bots
→ Consolidation for all bots in parallel (Promise.allSettled)
→ After all settle, send confirmation: "New session started for all bots."
→ Future messages start with fresh context
```

## Key Code Path

- Command detection: `coordinator.ts` lines 160-202
- Memory consolidation: Background task per bot
- Session rotation: New session ID generation

## Edge Cases

- **Consolidation failure**: If memory consolidation fails for one bot, other bots are not affected (`Promise.allSettled` isolates failures)
- **Rapid /new commands**: Each /new triggers a new epoch, so a quick second /new will interrupt any in-progress consolidation from the first
- **Empty session**: If no messages were exchanged since last /new, consolidation has nothing to summarize — should handle gracefully

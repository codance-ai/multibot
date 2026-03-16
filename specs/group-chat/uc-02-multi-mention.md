# UC-02: Explicit @Mention (Multiple Bots)

## Trigger

User sends a message that explicitly @mentions two or more bots in the group.

## Expected Behavior

1. **Dispatch**: Fast-path — no orchestrator LLM call
2. **Respondents**: All mentioned bots respond
3. **Waves**: All mentioned bots in a single wave `[["BotA", "BotB"]]` — they respond in parallel
4. **Continue eval**: Yes — LLM evaluates whether follow-up rounds are needed after all mentioned bots respond
5. **Persistence**: User message + all bot replies persisted to D1

## Example

```
User: @Alice @Bob help me decide between these two designs

→ Fast-path: mentionedNames = ["Alice", "Bob"]
→ Dispatch: [["Alice", "Bob"]]
→ Alice and Bob respond in parallel (Promise.allSettled)
→ Both replies sent to channel + persisted
→ Continue eval: LLM evaluates if follow-up is needed
→ Turn ends
```

## Key Code Path

- Mention resolution: `resolveExplicitMentions()` in `handler.ts`
- Fast-path dispatch: `tryFastDispatch()` returns all mentioned bots in one wave
- Parallel execution: `Promise.allSettled` in `coordinator.ts`

## Edge Cases

- **Partial match**: If only some mentioned names match bots in the group, only the matched bots are dispatched. If none match, falls through to LLM dispatch
- **One bot fails**: Since bots execute via `Promise.allSettled`, one bot timing out or erroring does not block the other
- **Order**: All bots are in the same wave so response order is non-deterministic (whichever bot finishes first gets sent first)

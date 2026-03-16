# UC-04: General Message (No Mention)

## Trigger

User sends a message with no explicit @mentions and not replying to any bot message. This is the most common group chat scenario.

## Expected Behavior

1. **Dispatch**: LLM-based — orchestrator LLM decides who should respond
2. **Respondents**: Orchestrator returns a 2D array of waves based on topic relevance and bot personas
3. **Waves**: Can be multi-wave for sequential discussion
   - Wave 1: bots respond in parallel
   - Wave 2+: bots see previous wave replies via D1 history
4. **Continue eval**: Yes — after round 1, orchestrator evaluates whether more rounds are needed
5. **Persistence**: All messages persisted to D1

## Example

```
User: Any ideas for the team outing?

→ No mentions detected
→ LLM dispatch called with orchestrator prompt
→ LLM decides: [["Alice"], ["Bob"]]
   (Alice responds first with creative ideas, Bob builds on them)
→ Wave 1: Alice responds
→ Wave 2: Bob responds (can see Alice's reply)
→ Continue eval: LLM → shouldContinue=false ("All perspectives covered")
→ Turn ends
```

## Key Code Path

- LLM dispatch: `callOrchestratorDispatch()` in `coordinator-llm.ts`
- Orchestrator prompt: `buildOrchestratorPrompt()` in `handler.ts`
- Wave execution loop: `executeTurn()` in `coordinator.ts`
- Continue eval: `callOrchestratorContinue()` in `coordinator-llm.ts`

## Orchestrator Decision Factors

The LLM considers:
- **Bot personas**: Each bot's personality and expertise
- **Message topic**: What the user is asking about
- **Recent context**: Last 10 messages in conversation history
- **Wave ordering**: Who should go first to set context for others

## Edge Cases

- **LLM timeout**: Falls back to `fallbackDispatch()` — all bots respond in a single wave
- **LLM returns invalid bot names**: Validated against actual group member list; invalid names filtered out
- **LLM returns empty respondents**: Falls back to `fallbackDispatch()`
- **Single bot in group**: Orchestrator bypassed — dispatches directly to the only bot, no LLM dispatch or continuation needed
- **Max rounds**: Continue eval capped at `MAX_ROUNDS = 8` to prevent runaway conversations

# UC-06: Continue Evaluation (Auto-Continuation)

## Trigger

After round 1 completes in any multi-bot group turn, the orchestrator evaluates whether additional rounds are needed. This applies to all dispatch types (fast-path and LLM-dispatched).

This does NOT apply to single-bot groups (orchestrator is bypassed entirely).

## Expected Behavior

1. **Evaluation**: Orchestrator LLM reviews the latest round's replies
2. **Decision**: Returns `{ shouldContinue, respondents: string[] (max 1 name), reasoning }`
3. **Enforcement**: Round 2+ allows at most 1 respondent per round
4. **Per-bot limit**: Each bot can reply at most `MAX_BOT_REPLIES_PER_TURN = 2` times across all rounds
5. **Epoch check**: If a new user message arrived (epoch changed), current turn is abandoned

## Decision Process

Continue criteria are evaluated FIRST. Stop heuristics apply ONLY when no continue criterion is met.

### Continue Criteria (checked first)

- A bot **promised to deliver something concrete** in this turn but hasn't yet (same bot must follow up)
- A **direct question remains unanswered**
- **Genuine disagreement or factual correction** detected
- A bot's reply **substantively targets another specific bot** in a way that naturally invites a reaction: offering something concrete, giving a personalized recommendation, expressing concern, teasing, or giving direct advice. This STILL counts even if the gesture involves a future action ("I'll bring you X") — the deferred-promise stop heuristic resolves only the promiser's follow-up obligation, not the addressed bot's natural reaction
- A **member sender** has not yet responded — if latest-round replies materially respond to what the sender said (answering their question, giving a recommendation they invited, or reacting to their situation in a way that expects acknowledgment), the sender should react

### Stop Heuristics (apply only when no continue criterion matched)

- **Deferred promise**: "I'll check later" / "Let me get back to you" — the promiser's obligation to deliver is resolved
- **Echo / paraphrase**: Bot just restated what another said
- **Generic agreement**: "Me too" / "I agree" — no new substance
- **Mere name mention**: Referencing another bot without needing their reply
- **Low-stakes courtesy**: "Let me know if you need help" / "Take care" — standing offers, not actionable now
- **External sender asking follow-up**: They'll reply naturally via new message

## Example

```
Round 1:
  Alice: "I'll create a mockup for option A"
  Bob: "I think option B is better because..."

→ Continue eval: shouldContinue=true
  reasoning: "Genuine disagreement between Alice (option A) and Bob (option B)"
  respondents: [["Alice"]]

Round 2:
  Alice: "Good point about option B. Let me adjust — I'll incorporate Bob's feedback into the mockup"

→ Continue eval: shouldContinue=false
  reasoning: "Disagreement resolved. Alice's promise is deferred ('let me adjust'), not immediately deliverable"
```

## Key Code Path

- Continue prompt: `buildContinuePrompt()` in `handler.ts`
- LLM call: `callOrchestratorContinue()` in `coordinator-llm.ts`
- Guard logic: `applyContinueGuard()` in `coordinator-utils.ts`
- Loop: continue-eval loop in `executeTurn()`, `coordinator.ts`

## Edge Cases

- **Bot hit reply limit**: If the only candidate has already replied `MAX_BOT_REPLIES_PER_TURN` times, turn ends regardless of LLM decision
- **LLM returns multiple respondents for round 2+**: Guard enforces max 1 — takes the first valid one
- **LLM timeout on continue eval**: Defaults to `shouldContinue=false` (stop)
- **Epoch stale**: New user message arrived mid-evaluation — current turn abandoned, new turn starts

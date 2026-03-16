# UC-03: Reply to Bot Message

## Trigger

User replies to a specific bot's message in the group chat (using the platform's reply/quote feature).

## Expected Behavior

1. **Dispatch**: Fast-path — reply-to is treated as an implicit mention
2. **Respondents**: Only the bot whose message was replied to
3. **Waves**: Single wave `[["RepliedBot"]]`
4. **Continue eval**: Yes — LLM evaluates whether follow-up is needed after the replied bot responds
5. **Persistence**: User message + bot reply persisted to D1

## Example

```
Alice: Here's my analysis of the data...

User (replying to Alice's message): Can you elaborate on point 3?

→ replyToName resolved to "Alice"
→ mentionedNames = ["Alice"]
→ Fast-path: [["Alice"]]
→ Alice responds
→ Continue eval: LLM evaluates if follow-up is needed
→ Turn ends
```

## Key Code Path

- Reply-to resolution: `executeTurn()` in `coordinator.ts`, matches `replyToName` against bot channel identities
- Falls into same fast-path as explicit @mention once `mentionedNames` is populated

## Edge Cases

- **Reply to non-bot message**: If the replied message was from a human user (not a bot), `replyToName` won't match any bot — falls through to LLM dispatch
- **Reply + explicit @mention**: If user both replies to Bot A and @mentions Bot B, both are included in `mentionedNames`
- **replyToName format**: Channel adapters provide the first name or username — matching logic must handle both formats

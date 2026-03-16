# UC-05: Bot-Initiated Group Message

## Trigger

A bot uses the `send_to_group` tool to proactively send a message to the group. This happens when a bot decides (based on its own logic or a scheduled task) to initiate communication.

## Expected Behavior

1. **Message persistence**: Bot's message is persisted to all group members' D1 sessions
2. **Channel delivery**: Message sent to the group chat channel
3. **Orchestrator trigger**: `dispatchToOrchestrator()` is called, giving other bots a chance to respond
4. **Dispatch**: Fast-path if only one other bot available (sender excluded), otherwise LLM-based
5. **Sender exclusion**: The initiating bot is excluded from round 1 respondents (marked as `senderBotId`)
6. **Continue eval**: Yes — other bots may need follow-up

## Example

```
Alice (bot) uses send_to_group: "I found an interesting article about AI trends"

→ Message persisted to all bots' sessions
→ Message sent to group channel
→ Orchestrator triggered with isBotMessage=true, senderBotId="alice-id"
→ LLM dispatch decides: [["Bob"]] (Bob has relevant expertise)
→ Bob responds to Alice's message
→ Continue eval: shouldContinue=false
→ Turn ends
```

## Key Code Path

- Tool implementation: `send_to_group` in `src/tools/group-message.ts`
- Message persistence: Persists to each bot's session via D1
- Orchestrator dispatch: `dispatchToOrchestrator()` callback
- Sender exclusion: `senderBotId` parameter in dispatch functions

## Edge Cases

- **Bot not in any group**: Tool returns error message to the bot
- **Bot in multiple groups**: If `group_name` not specified, tool returns an error listing available group names and asking the bot to re-invoke with `group_name` specified
- **No other bots respond**: Orchestrator may decide no response is needed — turn ends silently
- **Sender tries to respond to self**: `senderBotId` exclusion prevents the initiating bot from responding in round 1 (can respond in round 2+ via continue eval)

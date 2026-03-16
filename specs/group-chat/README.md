# Group Chat Use Cases

This directory documents the complete set of group chat use cases for the multibot orchestrator.
Each use case describes a specific interaction pattern, its dispatch strategy, and expected behavior.

The goal is to serve as a regression reference — when fixing one case, check that other cases are not broken.

## Use Case Index

| # | Use Case | Dispatch | Continue Eval |
|---|----------|----------|---------------|
| [UC-01](uc-01-explicit-mention.md) | @mention single bot | Fast-path | Yes |
| [UC-02](uc-02-multi-mention.md) | @mention multiple bots | Fast-path (parallel) | Yes |
| [UC-03](uc-03-reply-to-bot.md) | Reply to bot message | Fast-path | Yes |
| [UC-04](uc-04-general-message.md) | General message (no mention) | LLM dispatch | Yes |
| [UC-05](uc-05-bot-initiated-message.md) | Bot sends to group | LLM dispatch | Yes |
| [UC-06](uc-06-continue-evaluation.md) | Auto-continuation rounds | N/A (eval logic) | — |
| [UC-07](uc-07-session-reset.md) | /new session reset | Direct | No |

## Architecture Overview

```
User Message → Webhook → Primary Bot Dedup → ChatCoordinator DO
                                                    │
                                        ┌───────────┴───────────┐
                                        │                       │
                                   Fast-path               LLM Dispatch
                                 (mentions/reply)        (orchestrator LLM)
                                        │                       │
                                        └───────────┬───────────┘
                                                    │
                                              Wave Execution
                                           (parallel per wave)
                                                    │
                                            Continue Eval Loop
                                          (rounds 2+ if needed)
```

## Key Files

- `src/group/coordinator.ts` — ChatCoordinator DO, main orchestration loop
- `src/group/coordinator-utils.ts` — TurnSerializer, EpochTracker, dispatch guards
- `src/group/coordinator-llm.ts` — Orchestrator LLM calls (dispatch + continue)
- `src/group/coordinator-bot-call.ts` — Bot invocation logic
- `src/group/handler.ts` — Prompt building, mention resolution
- `src/tools/group-message.ts` — `send_to_group` tool for bot-initiated messages

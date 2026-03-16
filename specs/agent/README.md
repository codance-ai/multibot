# Agent Module Use Cases

This directory documents the core chat processing engine — the MultibotAgent Durable Object and its supporting modules.
The agent module handles single-bot chat, group-chat bot processing, session management, memory lifecycle, system prompt construction, and the LLM agent loop.

The goal is to serve as a regression reference — when modifying agent behavior, check that other use cases are not broken.

## Use Case Index

| # | Use Case | Entry Point | Fire & Forget |
|---|----------|-------------|---------------|
| [UC-01](uc-01-single-chat.md) | Private single-bot chat | `/chat` | Yes |
| [UC-02](uc-02-group-chat-processing.md) | Group chat bot processing | `/group-chat` | No (sync) |
| [UC-03](uc-03-session-reset.md) | /new session reset | `/chat` or `/group-chat` | Yes (consolidation) |
| [UC-04](uc-04-memory-consolidation.md) | Memory consolidation | Background | Yes |
| [UC-05](uc-05-memory-review.md) | Periodic memory review | Cron | Yes |
| [UC-06](uc-06-system-prompt.md) | System prompt construction | Internal | N/A |
| [UC-07](uc-07-agent-loop.md) | Agent loop mechanics | Internal | N/A |

## Architecture Overview

```
Webhook / Coordinator
        │
        ▼
  MultibotAgent DO
  (multibot.ts)
        │
        ├── /chat ──────────► processChat() ──► runAgentLoop()
        │   (fire-and-forget)   (multibot-chat.ts)  (loop.ts)
        │
        ├── /group-chat ────► processChat() ──► runAgentLoop()
        │   (synchronous)       (different options)
        │
        └── onCronJob ──────► executeCronJob() ──► runAgentLoop()

  /new is NOT a separate endpoint — it's a regex match
  inside processChat() that short-circuits before the agent loop.
                                (multibot-cron.ts)

  processChat() pipeline:
  ┌──────────────────────────────────────────────────────────┐
  │ Phase 1 (parallel): session, skillSecrets, attachments   │
  │ Phase 2 (serial):   buildAgentTools                   │
  │ Phase 3 (parallel): buildPromptAndHistory,            │
  │                     materializeSandboxFiles            │
  │ → runAgentLoop → resolve reply → persist → send       │
  └──────────────────────────────────────────────────────┘

  System Prompt (5 orthogonal layers):
  ┌─────────────────────────────┐
  │ 1. Identity (persona)       │
  │ 2. System (runtime context) │
  │ 3. Bootstrap (AGENTS/SOUL/  │
  │    USER/TOOLS.md)           │
  │ 4. Memory (MEMORY.md)       │
  │ 5. Skills Summary (XML)     │
  └─────────────────────────────┘
```

## Key Files

- `src/agent/multibot.ts` — MultibotAgent Durable Object (main entry point, routing, consolidation)
- `src/agent/multibot-chat.ts` — Shared chat processing logic (`processChat()`)
- `src/agent/loop.ts` — Agent loop (`runAgentLoop()`, tool error wrapping, message merging)
- `src/agent/context.ts` — System prompt builder (5 orthogonal layers)
- `src/agent/memory.ts` — Memory consolidation (`consolidateMemory()`) and review (`reviewMemory()`)
- `src/agent/multibot-build.ts` — Tool assembly (`buildAgentTools()`) and history reconstruction (`buildPromptAndHistory()`)
- `src/agent/multibot-cron.ts` — Cron job execution (`executeCronJob()`)
- `src/agent/multibot-channel.ts` — Channel message sending (`sendChannelMessage()`) and typing (`startTypingLoop()`)
- `src/agent/multibot-helpers.ts` — Timeout (`withTimeout()`), pending request tracking, constants

# Specs

Specification documents for multibot's core subsystems. Serves as a regression reference — when modifying a subsystem, check the relevant spec to ensure existing behavior is preserved.

## Index

| Spec | Description |
|------|-------------|
| [Agent](agent/README.md) | Core chat engine: agent loop, memory, system prompt, cron jobs |
| [Group Chat](group-chat/README.md) | Orchestrator dispatch, continue evaluation, and all group chat use cases |
| [Skills](skills/README.md) | Skill discovery, on-demand loading, lazy hydration, installation |
| [Channels](channels/README.md) | Multi-channel abstraction: Telegram, Discord, Slack adapters |
| [Tools](tools/README.md) | Tool assembly, exec, memory, browse, cron scheduling |
| [Timeout Architecture](timeout-architecture.md) | Three-layer timeout model (fast-fail, step, request) and browse lazy install |

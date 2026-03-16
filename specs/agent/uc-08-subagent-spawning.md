# UC-08 Sub-Agent Spawning

## Goal

Allow a single bot to spawn background sub-agents for parallel task execution, with async result delivery back to the parent session.

## Flow

1. Parent agent calls `spawn_subagent(task, label)` tool during `runAgentLoop()`.
2. Tool validates spawn depth and concurrent children limits.
3. A child D1 session is created and a `SubagentRun` is registered in DO storage.
4. The child runs `processChat()` in `ctx.waitUntil()` with the same tool set (minus `spawn_subagent` at max depth) and a focused sub-agent system prompt suffix.
5. When the child finishes, its result is persisted to DO storage and D1 (`subagent_runs` table).
6. `SubagentDrainManager.scheduleDrain()` is called, which enqueues a drain via per-session `TurnSerializer`.
7. Drain claims all completed runs for the session, persists results as `role='subagent'` messages in the parent session, then triggers a new `processChat()` cycle.
8. Parent LLM sees sub-agent results in conversation history (converted to `role='user'` with `[Sub-Agent: label | runId: xxx]` prefix for LLM consumption) and generates a response.

## Message Storage

- Sub-agent results are stored in D1 `messages` table with `role='subagent'`.
- `getConversationHistory()` includes `'subagent'` in its role filter.
- When building LLM messages, `role='subagent'` is converted to `role='user'` (all providers support user role).
- Dashboard detects `role='subagent'` for distinct rendering.

## Concurrency & Safety

- **Serialization**: Per-session `TurnSerializer` (same pattern as `ChatCoordinator`) serializes user message processing and drain delivery for the same session.
- **Session epoch**: `/new` command bumps epoch in DO storage. Stale sub-agent results (from before `/new`) are dropped during drain.
- **Orphan recovery**: On first `/chat` request, scan DO storage for runs stuck in `"running"` past `PENDING_ORPHAN_MS`. Mark as error and trigger drain.

## Limits (configurable via `BotConfig.subagent`)

| Config | Default | Description |
|--------|---------|-------------|
| maxSpawnDepth | 3 | Max nesting depth |
| maxChildrenPerSession | 5 | Max concurrent sub-agents per parent session |
| subagentTimeout | 120s | Per-sub-agent execution timeout |

## Edge Cases

- **User sends message during sub-agent execution**: Normal processing via TurnSerializer. Parent LLM can reference pending spawns from conversation history.
- **Sub-agent fails/times out**: Error result delivered to parent via drain. Parent LLM can report failure and potentially retry.
- **Multiple sub-agents complete simultaneously**: Drain collects ALL completed runs at claim time, batching them into one synthetic message.
- **DO eviction**: `waitUntil()` promises lost. Orphan recovery on next request marks stale runs as errors.
- **`/new` after spawning**: Session epoch bumped, stale results dropped during drain.

## Observability

- `subagent_runs` D1 table stores run history (for dashboard).
- Dashboard renders `role='subagent'` messages with distinct styling.
- Dashboard shows SubagentRunsPanel per session with status, duration, tokens, and child session navigation.

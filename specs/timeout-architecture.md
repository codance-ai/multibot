# Timeout Architecture

Three-layer timeout model for request lifecycle management.

## Design Principles

- **Two safety nets + fast-fail**: Step-level and request-level timeouts are system guardrails; tool-level timeouts provide business-layer fast-fail
- **Fast-fail value**: When a tool times out, it returns an error to the LLM within the same step, giving the LLM a chance to respond gracefully (e.g., "website is unreachable"). Without tool-level timeouts, the step timeout hard-kills the entire `generateText` call and the LLM never gets to respond
- **No fake cancellation**: Sandbox exec/browse cannot kill remote processes (WebSocket disconnect only rejects on the Worker side) — don't pretend otherwise
- **Group chat responsiveness**: Maintain independent per-bot timeout so a single slow bot doesn't block the entire group turn

## Timeout Model

### Three Layers

| Layer | Value | Scope | Mechanism |
|---|---|---|---|
| **Fast-fail** | Per-tool (10-60s) | Single external I/O — returns error to LLM quickly | `AbortSignal.timeout()` / sandbox timeout inside each tool |
| **Step** | **90s** (`STEP_TIMEOUT_MS`) | One LLM reasoning round + tool execution | `AbortSignal.timeout()` passed to `generateText` |
| **Request** | **3min** (`REQUEST_TIMEOUT_MS`) | Entire request lifecycle (multi-round loop + D1 + channel sends) | `withTimeout()` + AbortController |

### Tool-Level Fast-Fail Timeouts

| Tool | Timeout | Location |
|---|---|---|
| web-fetch | 15s | `web-fetch.ts` `FETCH_TIMEOUT_MS` |
| web-search | 10s | `web-search.ts` `TIMEOUT_MS` |
| skill download | 30s | `skill.ts` `AbortSignal.timeout(30_000)` |
| skill search | 10s | `skill.ts` `AbortSignal.timeout(10_000)` |
| exec | 60s | `exec.ts` `DEFAULT_TIMEOUT` |
| browse curl | 60s | `browse.ts` sandbox exec timeout |

### Group Chat Timeouts

| Constant | Value | Purpose |
|---|---|---|
| `GROUP_BOT_TIMEOUT_MS` | 120s | Coordinator's per-bot wait limit (`Promise.race`) |
| `ORCHESTRATOR_TIMEOUT_MS` | 30s | Routing decision LLM call timeout |
| `deadline` | `Date.now() + GROUP_BOT_TIMEOUT_MS` | Passed to bot — bot self-stops typing/progress after deadline |

### Related Constants

| Constant | Value | Purpose |
|---|---|---|
| `PENDING_ORPHAN_MS` | `REQUEST_TIMEOUT_MS + 30s` = 3.5min | Orphaned request detection threshold |

## Key Code Paths

### Step Timeout (`loop.ts`)

`combinedAbortSignal()` combines the per-step timeout with the parent request abort signal. Whichever fires first wins.

```typescript
const STEP_TIMEOUT_MS = 90_000;

function combinedAbortSignal(parentSignal?: AbortSignal): AbortSignal {
  const perCall = AbortSignal.timeout(STEP_TIMEOUT_MS);
  if (!parentSignal) return perCall;
  return AbortSignal.any([parentSignal, perCall]);
}
```

### Request Timeout (`multibot-helpers.ts`)

`withTimeout()` wraps the entire `processChat()` call. On timeout, it aborts the AbortController and rejects with `RequestTimeoutError`.

### Group Chat Deadline

The coordinator passes `payload.deadline` to tell the bot "I will give up on you after 120s." The bot's typing loop and progress sends check this deadline and self-stop when it passes. This is necessary because the coordinator's `Promise.race` timeout is a local reject — it cannot actually cancel the bot DO's execution.

- Typing loop: `if (deadline && Date.now() > deadline) break` in `multibot-channel.ts`
- Progress sends: `if (payload.deadline && Date.now() > payload.deadline) return` in `multibot-chat.ts`

## Browse Lazy Install

Playwright first-time installation takes ~30-60 seconds (headless shell only, via `--only-shell`).

**Approach**: First call checks marker file → not found → fire-and-forget triggers background install → immediately returns a message asking the user to retry → subsequent requests find the marker and proceed normally.

- `flock` prevents concurrent installations at the shell level
- File marker (`.playwright-ready-v2`) is the persistent "ready" signal
- No DO storage state machine needed

## Edge Cases

- **Step timeout vs tool timeout**: Tool timeouts must be shorter than `STEP_TIMEOUT_MS` (90s) to be effective. If a tool timeout is longer, the step timeout fires first and hard-kills the step
- **Group bot timeout < request timeout**: The 60s gap (120s vs 180s) means a bot may continue running after the coordinator gives up. The `deadline` field prevents ghost typing/progress during this gap
- **Sandbox timeout cannot kill remote processes**: `exec` and `browse` sandbox timeouts only disconnect the WebSocket on the Worker side. The remote Sprites process continues running — results are simply discarded

## Timeout Hierarchy

```
Request (3min) ────────────────────────────────────────────────────────┐
│                                                                      │
│  Step 1 (90s) ──────────────────────────┐                            │
│  │  LLM reasoning (~15s)               │                            │
│  │  Tool execution ─────────┐          │                            │
│  │  │  Fast-fail (10-60s)   │          │                            │
│  │  │  Returns error to LLM │          │                            │
│  │  └───────────────────────┘          │                            │
│  └──────────────────────────────────────┘                            │
│                                                                      │
│  Step 2 (90s) ──────────────────────────┐                            │
│  │  LLM reasoning → final reply        │                            │
│  └──────────────────────────────────────┘                            │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Key Files

- `src/agent/loop.ts` — `STEP_TIMEOUT_MS`, `combinedAbortSignal()`
- `src/agent/multibot-helpers.ts` — `REQUEST_TIMEOUT_MS`, `withTimeout()`, `PENDING_ORPHAN_MS`
- `src/group/coordinator-utils.ts` — `GROUP_BOT_TIMEOUT_MS`, `ORCHESTRATOR_TIMEOUT_MS`
- `src/group/coordinator-bot-call.ts` — `deadline` field, per-bot `Promise.race`
- `src/agent/multibot-channel.ts` — Typing loop deadline check
- `src/tools/browse.ts` — Lazy install (`ensureBrowseReady`)

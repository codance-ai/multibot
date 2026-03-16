# multibot

## General Rules

- **Reply in Chinese by default**, unless the user explicitly requests English

## Solution Design Process

1. **Read specs first**: Before modifying any feature, read all related specs under `specs/` to understand the full picture and existing use cases
2. **Design from principles, not driven by individual cases**: Solutions must stem from responsibility separation and architectural principles — no case-specific hardcoded fixes. Ask yourself: "Is this approach reasonable for all scenarios?"
3. **User experience validation**: Review the solution from the end user's perspective — does this behavior match user expectations? Is it natural? Would it confuse users? Don't settle for technical correctness while ignoring actual usability
4. **List impact scope**: Solutions must explicitly list which specs, modules, and existing behaviors are affected, ensuring nothing breaks
5. **Wait for user confirmation before coding**: Never start implementation without confirmation
6. **Verify compliance before committing**: Before committing, list each confirmed design decision and compare against the actual implementation. Any mismatch must be fixed or discussed with the user first — don't silently downgrade and dismiss it as "acceptable trade-off"

## Core Principles

- **General-purpose bot platform**: This is a general-purpose multi-bot platform — no customization for specific scenarios/topics. All solutions (prompt rules, orchestrator logic, behavior constraints) must be universal for any bot type and conversation scenario
- **Feature reference: nanobot / OpenClaw**: Core behavior parameters (memoryWindow, conversation history count, consolidation prompts) reference nanobot and OpenClaw designs, extensible as needed
- **Multi-channel support**: No hardcoding of any channel (telegram/discord/slack etc.) in code — channel is passed via routing or parameters
- **Multi-LLM support**: No provider-specific customizations — solutions must be compatible with all providers

## Tech Stack

- Cloudflare Workers + Durable Objects (Agents SDK)
- Vercel AI SDK v6 (`ai@^6.0`, `@ai-sdk/openai@^3.0`)
- TypeScript, Zod

## Development Principles

- **No compatibility/migration code**: Schema changes are made directly — no migration logic (including ALTER TABLE, field detection, etc.). Manually delete DO instances to rebuild when needed
- **Run tests after every change**: Must run `npm test` before committing to ensure all tests pass
- **Development workflow**: Record requirements/issues in issues → create branch → PR → merge PR → close issue
- **Deployment**: Only deploy the main branch — feature branches must be merged to main before deployment
  - `npm run deploy` — Deploy Worker + Dashboard in one command (recommended)
  - `npm run deploy:worker` — Deploy Cloudflare Worker only
  - `npm run deploy:dashboard` — Build and deploy Dashboard to Cloudflare Pages only
- **Keep README in sync**: Update relevant sections of README.md when project features, architecture, or configuration change
- **Develop against specs**: Check relevant specs under `specs/` before modifying features to avoid breaking existing use cases; update corresponding specs after changes to keep specs and code in sync
- **Fix root causes**: No minimal fixes / band-aid patches — find the root cause of bugs and fix them at the architectural level to prevent recurrence
- **Prioritize problems**: If a problem will naturally resolve as model capabilities improve, it's not worth engineering effort — spend time on architecture and mechanism problems that models can't solve
- **Check actual state when debugging**: Don't just report issue status — check actual bot conversations, logs, and D1 data to verify
- **No silent failures**: All catch blocks must have log output (`console.error` / `console.warn`) — no empty catch or `.catch(() => {})`. Even for best-effort / non-fatal operations, always log to ensure traceability
- Be bold with changes, ask the user when uncertain

## Notes

- `@ai-sdk/openai` v3 defaults to the Responses API (`/v1/responses`). For OpenAI-compatible providers (e.g., Moonshot), use `openai.chat(modelId)` to go through the Chat Completions API
- AI SDK v6 type changes: `CoreMessage` → `ModelMessage`, `parameters` → `inputSchema`, message content must use array format

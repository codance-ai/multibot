# UC-01: Tool Assembly Per Request

## Trigger

Every agent loop invocation calls `buildAgentTools()` to assemble the complete `ToolSet` for that request. The assembly is driven by bot type, bot config, channel, and environment bindings.

## Expected Behavior

1. **Static tools** are always included: `web_fetch` (from `getTools()`)
2. **Memory tools** are always included: `memory_read`, `memory_write`, `memory_append`, `memory_edit`, `memory_grep` (backed by D1 `bot_memory` and `bot_history` tables)
3. **Admin tools** are included only when `botConfig.botType === "admin"`
4. **Cron tools** are always included, using the bot's own channel token (not the request's `channelToken`) to fix group chat token bugs
5. **Exec tools** are always included, with optional skill secrets injection and lazy skill hydrator
6. **Filesystem tools** are always included: `read_file`, `write_file`, `edit_file`, `list_dir`
7. **Load skill tool** is always included, routing to builtin skills (in-memory) or R2 (installed skills)
8. **Web search** is always included (requires Brave API key in `userKeys`)
9. **Browse tools** (`browse`, `browse_interact`) are included only when sandbox backend is `"sprites"` and a sandbox client is available
10. **Group message tool** (`send_to_group`) is included only when `enableMessageTool` is true AND the bot belongs to at least one group (looked up via `findAllGroupsForBot`)
11. **Skill management tools** (`register_skill`, `unregister_skill`, `install_skill`, `search_skills`) are included only for admin bots with an R2 bucket
12. **MCP tools** are included when `botConfig.mcpServers` is configured; `ensureMcpConnected()` is awaited before tool retrieval
13. **Lazy skill hydrator** is created only when the bot has `enabledSkills` and an `ASSETS_BUCKET` is available
14. All tool sets are merged via `mergeTools()`, which uses `Object.assign` -- later tools override earlier ones if names collide

## Example

```
Request: private chat with admin bot, Sprites sandbox, bot belongs to 1 group

→ buildAgentTools()
  → getTools()                    → { web_fetch }
  → createMemoryTools()           → { memory_read, memory_write, memory_append, memory_edit, memory_grep }
  → createAdminTools()            → { ... admin tools }
  → createCronTools()             → { cron }
  → createExecTools(sandbox, secrets, hydrator)  → { exec }
  → createFilesystemTools()       → { read_file, write_file, edit_file, list_dir }
  → createLoadSkillTool()         → { load_skill }
  → createWebSearchTool()         → { web_search }
  → createBrowseTools()           → { browse, browse_interact }
  → createGroupMessageTools()     → { send_to_group }
  → createSkillTools()            → { register_skill, unregister_skill, install_skill, search_skills }
  → ensureMcpConnected() + getMcpTools() → { ...mcp tools }
  → mergeTools(all of the above)  → final ToolSet
```

## Key Code Path

- Entry point: `buildAgentTools()` in `src/agent/multibot-build.ts`
- Static tools: `getTools()` in `src/tools/registry.ts`
- Merge: `mergeTools()` in `src/tools/registry.ts` -- `Object.assign` semantics
- Cron scheduler selection: `localCronScheduler` flag switches between local DO scheduler and remote proxy
- Skill hydrator creation: `createSkillHydrator()` in `src/skills/ensure-ready.ts`
- Group lookup: `findAllGroupsForBot()` in `src/db/config.ts`

## Edge Cases

- **No sandbox client**: Browse tools return empty `ToolSet` and no-op cleanup. Exec and filesystem tools still work (they use the same `SandboxClient` interface)
- **Non-sprites backend**: Browse tools are excluded (only sprites supports Playwright)
- **No Brave API key**: `web_search` is still included but will throw "BRAVE_API_KEY not configured" when invoked
- **No R2 bucket**: Skill management tools are excluded for admin bots; `load_skill` skips R2 path
- **No MCP servers configured**: MCP connection step is skipped, empty tool set merged
- **Bot belongs to no groups**: `send_to_group` is not included even if `enableMessageTool` is true
- **Tool name collision**: Later tool sets in `mergeTools()` silently override earlier ones (by design -- MCP tools can override builtins)

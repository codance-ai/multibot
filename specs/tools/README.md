# Tools Module Use Cases

This directory documents the tool subsystem of multibot: how tools are assembled per request, and the behavior of each major tool category.

Every bot request triggers tool assembly, which merges 12+ tool sets based on bot type, configuration, and available integrations. Individual tools range from shell execution with safety guards to headless browsing with automatic fetch fallback.

## Use Case Index

| # | Use Case | Scope | Key Constraint |
|---|----------|-------|----------------|
| [UC-01](uc-01-tool-assembly.md) | Tool assembly per request | buildAgentTools | Bot type, config, channel determine which tools are included |
| [UC-02](uc-02-exec.md) | Shell execution | exec tool | Safety deny patterns, skill hydration trigger, secret redaction |
| [UC-03](uc-03-memory-tools.md) | Memory read/write/edit/append/grep | memory_* tools | MEMORY.md vs HISTORY.md have different allowed operations |
| [UC-04](uc-04-browse.md) | Headless browser with fetch fallback | browse, browse_interact | Playwright in Sprites sandbox, challenge detection triggers fallback |
| [UC-05](uc-05-cron.md) | Scheduled job management | cron tool | at/every/cron_expr modes, timezone-aware scheduling |

## Architecture Overview

```
buildAgentTools()
  │
  ├── getTools()              → static tools (web_fetch)
  ├── createMemoryTools()     → memory_read, memory_write, memory_append, memory_edit, memory_grep
  ├── createAdminTools()      → admin-only (bot type == "admin")
  ├── createCronTools()       → cron (add/list/remove)
  ├── createExecTools()       → exec (shell commands in sandbox)
  ├── createFilesystemTools() → read_file, write_file, edit_file, list_dir
  ├── createLoadSkillTool()   → load_skill (builtin or R2)
  ├── createWebSearchTool()   → web_search (Brave API)
  ├── createBrowseTools()     → browse, browse_interact (Sprites only)
  ├── createGroupMessageTools()→ send_to_group (if bot belongs to groups)
  ├── createSkillTools()      → register_skill, unregister_skill, install_skill, search_skills (admin only)
  ├── ensureMcpConnected()    → MCP tools (dynamic, from bot config)
  └── mergeTools(...)         → final ToolSet passed to agent loop
```

## Key Files

- `src/agent/multibot-build.ts` -- `buildAgentTools()`, tool assembly orchestration
- `src/tools/registry.ts` -- `getTools()`, `mergeTools()` utility
- `src/tools/exec.ts` -- Shell execution with safety guards and skill hydration
- `src/tools/memory.ts` -- Memory CRUD tools (D1-backed)
- `src/tools/browse.ts` -- Headless browser (Playwright in Sprites sandbox)
- `src/tools/browse-safety.ts` -- SSRF prevention (`assertSafeUrl`)
- `src/tools/cron.ts` -- Cron scheduling tools with timezone support
- `src/tools/skill.ts` -- Skill management (register, unregister, install, search)
- `src/tools/load-skill.ts` -- `load_skill` tool (routes builtin vs R2)
- `src/tools/filesystem.ts` -- Sandbox file operations (read, write, edit, list)
- `src/tools/web-fetch.ts` -- HTTP fetch with HTML-to-markdown extraction
- `src/tools/web-search.ts` -- Brave Search API wrapper
- `src/tools/group-message.ts` -- `send_to_group` for bot-initiated group messages
- `src/tools/sandbox-types.ts` -- `SandboxClient` interface abstraction
- `src/tools/sprites-sandbox.ts` -- Fly.io Sprites sandbox client implementation
- `src/skills/ensure-ready.ts` -- Lazy skill hydrator (R2 to sandbox on-demand)

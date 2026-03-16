# Skills Module Use Cases

This directory documents the complete set of skill lifecycle use cases for the multibot platform.
Each use case describes a specific phase of skill management — from discovery and loading to installation and dependency resolution.

The goal is to serve as a regression reference — when modifying skill behavior, check that other use cases are not broken.

## Use Case Index

| # | Use Case | Phase | Key Entry Point |
|---|----------|-------|-----------------|
| [UC-01](uc-01-skill-discovery.md) | Skill discovery & filtering | System prompt build | `listAllSkills()` |
| [UC-02](uc-02-on-demand-loading.md) | On-demand loading (load_skill) | Runtime (tool call) | `createLoadSkillTool()` |
| [UC-03](uc-03-lazy-hydration.md) | Lazy hydration with dedup | Runtime (pre-exec) | `createSkillHydrator()` |
| [UC-04](uc-04-skill-installation.md) | Skill installation (ClawHub / GitHub) | Admin action | `install_skill` tool |
| [UC-05](uc-05-dependency-management.md) | Dependency management (npm/pip/download) | Install / hydration | `executeInstallSpec()` |

## Architecture Overview

```
System Prompt Build                     Runtime (tool call)
       |                                        |
  listAllSkills()                       load_skill(name)
  bundled + D1 installed                        |
  enabledSkills filter              +-----------+-----------+
  adminOnly auto-visible            |                       |
       |                       Builtin                 Installed
  buildSkillsSummaryXml()      (in-memory)              (R2)
  <skills> XML with                                      |
  env configured status                          ensureSkillReady()
       |                                         lazy hydration
  System Prompt                                          |
                                                 +----- marker check
                                                 |      (hot path)
                                                 |
                                           install deps -----> executeInstallSpec()
                                           (behind mutex)      npm / pip / download
                                                 |
                                           copy files from R2
                                                 |
                                           write marker
```

## Storage Architecture

```
Bundled Skills          Installed Skills
(build-time import)     (D1 metadata + R2 files)
      |                        |
 BUILTIN_SKILLS map     D1 `skills` table ──── name, description, emoji, path, content, requires_env
      |                        |
 BUNDLED_SKILL_META     R2 `installed-skills/{name}/` ──── SKILL.md + supporting files
```

## Key Files

- `src/skills/loader.ts` — Skill metadata parsing, listing, XML summary building, D1-based discovery
- `src/skills/ensure-ready.ts` — Lazy hydration factory with concurrent dedup and install mutex
- `src/skills/install.ts` — Dependency installation (npm, pip, download), validation, OS compatibility
- `src/skills/builtin.ts` — Built-in skill definitions, build-time imports, metadata extraction
- `src/skills/metadata.ts` — Metadata namespace resolution (nanobot/openclaw/clawdbot)
- `src/tools/load-skill.ts` — `load_skill` tool: routes to builtin (in-memory) or installed (R2)
- `src/tools/skill.ts` — `register_skill`, `unregister_skill`, `install_skill`, `search_skills` tools
- `src/tools/exec.ts` — Shell exec tool with auto-hydration for installed skills
- `src/agent/context.ts` — System prompt builder, skills summary integration
- `src/db/config.ts` — `skill_secrets` CRUD (per-owner env vars for skills)

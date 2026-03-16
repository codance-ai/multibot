# UC-02: Shell Execution (exec)

## Trigger

The LLM invokes the `exec` tool with a shell command, optional working directory, optional environment variables, and optional stdin content.

## Expected Behavior

1. **Safety guard**: The command is checked against `DENY_PATTERNS` (destructive operations like `rm -rf`, `mkfs`, `dd if=`, `shutdown`, fork bombs, etc.). If any pattern matches, the command is blocked immediately with an error message -- no execution occurs
2. **Skill hydration trigger**: If `ensureSkillReady` is provided, the command and `working_dir` are scanned for `/installed-skills/{name}/` patterns via `extractSkillNameFromCommand()`. If a skill name is found, lazy hydration is triggered (R2 files copied to sandbox, dependencies installed). Hydration failure returns an error
3. **Stdin piping**: If `stdin` is provided, it is injected as the `__EXEC_STDIN__` environment variable, and the command is prefixed with `printenv __EXEC_STDIN__ | ...` to safely pipe input without shell expansion
4. **Working directory**: If `working_dir` is set, the command is prefixed with `cd '<path>' && ...` (single quotes are escaped)
5. **Persistent install environment**: PATH, NPM_CONFIG_PREFIX, PYTHONUSERBASE, PIP_USER, cache directories, and NODE_PATH are configured to use `~/.local` (path varies by sandbox backend: `/home/sprite/.local` for Sprites, `/home/.local` otherwise) so that `npm install -g` and `pip install --user` persist across sandbox restarts
6. **Environment variables**: Skill secrets and user-provided `env` are merged (user env overrides secrets), passed to `sandbox.exec()`
7. **Output formatting**: stdout + stderr are combined. Non-zero exit codes are appended. Empty output returns `"(no output)"` or `"Exit code: N"`
8. **Secret redaction**: If skill secrets are configured, all secret values (4+ chars) are replaced with `[REDACTED]` in the output before returning to the LLM
9. **Output truncation**: Output is capped at 10,000 characters with a `"... (truncated, N more chars)"` suffix
10. **Timeout**: Default 60 seconds. Timeout errors are re-thrown with a user-friendly message

## Example

```
LLM calls: exec({ command: "python3 /installed-skills/humanizer/run.py", stdin: "Hello world" })

→ guardCommand("python3 /installed-skills/humanizer/run.py") → null (safe)
→ extractSkillNameFromCommand("python3 /installed-skills/humanizer/run.py") → "humanizer"
→ ensureSkillReady("humanizer")
  → Check R2 for SKILL.md, parse frontmatter
  → Check sandbox marker file for hash match
  → If missing: install deps (behind mutex), copy files from R2, write marker
→ Build command:
  env.__EXEC_STDIN__ = "Hello world"
  fullCommand = "printenv __EXEC_STDIN__ | python3 /installed-skills/humanizer/run.py"
  fullCommand = "export PATH=...; export NPM_CONFIG_PREFIX=...; ...; " + fullCommand
→ sandbox.exec(fullCommand, { env: { __EXEC_STDIN__: "Hello world", ...secrets }, timeout: 60000 })
→ Redact secrets from output
→ Truncate if > 10,000 chars
→ Return result
```

## Key Code Path

- Safety guard: `guardCommand()` in `src/tools/exec.ts` -- checks against `DENY_PATTERNS` array
- Skill name extraction: `extractSkillNameFromCommand()` in `src/skills/ensure-ready.ts`
- Skill hydration: `createSkillHydrator()` / `hydrateSingle()` in `src/skills/ensure-ready.ts`
- Install mutex: `withInstallMutex()` serializes all npm/pip installs across skills
- Sandbox paths: `getSandboxPaths()` in `src/tools/sandbox-types.ts`
- Secret redaction: `redactSecrets()` in `src/tools/exec.ts`
- Output truncation: `truncateOutput()` in `src/tools/exec.ts`

## Sprite Health Check

Before any sandbox operation, `ensureSpriteReady` verifies the sprite is both **existing** and **responsive**:

1. `ensureSpriteExists()` — create sprite if it doesn't exist (GET + POST, race-safe)
2. `healthPingSprite()` — execute `true` via WebSocket exec with 10s timeout
3. If ping fails → `destroySprite()` → `ensureSpriteExists()` → re-ping
4. If re-ping fails → throw (sprite is unrecoverable)

The health check result is cached in `spriteReadyPromises` with a **5-minute TTL**. After expiry, the next sandbox operation triggers a fresh health check. This detects sprites that become zombie mid-session.

### Key Code Path

- Health ping: `healthPingSprite()` in `src/tools/sprites-sandbox.ts`
- Full health check: `ensureSpriteHealthy()` in `src/tools/sprites-sandbox.ts`
- TTL cache: `spriteReadyPromises` (Map with `expiresAt`) in `src/agent/multibot.ts`

## Edge Cases

- **Blocked command with partial match**: Patterns are regex-based, so `rm -rf /` is blocked but `rm file.txt` is not. Patterns include word boundaries (`\b`) to avoid false positives
- **Multiple skills in one command**: Only the first `/installed-skills/{name}/` match is hydrated (from `working_dir` first, then `command`)
- **Skill hydration concurrency**: Concurrent calls to `ensureSkillReady()` for the same skill are deduplicated via in-flight promise map. Different skills can hydrate in parallel, but installs are serialized via mutex
- **Skill hydration failure caching**: A failed hydration is cached in `failedSkills` map -- subsequent calls for the same skill return the cached error immediately without retrying
- **Short secret values**: Secrets shorter than 4 characters are not redacted (to avoid replacing common substrings like "1" or "no")
- **Stdin with shell metacharacters**: Using `printenv` + pipe instead of heredoc or echo prevents shell expansion of stdin content
- **Sandbox backend paths**: Sprites uses `/home/sprite/.local`, other backends use `/home/.local` -- mismatch would cause installed packages to not be found
- **Zombie sprite detection**: A sprite can exist (GET 200) but be unable to execute commands (e.g., Fly.io returns 524). The health ping catches this by running `true` via WebSocket exec with a 10s timeout
- **Health check TTL**: Cached for 5 minutes per sprite per DO instance. After TTL expiry, the next operation re-checks health. This balances detection latency vs. unnecessary probes
- **Auto-rebuild limit**: Only one rebuild attempt per health check. If the rebuilt sprite is still unresponsive, the error propagates immediately — no infinite retry loop

# UC-03: Lazy Hydration with Concurrent Dedup

## Trigger

An installed skill is accessed at runtime — either through `load_skill(name)` or when `exec` detects an installed skill path in the command or working directory (pattern: `/installed-skills/{name}/`).

## Expected Behavior

1. **Factory pattern**: `createSkillHydrator(deps)` returns a closure `ensureSkillReady(name)` that tracks state across calls within a single factory instance
2. **Fast check — already ready**: If skill is in `readySkills` set, return immediately (no I/O)
3. **Fast check — previously failed**: If skill is in `failedSkills` map, throw cached error immediately
4. **Concurrent dedup**: If hydration for this skill is already in-flight (`inflight` map), return the same promise — no duplicate work
5. **6-step hydration process** (cold path):
   - **Step 1: R2 read** — Fetch `installed-skills/{name}/SKILL.md` from R2 and parse frontmatter
   - **Step 2: Compute hash** — Deterministic SHA-256 hash of compatible install specs (order-independent, deduplicated). `"no-deps"` if no dependencies
   - **Step 3: Marker check** — Read `{homeLocal}/.skill_ready_{name}` from sandbox. If marker content matches hash, this is the hot path — return immediately
   - **Step 4: Install deps** — Behind install mutex. Check each required bin via `which`. For missing bins, run compatible install specs. Verify all bins present after install
   - **Step 5: Copy files** — List all R2 objects under `installed-skills/{name}/` prefix (paginated). Copy each file to sandbox at `/{key}` path, creating parent directories as needed
   - **Step 6: Write marker** — Write hash to marker file. Hydration complete
6. **Result caching**: On success, add to `readySkills`. On failure, cache error message in `failedSkills`
7. **Install mutex**: All npm/pip install operations are serialized via a promise chain (`installChain`). This prevents concurrent npm/pip processes from corrupting each other. Errors are swallowed in the chain to keep it alive for subsequent installs

## Example

```
First call: ensureSkillReady("humanizer")
  -> Not in readySkills, not in failedSkills, not in inflight
  -> Start hydrateSingle("humanizer")
  -> Step 1: R2 read SKILL.md, parse frontmatter -> requires bins: ["humanize-cli"]
  -> Step 2: install spec = [{kind: "node", package: "humanize-cli"}], hash = sha256(...)
  -> Step 3: marker file not found -> cold path
  -> Step 4: "humanize-cli" not found via `which` -> withInstallMutex -> npm install -g
  -> Step 5: copy 3 files from R2 to sandbox
  -> Step 6: write marker file with hash
  -> Add "humanizer" to readySkills

Concurrent call during hydration: ensureSkillReady("humanizer")
  -> Not in readySkills, check inflight -> found! -> return same promise
  -> Waits for first call to complete

Second call (later): ensureSkillReady("humanizer")
  -> Found in readySkills -> return immediately (no I/O)

Third call to different skill during install: ensureSkillReady("pdf-reader")
  -> Steps 1-3 can run concurrently with humanizer
  -> Step 4: install mutex -> waits for humanizer's npm install to finish before starting pip install
```

```
Hot path (sandbox restart, marker still present):
  ensureSkillReady("humanizer")
  -> Step 1: read SKILL.md from R2
  -> Step 2: compute hash
  -> Step 3: marker file exists and hash matches -> return immediately
  -> No install, no file copy
```

## Key Code Path

- Factory: `createSkillHydrator(deps: { sandbox, r2, sandboxBackend })` in `ensure-ready.ts`
- Hash computation: `computeSpecHash(specs)` — normalizes and sorts specs, SHA-256 hash
- Marker path: `{homeLocal}/.skill_ready_{name}` via `getSandboxPaths(backend)`
- Install mutex: `withInstallMutex(fn)` — chains onto `installChain` promise
- Binary check: `binExists(sandbox, bin, backend)` in `install.ts`
- Install execution: `executeInstallSpec(sandbox, spec, backend)` in `install.ts`
- R2 file listing: `r2.list({ prefix, cursor })` with pagination
- Exec integration: `extractSkillNameFromCommand(command)` in `ensure-ready.ts` — regex `/\/installed-skills\/([a-z0-9-]+)\//` extracts skill name from command or working_dir

## Edge Cases

- **Marker check fails (filesystem error)**: Logged and ignored — continues to install path, self-healing
- **No install specs for missing bins**: Throws error with list of missing binaries and note that no installation instructions are provided
- **No compatible install specs**: Throws error listing the unsupported kinds found (e.g. `brew`, `apt`) vs supported (`node`, `pip`, `uv`, `download`)
- **Install succeeds but bins still missing**: Throws error after exhausting all compatible install specs
- **Install mutex error**: Swallowed to keep the chain alive — logged via `console.warn`, subsequent installs can still proceed
- **R2 SKILL.md not found**: Throws `SKILL.md not found for skill "{name}"` — cached in `failedSkills`
- **Empty install specs**: `computeSpecHash([])` returns `""`, marker hash becomes `"no-deps"` — still writes marker
- **R2 pagination**: Large skills with many files are handled via cursor-based pagination in the copy step
- **Spec hash deduplication**: Duplicate specs (same kind + package/url) are deduplicated before hashing to ensure deterministic markers

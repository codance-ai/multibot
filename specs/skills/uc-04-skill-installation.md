# UC-04: Skill Installation (ClawHub / GitHub)

## Trigger

Admin bot calls `install_skill` tool with either a ClawHub `slug` or a `github_url`. Alternatively, admin can use `register_skill` to register a skill already present in the sandbox filesystem.

## Expected Behavior

### install_skill (ClawHub flow)

1. **Download zip**: Fetch from `https://clawhub.ai/api/v1/download?slug={slug}` with retry (max 2 attempts, 1s base delay). Content-Length checked against 5MB limit
2. **Decompress**: `unzipSync()` (fflate) in Worker memory — no sandbox needed for extraction
3. **Validate files**: Skip directories and path-traversal entries. Find `SKILL.md` in zip root. Check total size against 5MB limit
4. **Parse frontmatter**: Extract name, description, emoji, requires, install specs from SKILL.md YAML frontmatter
5. **Conflict check**: Skill name must not conflict with `BUILTIN_SKILLS`
6. **OS compatibility**: If `metadata.os` is specified, must include `"linux"` (sandbox runs Linux)
7. **Upload to R2**: Clean up old R2 files under prefix, then upload all files to `installed-skills/{name}/`
8. **Write D1 metadata**: Upsert into `skills` table (name, description, emoji, path, content, file_count, requires_env)
9. **Install dependencies**: Check required bins, find compatible install specs, execute in sandbox. Skill is already stored (R2 + D1) at this point — partial success is reported if deps fail

### install_skill (GitHub flow)

1. **Parse URL**: Accepts full GitHub URLs (`github.com/owner/repo/tree/branch/path`), raw URLs, or shorthand (`owner/repo/path`)
2. **Fetch directory**: Recursive Contents API traversal (max 5 levels deep), skips symlinks/submodules
3. **Size check**: Estimated total size from API metadata before downloading
4. **Download files**: Parallel download from raw.githubusercontent.com URLs (doesn't count against API rate limit)
5. **Steps 4-9**: Same as ClawHub flow (validate, parse, conflict check, OS check, R2 upload, D1 write, deps)

### register_skill (from sandbox filesystem)

1. **Path validation**: Must match `/skills/{name}` or `/workspace/skills/{name}`
2. **Read SKILL.md**: From sandbox filesystem at `{path}/SKILL.md`
3. **Steps 4-9**: Same as above but with different ordering — validate, parse, conflict check, OS check, then **deps install before R2 upload and D1 write** (unlike `install_skill` where deps come last)

### unregister_skill

1. **Bundled check**: Cannot unregister bundled skills
2. **D1 delete**: `DELETE FROM skills WHERE name = ?`
3. **R2 cleanup**: Delete all objects under `installed-skills/{name}/` prefix (paginated)

## Example

```
Admin: "Install the humanizer skill from ClawHub"

Bot calls: install_skill({ slug: "humanizer" })

1. GET https://clawhub.ai/api/v1/download?slug=humanizer -> 200 (zip)
2. unzipSync -> { "SKILL.md": ..., "humanize.sh": ..., "lib/utils.py": ... }
3. Validate: 3 files, SKILL.md found, total 45KB < 5MB
4. Parse: name="humanizer", description="Humanize AI text", requires={bins:["humanize-cli"]}
5. Not in BUILTIN_SKILLS -> OK
6. No OS restriction -> OK
7. R2: delete old, put installed-skills/humanizer/SKILL.md, .../humanize.sh, .../lib/utils.py
8. D1: INSERT INTO skills ... ON CONFLICT DO UPDATE
9. Deps: "humanize-cli" missing -> npm install -g humanize-cli -> OK

-> "Skill 'humanizer' installed successfully from ClawHub (3 files, 45KB)."
```

```
Admin: "Install skill from github.com/anthropics/skills/tree/main/skills/pdf"

Bot calls: install_skill({ github_url: "anthropics/skills/skills/pdf" })

1. Parse: owner=anthropics, repo=skills, path=skills/pdf
2. Contents API: list files recursively -> SKILL.md, process.py, requirements.txt
3. Size check: ~12KB total
4. Download all 3 files in parallel from raw URLs
5-9. Same validation, upload, metadata, deps install flow

-> "Skill 'pdf' installed successfully from GitHub (3 files, 12KB)."
```

## Key Code Path

- Tool definitions: `createSkillTools(deps: { db, sandbox, r2 })` in `skill.ts`
- ClawHub download: `fetch(CLAWHUB_API/download)` with `withRetry()` from `utils/retry.ts`
- Zip extraction: `unzipSync()` from `fflate`
- GitHub URL parsing: `parseGitHubUrl(input)` in `skill.ts` — handles full URLs, raw URLs, shorthand
- GitHub directory fetch: `fetchGitHubDirectoryFiles()` in `skill.ts` — recursive Contents API with depth limit
- Frontmatter parsing: `parseSkillFrontmatter(content)` in `loader.ts`
- OS check: `isLinuxCompatible(os)` in `install.ts`
- Dependency install: `findCompatibleSpecs()` + `executeInstallSpec()` in `install.ts`
- R2 cleanup: `deleteR2Prefix(r2, prefix)` in `skill.ts` — paginated delete
- D1 upsert: `INSERT INTO skills ... ON CONFLICT(name) DO UPDATE SET ...`
- Path safety: `isSafeRelativePath()` — rejects `..` and `.` components

## Edge Cases

- **ClawHub 404**: Returns `Failed to download skill "{slug}" from ClawHub: HTTP 404 Not Found`
- **ClawHub rate limit**: `Retry-After` header parsed; retried once after delay
- **GitHub directory > 5 levels deep**: Throws `Directory nesting too deep (max 5 levels)`
- **No SKILL.md in archive**: Returns `No SKILL.md found in zip for "{slug}"`
- **Invalid frontmatter (missing name or description)**: Returns parse failure message
- **Bundled name conflict**: Returns `Cannot install "{name}" -- conflicts with bundled skill`
- **Non-Linux OS restriction**: Returns `Cannot install "{name}" -- skill requires [os] but sandbox runs Linux`
- **Bundle > 5MB**: Rejected before upload with size limit error
- **Dependencies installed but some bins still missing**: Skill is stored (R2 + D1) but warning returned about missing binaries — skill may not work until dependencies are resolved
- **Re-install (same name)**: Old R2 files are cleaned up before new upload; D1 row updated via upsert
- **Path traversal in zip entries**: Entries with `..` or `.` components are silently skipped

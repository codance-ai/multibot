# UC-05: Dependency Management (npm / pip / download)

## Trigger

A skill declares `metadata.requires.bins` (binary dependencies) and `metadata.install` (installation instructions) in its SKILL.md frontmatter. Dependencies are installed in two contexts:
1. During `install_skill` / `register_skill` — immediate installation after skill is stored
2. During lazy hydration (`ensureSkillReady`) — on first use of an installed skill at runtime

## Expected Behavior

1. **Supported install kinds**: Only `node`, `pip`, `uv`, and `download` are supported in the sandbox environment. Other kinds (`brew`, `apt`, `go`) are recognized but not executable
2. **Compatible spec filtering**: `findCompatibleSpecs()` filters install specs to those that are both supported AND well-formed:
   - `node`: requires `package` field
   - `pip` / `uv`: requires `package` field (both use `pip3 install` — `uv` is accepted as an alias)
   - `download`: requires `url` and non-empty `bins` array
3. **Input validation** (security):
   - npm package: `/^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*(@[a-zA-Z0-9._-]+)?$/`
   - pip package: `/^[a-zA-Z0-9][a-zA-Z0-9._-]*(\[[a-zA-Z0-9,._-]+\])?$/` (max 128 chars)
   - download URL: must be `https:` protocol, no single quotes
   - bin name: `/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/` (max 64 chars)
4. **Installation commands**:
   - `node`: `npm install -g --prefix {homeLocal} '{package}'`
   - `pip`/`uv`: `pip3 install --no-cache-dir '{package}'` with `PYTHONUSERBASE={homeLocal} PIP_USER=1`
   - `download`: `curl -fsSL '{url}' -o '{depsDir}/{bin}' && chmod +x '{depsDir}/{bin}'`
5. **Timeout**: All install commands have a 30-second timeout via `timeout` command
6. **PATH setup**: `PATH={homeBin}:$PATH` ensures installed binaries are found by `which`
7. **Iterative verification**: After each install spec executes, remaining missing bins are re-checked. Installation stops early once all bins are found
8. **Error reporting**: Failed installs return `{ ok: false, message }` with stderr/stdout truncated to 500 chars

## Example

```
SKILL.md frontmatter:
---
name: pdf-reader
description: Read and extract text from PDFs
metadata:
  nanobot:
    requires:
      bins: [pdftotext, python3]
    install:
      - kind: download
        url: https://example.com/pdftotext-linux
        bins: [pdftotext]
      - kind: pip
        package: pdfplumber
---

Installation flow:
1. findCompatibleSpecs -> both specs are compatible (download + pip)
2. Check bins: python3 -> exists (pre-installed), pdftotext -> missing
3. Execute download spec: curl -fsSL 'https://example.com/pdftotext-linux' -o '/home/.local/bin/pdftotext' && chmod +x
4. Re-check: pdftotext -> now exists
5. All bins found -> stop (pip spec for pdfplumber not executed since no bin depends on it)
```

```
SKILL.md with unsupported kind only:
---
metadata:
  nanobot:
    requires:
      bins: [ffmpeg]
    install:
      - kind: brew
        formula: ffmpeg
---

Installation flow:
1. findCompatibleSpecs -> empty (brew not supported)
2. Check bins: ffmpeg -> missing
3. Error: "Missing binaries [ffmpeg] for skill 'video-editor': no compatible installer
   for this environment (found: brew)"
```

## Key Code Path

- Compatible spec filter: `findCompatibleSpecs(specs)` in `install.ts`
- Spec execution: `executeInstallSpec(sandbox, spec, sandboxBackend)` in `install.ts`
- Input validation: `validateNpmPackage()`, `validatePipPackage()`, `validateDownloadUrl()`, `validateBinName()` in `install.ts`
- Binary existence check: `binExists(sandbox, bin, sandboxBackend)` — runs `which '{bin}'` in sandbox with extended PATH
- Install environment: `getInstallEnv(backend)` — computes `depsDir`, `homeLocal`, `envPrefix` based on sandbox backend (sprites vs default)
- Sandbox paths: `getSandboxPaths(backend)` in `sandbox-types.ts` — sprites uses `/home/sprite/.local`, default uses `/home/.local`
- OS compatibility: `isLinuxCompatible(os)` — returns `true` if `os` is undefined/empty or includes `"linux"`
- Install spec parsing: `parseInstallSpecs(raw)` in `loader.ts` — accepts ALL kinds for accurate error reporting

## Edge Cases

- **Invalid npm package name (shell injection attempt)**: Rejected by `validateNpmPackage()` before any shell execution
- **Invalid download URL (non-https or contains single quote)**: Rejected by `validateDownloadUrl()`
- **Install timeout**: Command killed after 30 seconds — returns failure with truncated output
- **Multiple specs for same missing bin**: Tried sequentially until bin is found or all specs exhausted
- **uv kind**: Treated as pip alias — installed via `pip3 install` since `uv` binary is not available in sandbox
- **Pre-installed bins**: `python3`, `curl`, `git`, `gh`, `jq` are in `AVAILABLE_BINS` set — skills requiring only these are marked available without installation
- **Empty install array**: Skill has no install instructions but requires bins — error message reflects "no installation instructions provided"
- **Partial install success**: If some bins are installed but others remain missing after all specs are tried, error lists remaining missing bins with last error message
- **PATH precedence**: `{homeBin}` is prepended to PATH, so freshly installed binaries take precedence over system versions
- **Exec tool auto-hydration**: When `exec` command references `/installed-skills/{name}/`, `extractSkillNameFromCommand()` triggers `ensureSkillReady()` automatically before command execution — the skill's dependencies are installed as part of hydration

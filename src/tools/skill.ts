import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { unzipSync } from "fflate";
import type { SandboxClient } from "./sandbox-types";
import { parseSkillFrontmatter, type SkillMeta } from "../skills/loader";
import { isLinuxCompatible, findCompatibleSpecs, executeInstallSpec, binExists } from "../skills/install";
import { BUILTIN_SKILLS } from "../skills/builtin";
import { withRetry } from "../utils/retry";
import * as configDb from "../db/config";

const VALID_PATH_RE = /^\/(workspace\/skills|skills)\/[a-z0-9-]+$/;
const SAFE_SKILL_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;
const MAX_BUNDLE_SIZE = 5 * 1024 * 1024; // 5MB
const CLAWHUB_API = "https://clawhub.ai/api/v1";
const GITHUB_API = "https://api.github.com";
const USER_AGENT = "multibot/1.0 (Cloudflare Workers)";
const GITHUB_TIMEOUT_MS = 30_000;

/** Parse Retry-After header (seconds or HTTP-date) into milliseconds. */
function parseRetryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (!Number.isNaN(secs) && secs >= 0) return secs * 1000;
  const date = Date.parse(header);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

/** Create an error with status and optional retryAfterMs from a non-ok Response. */
function httpError(r: Response): Error {
  const err = new Error(`HTTP ${r.status} ${r.statusText}`);
  (err as any).status = r.status;
  const retryAfter = r.headers?.get?.("Retry-After") ?? null;
  const retryAfterMs = parseRetryAfterMs(retryAfter);
  if (retryAfterMs !== undefined) (err as any).retryAfterMs = retryAfterMs;
  return err;
}

export interface SkillToolsDeps {
  db: D1Database;
  sandbox: SandboxClient;
  botId: string;
  ownerId: string;
  getSandboxClient: (botId: string) => SandboxClient;
  githubToken?: string;
}

/** Add a skill name to a bot's enabledSkills if not already present. Best-effort. */
async function addToEnabledSkills(db: D1Database, ownerId: string, botId: string, skillName: string): Promise<void> {
  try {
    const bot = await configDb.getBot(db, ownerId, botId);
    if (!bot) return;
    if (bot.enabledSkills.includes(skillName)) return;
    bot.enabledSkills = [...bot.enabledSkills, skillName];
    await configDb.upsertBot(db, bot);
  } catch (e) {
    console.warn(`[skill] Failed to auto-enable skill "${skillName}" for bot ${botId}:`, e);
  }
}

/** Remove a skill name from a bot's enabledSkills. Best-effort. */
async function removeFromEnabledSkills(db: D1Database, ownerId: string, botId: string, skillName: string): Promise<void> {
  try {
    const bot = await configDb.getBot(db, ownerId, botId);
    if (!bot) return;
    if (!bot.enabledSkills.includes(skillName)) return;
    bot.enabledSkills = bot.enabledSkills.filter((s) => s !== skillName);
    await configDb.upsertBot(db, bot);
  } catch (e) {
    console.warn(`[skill] Failed to remove skill "${skillName}" from enabledSkills for bot ${botId}:`, e);
  }
}

// -- Shared helpers --

/** Parse + validate skill metadata: frontmatter, builtin conflict, OS compatibility. */
function validateSkillMeta(
  content: string,
  source: string,
  action: "register" | "install",
): { meta: SkillMeta } | { error: string } {
  const meta = parseSkillFrontmatter(content);
  if (!meta) {
    return { error: `Failed to parse SKILL.md frontmatter ${source}. Ensure it has valid name and description fields.` };
  }
  if (meta.name in BUILTIN_SKILLS) {
    return { error: `Cannot ${action} "${meta.name}" — conflicts with bundled skill. Choose a different name.` };
  }
  if (meta.metadata?.os && !isLinuxCompatible(meta.metadata.os)) {
    return { error: `Cannot ${action} "${meta.name}" — skill requires ${JSON.stringify(meta.metadata.os)} but sandbox runs Linux.` };
  }
  return { meta };
}

/** UPSERT skill metadata into D1. */
async function upsertSkillMetadata(
  db: D1Database,
  botId: string,
  meta: SkillMeta,
  fileCount: number,
): Promise<void> {
  const skillPath = `/installed-skills/${meta.name}/SKILL.md`;
  const emoji = meta.metadata?.emoji ?? null;
  const requiresEnvJson = JSON.stringify(meta.metadata?.requires?.env ?? []);
  await db
    .prepare(
      `INSERT INTO skills (bot_id, name, description, emoji, path, file_count, requires_env)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(bot_id, name) DO UPDATE SET
         description = ?, emoji = ?, path = ?, file_count = ?, requires_env = ?`,
    )
    .bind(
      botId, meta.name, meta.description, emoji, skillPath, fileCount, requiresEnvJson,
      meta.description, emoji, skillPath, fileCount, requiresEnvJson,
    )
    .run();
}

/**
 * Install skill dependencies on the target sandbox.
 * Returns error message string, or null on success.
 * @param isPreStore - true for register (fail before storing), false for install (warn after storing)
 */
async function installSkillDependencies(
  targetSandbox: SandboxClient,
  meta: SkillMeta,
  opts: { fileCount: number; isPreStore: boolean },
): Promise<string | null> {
  const requiredBins = meta.metadata?.requires?.bins;
  if (!requiredBins || requiredBins.length === 0) return null;

  let missingBins: string[] = [];
  for (const bin of requiredBins) {
    if (!(await binExists(targetSandbox, bin))) missingBins.push(bin);
  }
  if (missingBins.length === 0) return null;

  const installSpecs = meta.metadata?.install ?? [];
  const compatible = findCompatibleSpecs(installSpecs);

  if (compatible.length === 0) {
    const detail = installSpecs.length > 0
      ? `only has ${[...new Set(installSpecs.map((s) => s.kind))].join(", ")} install methods (supported: node, pip, uv, download)`
      : "no install method provided";
    if (opts.isPreStore) {
      return `Cannot register "${meta.name}" — requires ${missingBins.join(", ")} but ${detail}.`;
    }
    return `Skill "${meta.name}" installed (${opts.fileCount} files) but requires ${missingBins.join(", ")} — ${detail}. It may not work until dependencies are resolved.`;
  }

  let lastError = "";
  for (const spec of compatible) {
    const result = await executeInstallSpec(targetSandbox, spec);
    if (!result.ok) lastError = result.message;
    const stillMissing: string[] = [];
    for (const bin of missingBins) {
      if (!(await binExists(targetSandbox, bin))) stillMissing.push(bin);
    }
    missingBins = stillMissing;
    if (missingBins.length === 0) break;
  }

  if (missingBins.length > 0) {
    if (opts.isPreStore) {
      return `Cannot register "${meta.name}" — binaries still missing after install: ${missingBins.join(", ")}. Last error: ${lastError}`;
    }
    return `Skill "${meta.name}" installed (${opts.fileCount} files) but binaries still missing: ${missingBins.join(", ")}. Last error: ${lastError}`;
  }

  return null;
}

// -- GitHub helpers --

/** GitHub owner/repo names: alphanumeric, hyphens, dots, underscores */
const GITHUB_NAME_RE = /^[a-zA-Z0-9._-]+$/;

interface GitHubRef {
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}

/** Validate that owner and repo match GitHub's naming rules. */
function isValidGitHubName(name: string): boolean {
  return GITHUB_NAME_RE.test(name) && name.length > 0 && name.length <= 100;
}

/** Parse GitHub URL or shorthand into owner/repo/path/ref. */
export function parseGitHubUrl(input: string): GitHubRef | null {
  input = input.replace(/\/+$/, "");

  // Full URL: https://github.com/owner/repo/tree/branch/path
  // or blob:  https://github.com/owner/repo/blob/branch/path/SKILL.md
  const urlMatch = input.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/(?:tree|blob)\/([^/]+)\/(.+)/,
  );
  if (urlMatch) {
    const [, owner, repo, ref, rawPath] = urlMatch;
    if (!isValidGitHubName(owner) || !isValidGitHubName(repo)) return null;
    let path = rawPath;
    if (path.endsWith("/SKILL.md") || path === "SKILL.md") {
      path = path.replace(/\/?SKILL\.md$/, "");
    }
    return { owner, repo, ref, path: path || "" };
  }

  // Raw URL: https://raw.githubusercontent.com/owner/repo/branch/path/SKILL.md
  const rawMatch = input.match(
    /^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)/,
  );
  if (rawMatch) {
    const [, owner, repo, ref, rawPath] = rawMatch;
    if (!isValidGitHubName(owner) || !isValidGitHubName(repo)) return null;
    let path = rawPath;
    if (path.endsWith("/SKILL.md") || path === "SKILL.md") {
      path = path.replace(/\/?SKILL\.md$/, "");
    }
    return { owner, repo, ref, path: path || "" };
  }

  // Short format: owner/repo/path (at least 3 segments)
  const parts = input.split("/");
  if (parts.length >= 3 && parts.every((p) => p.length > 0)) {
    const [owner, repo, ...rest] = parts;
    if (!isValidGitHubName(owner) || !isValidGitHubName(repo)) return null;
    return { owner, repo, path: rest.join("/") };
  }

  return null;
}

/**
 * Recursively fetch all files in a GitHub directory via Contents API.
 * Skips symlinks and submodules. Limits recursion depth to prevent abuse.
 * Uses retry + timeout for robustness.
 */
async function fetchGitHubDirectoryFiles(
  owner: string,
  repo: string,
  dirPath: string,
  headers: Record<string, string>,
  ref?: string,
  basePath?: string,
  depth: number = 0,
): Promise<Array<{ relativePath: string; downloadUrl: string; size: number }>> {
  if (depth > 5) throw new Error("Directory nesting too deep (max 5 levels).");

  const base = basePath ?? dirPath;
  const params = ref ? `?ref=${encodeURIComponent(ref)}` : "";
  const encodedPath = dirPath.split("/").map(encodeURIComponent).join("/");
  const url = `${GITHUB_API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${encodedPath}${params}`;

  const resp = await withRetry(async () => {
    const r = await fetch(url, {
      headers: { ...headers, Accept: "application/vnd.github.v3+json" },
      signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
    });
    if (!r.ok) throw httpError(r);
    return r;
  }, { maxAttempts: 2, baseDelayMs: 1000 });

  const items = (await resp.json()) as Array<{
    name: string;
    type: string;
    path: string;
    download_url: string | null;
    size: number;
  }>;

  const files: Array<{ relativePath: string; downloadUrl: string; size: number }> = [];
  for (const item of items) {
    if (item.type === "file" && item.download_url) {
      // For root-level paths (base=""), use item.path directly
      const relativePath = base ? item.path.slice(base.length + 1) : item.path;
      files.push({ relativePath, downloadUrl: item.download_url, size: item.size });
    } else if (item.type === "dir") {
      const subFiles = await fetchGitHubDirectoryFiles(owner, repo, item.path, headers, ref, base, depth + 1);
      files.push(...subFiles);
    }
    // Skip symlinks and submodules
  }
  return files;
}

async function listFilesRecursive(
  sandbox: SandboxClient,
  dir: string,
): Promise<string[]> {
  const quoted = dir.replace(/'/g, "'\\''");
  const result = await sandbox.exec(`find '${quoted}' -type f`);
  if (!result.success || !result.stdout.trim()) return [];
  return result.stdout.trim().split("\n").filter(Boolean);
}

/** Check that a relative path has no traversal components. */
function isSafeRelativePath(relativePath: string): boolean {
  const parts = relativePath.split("/");
  return parts.every((p) => p !== ".." && p !== "." && p.length > 0);
}

/**
 * Write file entries to a target sandbox at /installed-skills/{name}/...
 */
async function writeFilesToSandbox(
  targetSandbox: SandboxClient,
  storedName: string,
  fileEntries: Array<{ relativePath: string; content: string | Uint8Array }>,
): Promise<void> {
  const prefix = `/installed-skills/${storedName}`;
  // Clean up old files before writing (handles re-register with fewer files)
  try {
    await targetSandbox.exec(`rm -rf ${prefix}`);
  } catch (e) {
    console.warn(`[skill] Failed to clean old files at ${prefix}:`, e);
  }
  for (const entry of fileEntries) {
    const filePath = `${prefix}/${entry.relativePath}`;
    const parentDir = filePath.split("/").slice(0, -1).join("/");
    await targetSandbox.mkdir(parentDir, { recursive: true });
    if (typeof entry.content === "string") {
      await targetSandbox.writeFile(filePath, entry.content);
    } else {
      // Binary content — encode as base64 (chunk to avoid stack overflow)
      let binary = "";
      const bytes = entry.content;
      for (let i = 0; i < bytes.length; i += 8192) {
        binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
      }
      await targetSandbox.writeFile(filePath, btoa(binary), { encoding: "base64" });
    }
  }
}

/**
 * Create skill management tools: register, unregister, install, search.
 * register_skill reads from sandbox filesystem, writes to target bot's sandbox and D1.
 * unregister_skill deletes from D1 and target bot's sandbox.
 * install_skill downloads from ClawHub/GitHub and writes to target bot's sandbox and D1.
 */
export function createSkillTools(deps: SkillToolsDeps): ToolSet {
  const { db, sandbox, botId, ownerId, getSandboxClient, githubToken } = deps;

  const ghHeaders: Record<string, string> = {
    "User-Agent": USER_AGENT,
    ...(githubToken ? { Authorization: `token ${githubToken}` } : {}),
  };

  return {
    register_skill: tool({
      description:
        "Register a skill from the sandbox filesystem. Reads SKILL.md frontmatter, automatically installs any required dependencies, writes files to persistent storage, and registers metadata. Always call this after downloading a skill — it handles everything including dependency installation.",
      inputSchema: z.object({
        path: z
          .string()
          .describe(
            "Path to the skill directory (e.g. '/workspace/skills/my-skill'). Must contain a SKILL.md file.",
          ),
        bot_id: z
          .string()
          .optional()
          .describe("Target bot ID to install the skill for. Defaults to admin bot."),
      }),
      execute: async ({ path, bot_id }) => {
        const targetBotId = bot_id || botId;
        const targetSandbox = getSandboxClient(targetBotId);

        if (!VALID_PATH_RE.test(path)) {
          return `Invalid path "${path}". Must be /skills/<name> or /workspace/skills/<name>.`;
        }

        const skillMdPath = `${path}/SKILL.md`;
        const exists = await sandbox.exists(skillMdPath);
        if (!exists.exists) {
          return `SKILL.md not found at ${skillMdPath}. Install the skill first with clawhub.`;
        }

        const content = await sandbox.readFile(skillMdPath);
        const validation = validateSkillMeta(content, `at ${skillMdPath}`, "register");
        if ("error" in validation) return validation.error;
        const { meta } = validation;

        // Dependency installation before storing (fail fast)
        const depError = await installSkillDependencies(targetSandbox, meta, { fileCount: 0, isPreStore: true });
        if (depError) return depError;

        const files = await listFilesRecursive(sandbox, path);
        if (files.length === 0) {
          return `No files found in ${path}.`;
        }

        const fileEntries: Array<{ relativePath: string; content: string }> = [];
        let totalSize = 0;

        for (const filePath of files) {
          const relativePath = filePath.slice(path.length + 1);
          // Skip files with path traversal
          if (!isSafeRelativePath(relativePath)) continue;

          const fileContent = await sandbox.readFile(filePath);
          const bytes = new TextEncoder().encode(fileContent).length;
          totalSize += bytes;
          if (totalSize > MAX_BUNDLE_SIZE) {
            return `Skill bundle exceeds ${MAX_BUNDLE_SIZE / 1024 / 1024}MB size limit.`;
          }
          fileEntries.push({ relativePath, content: fileContent });
        }

        if (fileEntries.length === 0) {
          return `No valid files found in ${path}.`;
        }

        await writeFilesToSandbox(targetSandbox, meta.name, fileEntries);
        await upsertSkillMetadata(db, targetBotId, meta, fileEntries.length);
        await addToEnabledSkills(db, ownerId, targetBotId, meta.name);

        return `Skill "${meta.name}" registered successfully for bot ${targetBotId} (${fileEntries.length} files, ${Math.round(totalSize / 1024)}KB).`;
      },
    }),

    unregister_skill: tool({
      description:
        "Unregister an installed skill by name. Removes metadata from D1 and files from bot's sandbox. Bundled skills cannot be unregistered.",
      inputSchema: z.object({
        name: z.string().describe("The skill name to unregister"),
        bot_id: z
          .string()
          .optional()
          .describe("Target bot ID. Defaults to admin bot."),
      }),
      execute: async ({ name, bot_id }) => {
        const targetBotId = bot_id || botId;

        if (!SAFE_SKILL_NAME_RE.test(name)) {
          return `Invalid skill name "${name}". Must be lowercase alphanumeric with hyphens.`;
        }

        if (name in BUILTIN_SKILLS) {
          return `Cannot unregister bundled skill "${name}". Only installed skills can be unregistered.`;
        }

        try {
          const result = await db
            .prepare("DELETE FROM skills WHERE bot_id = ? AND name = ?")
            .bind(targetBotId, name)
            .run();

          if (result.meta.changes === 0) {
            return `Skill "${name}" not found in registry for bot ${targetBotId}. (Bundled skills cannot be unregistered.)`;
          }

          // Remove from enabledSkills
          await removeFromEnabledSkills(db, ownerId, targetBotId, name);

          // Clean up files from target bot's sandbox
          const targetSandbox = getSandboxClient(targetBotId);
          try {
            await targetSandbox.exec(`rm -rf /installed-skills/${name}`);
          } catch (err) {
            console.warn(`[skill] Failed to clean up sandbox for skill "${name}":`, err);
          }

          return `Skill "${name}" unregistered from bot ${targetBotId}.`;
        } catch (err) {
          return `Failed to unregister skill: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    install_skill: tool({
      description:
        "Install a skill from ClawHub (by slug) or GitHub (by URL/path). Downloads files, validates, and stores to bot's sandbox and D1. Handles dependency installation automatically if required.",
      inputSchema: z.object({
        slug: z.string().optional().describe("ClawHub skill slug (e.g. 'humanizer'). Required unless github_url is provided."),
        github_url: z.string().optional().describe("GitHub skill location: 'owner/repo/path' (e.g. 'anthropics/skills/skills/pdf') or full GitHub URL. Alternative to slug."),
        bot_id: z
          .string()
          .optional()
          .describe("Target bot ID to install the skill for. Defaults to admin bot."),
      }),
      execute: async ({ slug, github_url, bot_id }) => {
        if (!slug && !github_url) {
          return "Either slug or github_url must be provided.";
        }

        const targetBotId = bot_id || botId;
        const targetSandbox = getSandboxClient(targetBotId);

        // -- GitHub install flow --
        if (github_url) {
          const ghRef = parseGitHubUrl(github_url);
          if (!ghRef) {
            return `Invalid github_url "${github_url}". Use 'owner/repo/path' (e.g. 'anthropics/skills/skills/pdf') or a full GitHub URL.`;
          }

          try {
            // 1. List directory files via Contents API (with retry + timeout)
            const dirFiles = await fetchGitHubDirectoryFiles(
              ghRef.owner, ghRef.repo, ghRef.path, ghHeaders, ghRef.ref,
            );
            if (dirFiles.length === 0) {
              return `No files found at ${github_url}.`;
            }

            // 2. Check estimated size before downloading
            const estimatedSize = dirFiles.reduce((sum, f) => sum + f.size, 0);
            if (estimatedSize > MAX_BUNDLE_SIZE) {
              return `Skill at ${github_url} is too large (~${Math.round(estimatedSize / 1024 / 1024)}MB). Max ${MAX_BUNDLE_SIZE / 1024 / 1024}MB.`;
            }

            // 3. Download all files in parallel with timeout
            const downloads = await Promise.all(
              dirFiles.map(async (f) => {
                if (!isSafeRelativePath(f.relativePath)) return null;
                const resp = await fetch(f.downloadUrl, {
                  headers: ghHeaders,
                  signal: AbortSignal.timeout(GITHUB_TIMEOUT_MS),
                });
                if (!resp.ok) throw new Error(`Failed to download ${f.relativePath}: HTTP ${resp.status}`);
                const data = new Uint8Array(await resp.arrayBuffer());
                return { relativePath: f.relativePath, content: data };
              }),
            );
            const fileEntries = downloads.filter((d): d is NonNullable<typeof d> => d !== null);

            // 4. Find and validate SKILL.md
            const skillMdEntry = fileEntries.find((f) => f.relativePath === "SKILL.md");
            if (!skillMdEntry) {
              return `No SKILL.md found in ${github_url}.`;
            }
            const skillMdContent = new TextDecoder().decode(skillMdEntry.content);
            const totalSize = fileEntries.reduce((sum, f) => sum + f.content.length, 0);
            if (totalSize > MAX_BUNDLE_SIZE) {
              return `Skill bundle exceeds ${MAX_BUNDLE_SIZE / 1024 / 1024}MB size limit.`;
            }

            // 5. Parse and validate frontmatter
            const validation = validateSkillMeta(skillMdContent, `at ${github_url}`, "install");
            if ("error" in validation) return validation.error;
            const { meta } = validation;

            // 6. Write files to target sandbox + D1 metadata
            try {
              await writeFilesToSandbox(targetSandbox, meta.name, fileEntries);
              await upsertSkillMetadata(db, targetBotId, meta, fileEntries.length);
            } catch (err) {
              return `Failed to store skill "${meta.name}": ${err instanceof Error ? err.message : String(err)}`;
            }

            await addToEnabledSkills(db, ownerId, targetBotId, meta.name);

            // 7. Dependency installation (post-store)
            const depError = await installSkillDependencies(targetSandbox, meta, { fileCount: fileEntries.length, isPreStore: false });
            if (depError) return depError;

            return `Skill "${meta.name}" installed successfully from GitHub for bot ${targetBotId} (${fileEntries.length} files, ${Math.round(totalSize / 1024)}KB).`;
          } catch (err) {
            return `Failed to install from GitHub: ${err instanceof Error ? err.message : String(err)}`;
          }
        }

        // -- ClawHub install flow --
        // 1. Download zip from ClawHub
        let zipData: ArrayBuffer;
        try {
          const resp = await withRetry(async () => {
            const r = await fetch(`${CLAWHUB_API}/download?slug=${encodeURIComponent(slug!)}`, {
              headers: { Accept: "application/zip", "User-Agent": USER_AGENT },
              signal: AbortSignal.timeout(30_000),
            });
            if (!r.ok) throw httpError(r);
            return r;
          }, { maxAttempts: 2, baseDelayMs: 1000 });
          const contentLength = parseInt(resp.headers.get("Content-Length") ?? "0", 10);
          if (contentLength > MAX_BUNDLE_SIZE) {
            return `Skill zip for "${slug}" is too large (${Math.round(contentLength / 1024 / 1024)}MB). Max ${MAX_BUNDLE_SIZE / 1024 / 1024}MB.`;
          }
          zipData = await resp.arrayBuffer();
        } catch (err) {
          return `Failed to download skill "${slug}" from ClawHub: ${err instanceof Error ? err.message : String(err)}`;
        }

        // 2. Decompress zip in Worker
        let entries: Record<string, Uint8Array>;
        try {
          entries = unzipSync(new Uint8Array(zipData));
        } catch (err) {
          return `Failed to extract zip for "${slug}": ${err instanceof Error ? err.message : String(err)}`;
        }

        // 3. Validate files: path safety, find SKILL.md
        const fileEntries: Array<{ relativePath: string; content: Uint8Array }> = [];
        let skillMdContent: string | null = null;
        let totalSize = 0;

        for (const [name, data] of Object.entries(entries)) {
          // Skip directories (fflate includes them with zero-length data ending in /)
          if (name.endsWith("/")) continue;

          if (!isSafeRelativePath(name)) continue;

          totalSize += data.length;
          if (totalSize > MAX_BUNDLE_SIZE) {
            return `Skill bundle exceeds ${MAX_BUNDLE_SIZE / 1024 / 1024}MB size limit.`;
          }

          fileEntries.push({ relativePath: name, content: data });

          if (name === "SKILL.md") {
            skillMdContent = new TextDecoder().decode(data);
          }
        }

        if (!skillMdContent) {
          return `No SKILL.md found in zip for "${slug}".`;
        }

        // 4. Parse and validate frontmatter
        const validation = validateSkillMeta(skillMdContent, `for "${slug}"`, "install");
        if ("error" in validation) return validation.error;
        const { meta } = validation;

        // 5. Write to target sandbox + D1 metadata
        try {
          await writeFilesToSandbox(targetSandbox, meta.name, fileEntries);
          await upsertSkillMetadata(db, targetBotId, meta, fileEntries.length);
        } catch (err) {
          return `Failed to store skill "${meta.name}": ${err instanceof Error ? err.message : String(err)}`;
        }

        await addToEnabledSkills(db, ownerId, targetBotId, meta.name);

        // 6. Dependency installation (post-store)
        const depError = await installSkillDependencies(targetSandbox, meta, { fileCount: fileEntries.length, isPreStore: false });
        if (depError) return depError;

        return `Skill "${meta.name}" installed successfully from ClawHub for bot ${targetBotId} (${fileEntries.length} files, ${Math.round(totalSize / 1024)}KB).`;
      },
    }),

    search_skills: tool({
      description:
        "Search for skills on ClawHub. Returns matching skills with metadata.",
      inputSchema: z.object({
        query: z.string().describe("Natural language search query (e.g. 'web scraping', 'image generation')"),
        limit: z.number().optional().default(5).describe("Maximum number of results (default: 5)"),
      }),
      execute: async ({ query, limit }) => {
        try {
          const url = `${CLAWHUB_API}/search?q=${encodeURIComponent(query)}&limit=${limit}`;
          const resp = await withRetry(async () => {
            const r = await fetch(url, {
              headers: { Accept: "application/json", "User-Agent": USER_AGENT },
              signal: AbortSignal.timeout(10_000),
            });
            if (!r.ok) throw httpError(r);
            return r;
          }, { maxAttempts: 2, baseDelayMs: 1000 });
          const data = await resp.json() as { results?: Array<{ slug: string; displayName: string; summary: string; score: number }> };
          if (!data.results || data.results.length === 0) {
            return `No skills found for "${query}".`;
          }
          return JSON.stringify(
            data.results.map((r) => ({
              slug: r.slug,
              name: r.displayName,
              description: r.summary,
              score: r.score,
            })),
            null,
            2,
          );
        } catch (err) {
          return `Failed to search skills: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}

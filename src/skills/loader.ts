import YAML from "yaml";
import { BUILTIN_SKILLS, BUNDLED_SKILL_META, type BundledSkillMeta } from "./builtin";
export { resolveMetadataNamespace } from "./metadata";
import { resolveMetadataNamespace } from "./metadata";

export interface SkillInstallSpec {
  id?: string;
  kind: string;        // "node" | "download" | "brew" | "go" | "uv" | "apt" | etc.
  label?: string;
  bins?: string[];
  formula?: string;   // brew
  package?: string;    // node / uv
  module?: string;     // go
  url?: string;        // download
}

export interface SkillMeta {
  name: string;
  description: string;
  homepage?: string;
  metadata?: {
    emoji?: string;
    requires?: { bins?: string[]; env?: string[] };
    install?: SkillInstallSpec[];
    os?: string[];
  };
}

/**
 * Bins available in the sandbox (Sprites) or with multibot-native replacements.
 * - curl, git, jq, python3, gh: pre-installed in Sprites image
 * - curl also has a native web_fetch fallback
 */
const AVAILABLE_BINS = new Set(["curl", "git", "gh", "jq", "python3"]);

/** Parse install specs from metadata install array.
 * Accepts ALL kinds — filtering to supported kinds happens in findCompatibleSpecs.
 * This preserves unsupported kinds (apt, brew, etc.) for accurate error reporting. */
function parseInstallSpecs(raw: unknown): SkillInstallSpec[] {
  if (!Array.isArray(raw)) return [];
  const specs: SkillInstallSpec[] = [];

  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const kind = typeof e.kind === "string" ? e.kind.trim().toLowerCase() : "";
    if (!kind) continue;

    const spec: SkillInstallSpec = { kind };
    if (typeof e.id === "string") spec.id = e.id;
    if (typeof e.label === "string") spec.label = e.label;
    if (Array.isArray(e.bins)) spec.bins = e.bins.filter((b): b is string => typeof b === "string");
    if (typeof e.formula === "string") spec.formula = e.formula;
    if (typeof e.package === "string") spec.package = e.package;
    if (typeof e.module === "string") spec.module = e.module;
    if (typeof e.url === "string") spec.url = e.url;

    specs.push(spec);
  }

  return specs;
}

/**
 * Parse YAML frontmatter from a SKILL.md string.
 * Uses the `yaml` library for robust parsing (handles flow mapping, block scalars, etc.).
 */
export function parseSkillFrontmatter(content: string): SkillMeta | null {
  if (!content.startsWith("---")) return null;

  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) return null;

  const yamlString = content.slice(4, endIdx).trim();

  let parsed: Record<string, unknown>;
  try {
    parsed = YAML.parse(yamlString);
  } catch (e) {
    console.warn("[skill] YAML parse failed:", e);
    return null;
  }

  if (!parsed || typeof parsed !== "object") return null;

  const name = typeof parsed.name === "string" ? parsed.name : "";
  const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
  if (!name || !description) return null;
  // Skill name must be safe for filesystem paths and shell commands
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return null;

  const meta: SkillMeta = { name, description };

  if (typeof parsed.homepage === "string") meta.homepage = parsed.homepage;

  if (parsed.metadata && typeof parsed.metadata === "object") {
    try {
      const ns = resolveMetadataNamespace(parsed.metadata as Record<string, unknown>);
      meta.metadata = {
        emoji: typeof ns.emoji === "string" ? ns.emoji : undefined,
        requires: ns.requires && typeof ns.requires === "object"
          ? {
              bins: Array.isArray((ns.requires as any).bins)
                ? (ns.requires as any).bins.filter((v: unknown): v is string => typeof v === "string")
                : undefined,
              env: Array.isArray((ns.requires as any).env)
                ? (ns.requires as any).env.filter((v: unknown): v is string => typeof v === "string")
                : undefined,
            }
          : undefined,
        install: parseInstallSpecs(ns.install),
        os: Array.isArray(ns.os) ? ns.os.filter((v): v is string => typeof v === "string") : undefined,
      };
      // Clean up empty arrays
      if (meta.metadata.install?.length === 0) meta.metadata.install = undefined;
      if (meta.metadata.os?.length === 0) meta.metadata.os = undefined;
    } catch (e) {
      console.warn("[skill] Invalid metadata:", e);
    }
  }

  return meta;
}

/**
 * Strip YAML frontmatter from SKILL.md content, returning only the body.
 */
export function stripFrontmatter(content: string): string {
  if (!content.startsWith("---")) return content;
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) return content;
  return content.slice(endIdx + 4).trim();
}

/**
 * Check if a skill is available in the current Workers environment.
 * Skills with no `requires.bins` are always available.
 * Skills requiring bins are available only if all bins are in AVAILABLE_BINS.
 */
function isSkillAvailable(meta: SkillMeta): boolean {
  const bins = meta.metadata?.requires?.bins;
  if (!bins || bins.length === 0) return true;
  return bins.every((bin) => AVAILABLE_BINS.has(bin));
}

/**
 * List all builtin skills with metadata and availability.
 */
export function listSkills(): Array<{
  name: string;
  meta: SkillMeta;
  available: boolean;
}> {
  const result: Array<{ name: string; meta: SkillMeta; available: boolean }> =
    [];

  for (const [name, content] of Object.entries(BUILTIN_SKILLS)) {
    const meta = parseSkillFrontmatter(content);
    if (!meta) continue;
    result.push({
      name,
      meta,
      available: isSkillAvailable(meta),
    });
  }

  return result;
}

/**
 * Load the raw SKILL.md content for a skill by name.
 * Returns null if not found.
 */
export function loadSkillContent(name: string): string | null {
  return BUILTIN_SKILLS[name] ?? null;
}

/**
 * Load multiple skills and format for system prompt injection.
 * Format: ### Skill: {name}\n\n{body} separated by ---
 * Matches nanobot's load_skills_for_context.
 */
export function loadSkillsForContext(names: string[]): string {
  const parts: string[] = [];

  for (const name of names) {
    const content = BUILTIN_SKILLS[name];
    if (!content) continue;
    const body = stripFrontmatter(content);
    parts.push(`### Skill: ${name}\n\n${body}`);
  }

  return parts.join("\n\n---\n\n");
}

/**
 * Build XML skills summary for system prompt.
 * Matches nanobot's build_skills_summary.
 * Unavailable skills marked with available="false" and <requires> tag.
 */
export function buildSkillsSummary(): string {
  const skills = listSkills();
  return buildSkillsSummaryFromList(skills);
}

// ──────────────────────────────────────────────────────────
// Shared helper
// ──────────────────────────────────────────────────────────

function buildSkillsSummaryFromList(
  skills: Array<{ name: string; meta: SkillMeta; available: boolean }>,
  enabledSkills?: string[],
): string {
  const lines: string[] = ["<skills>"];

  for (const { name, meta, available } of skills) {
    // If enabledSkills is provided, only include skills in the list
    if (enabledSkills && !enabledSkills.includes(name)) continue;

    const emoji = meta.metadata?.emoji ? ` ${meta.metadata.emoji}` : "";

    if (available) {
      lines.push(`  <skill available="true">`);
      lines.push(`    <name>${name}${emoji}</name>`);
      lines.push(`    <description>${meta.description}</description>`);
      lines.push(`  </skill>`);
    } else {
      const missingBins =
        meta.metadata?.requires?.bins?.filter((b) => !AVAILABLE_BINS.has(b)) ??
        [];
      lines.push(`  <skill available="false">`);
      lines.push(`    <name>${name}${emoji}</name>`);
      lines.push(`    <description>${meta.description}</description>`);
      lines.push(`    <requires>${missingBins.join(", ")}</requires>`);
      lines.push(`  </skill>`);
    }
  }

  lines.push("</skills>");
  return lines.join("\n");
}

// ──────────────────────────────────────────────────────────
// D1-based skill discovery (new architecture)
// ──────────────────────────────────────────────────────────

/** Unified skill entry for system prompt building. */
export interface SkillEntry {
  name: string;
  description: string;
  emoji?: string;
  path: string;
  source: "bundled" | "installed";
  adminOnly?: boolean;
  available: boolean;
  requiresEnv?: string[];
}

/** Check availability for a bundled skill. */
function isBundledSkillAvailable(meta: BundledSkillMeta): boolean {
  const bins = meta.requires?.bins;
  if (!bins || bins.length === 0) return true;
  return bins.every((bin) => AVAILABLE_BINS.has(bin));
}

/**
 * List all skills: bundled (from hardcoded metadata) + installed (from D1).
 * Installed skills cannot shadow bundled skills (same-name installed skills are skipped).
 * When enabledSkills is provided, ALL skills (bundled + installed) are filtered uniformly.
 * When botId is provided, only installed skills for that bot are returned.
 */
export async function listAllSkills(
  db: D1Database,
  botId?: string,
  enabledSkills?: string[],
  isAdmin?: boolean,
): Promise<SkillEntry[]> {
  // 1. Bundled skills
  const map = new Map<string, SkillEntry>();
  for (const meta of BUNDLED_SKILL_META) {
    map.set(meta.name, {
      name: meta.name,
      description: meta.description,
      emoji: meta.emoji,
      path: meta.path,
      source: "bundled",
      adminOnly: meta.adminOnly,
      available: isBundledSkillAvailable(meta),
    });
  }

  // 2. Installed skills from D1 (graceful fallback if D1 unavailable)
  try {
    const query = botId
      ? db.prepare("SELECT name, description, emoji, path, requires_env FROM skills WHERE bot_id = ?").bind(botId)
      : db.prepare("SELECT name, description, emoji, path, requires_env FROM skills");
    const { results } = await query
      .all<{ name: string; description: string; emoji: string | null; path: string; requires_env: string | null }>();
    for (const row of results) {
      // Skip malformed rows (e.g. from mock D1 returning wrong shape)
      if (!row.name || !row.description) continue;
      // Installed skills cannot shadow bundled skills
      if (map.has(row.name)) continue;
      let requiresEnv: string[] | undefined;
      if (row.requires_env) {
        try {
          const parsed = JSON.parse(row.requires_env);
          if (Array.isArray(parsed) && parsed.length > 0) {
            requiresEnv = parsed.filter((v: unknown): v is string => typeof v === "string");
          }
        } catch (e) { console.warn("[skill] Invalid requires_env JSON:", e); }
      }
      map.set(row.name, {
        name: row.name,
        description: row.description,
        emoji: row.emoji ?? undefined,
        path: row.path,
        source: "installed",
        available: true,
        requiresEnv,
      });
    }
  } catch (e) {
    console.warn("[skill] D1 skill list failed:", e);
  }

  // 3. Filter by enabledSkills (unified for bundled + installed)
  // - adminOnly bundled skills are always visible to admin bots
  let entries = Array.from(map.values());
  if (enabledSkills) {
    entries = entries.filter(
      (s) =>
        enabledSkills.includes(s.name) ||
        (isAdmin && s.adminOnly),
    );
  }

  return entries;
}

/**
 * Build XML skills summary using D1-based discovery.
 * Bot uses load_skill(name) to load skill content on demand.
 */
export async function buildSkillsSummaryWithD1(
  db: D1Database,
  botId?: string,
  enabledSkills?: string[],
  isAdmin?: boolean,
  perSkillSecrets?: Record<string, Record<string, string>>,
): Promise<string> {
  const skills = await listAllSkills(db, botId, enabledSkills, isAdmin);
  return buildSkillsSummaryXml(skills, perSkillSecrets);
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Build XML summary from SkillEntry list.
 *  perSkillSecrets maps skill name → { ENV_KEY: value } for configured secrets.
 *  Env tags are emitted for both declared requiresEnv AND actually-configured secret keys. */
export function buildSkillsSummaryXml(
  skills: SkillEntry[],
  perSkillSecrets?: Record<string, Record<string, string>>,
): string {
  const lines: string[] = ["<skills>"];

  for (const skill of skills) {
    const emoji = skill.emoji ? ` ${escapeXml(skill.emoji)}` : "";
    const desc = escapeXml(skill.description);
    lines.push(`  <skill name="${escapeXml(skill.name)}" available="${skill.available}">`);
    lines.push(`    <description>${desc}${emoji}</description>`);
    // Merge declared env vars with actually-configured secret keys
    const declaredEnv = skill.requiresEnv ?? [];
    const configuredKeys = perSkillSecrets?.[skill.name] ? Object.keys(perSkillSecrets[skill.name]) : [];
    const allEnvKeys = [...new Set([...declaredEnv, ...configuredKeys])];
    for (const envKey of allEnvKeys) {
      const configured = perSkillSecrets?.[skill.name] ? envKey in perSkillSecrets[skill.name] : false;
      lines.push(`    <env name="${escapeXml(envKey)}" configured="${configured}"/>`);
    }
    lines.push(`  </skill>`);
  }

  lines.push("</skills>");
  return lines.join("\n");
}

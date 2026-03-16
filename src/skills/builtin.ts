/**
 * Builtin skills: single source of truth is each skill's SKILL.md.
 * Content is imported at build time; metadata is extracted from frontmatter.
 */

import { resolveMetadataNamespace } from "./metadata";
import weather from "../../skills/weather/SKILL.md";
import github from "../../skills/github/SKILL.md";
import image from "../../skills/image/SKILL.md";
import selfie from "../../skills/selfie/SKILL.md";
import systemReference from "../../skills/system-reference/SKILL.md";
import genPy from "../../skills/image/scripts/gen.py";

/** Full SKILL.md content — used for system prompt injection and skill loading. */
export const BUILTIN_SKILLS: Record<string, string> = {
  weather,
  github,
  image,
  selfie,
  "system-reference": systemReference,
};

/** Builtin skill scripts that need materialization to sandbox.
 *  Key = sandbox path, Value = file content. */
export const BUILTIN_SKILL_ASSETS: Record<string, string> = {
  "/skills/image/scripts/gen.py": genPy,
};

/** Metadata for bundled skills — auto-extracted from SKILL.md frontmatter. */
export interface BundledSkillMeta {
  name: string;
  description: string;
  emoji?: string;
  path: string;
  adminOnly?: boolean;
  requires?: { bins?: string[] };
}

// Hardcoded overrides not expressible in frontmatter
const ADMIN_ONLY_SKILLS = new Set<string>(["system-reference"]);

/**
 * Parse frontmatter from SKILL.md to extract metadata.
 * Simple line-by-line parser — no YAML library needed.
 */
function extractMeta(name: string, content: string): BundledSkillMeta | null {
  if (!content.startsWith("---")) return null;
  const endIdx = content.indexOf("\n---", 3);
  if (endIdx === -1) return null;

  const yaml = content.slice(4, endIdx).trim();
  const result: Record<string, string> = {};
  for (const line of yaml.split("\n")) {
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }

  if (!result.description) return null;

  const meta: BundledSkillMeta = {
    name,
    description: result.description,
    path: `/skills/${name}/SKILL.md`,
  };

  if (ADMIN_ONLY_SKILLS.has(name)) meta.adminOnly = true;

  // Parse metadata JSON for emoji and requires
  if (result.metadata) {
    try {
      const parsed = JSON.parse(result.metadata);
      const ns = resolveMetadataNamespace(parsed);
      if (typeof ns.emoji === "string") meta.emoji = ns.emoji;
      if (ns.requires && typeof ns.requires === "object") meta.requires = ns.requires as { bins?: string[] };
    } catch (e) {
      console.warn("[skill] Invalid metadata JSON in builtin skill:", name, e);
    }
  }

  return meta;
}

/** Auto-generated metadata from SKILL.md frontmatter. */
export const BUNDLED_SKILL_META: BundledSkillMeta[] = Object.entries(BUILTIN_SKILLS)
  .map(([name, content]) => extractMeta(name, content))
  .filter((m): m is BundledSkillMeta => m !== null);

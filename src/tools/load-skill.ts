/**
 * load_skill tool: loads a skill's instructions by name.
 * Routes to the correct storage backend transparently:
 *   - Builtin skills -> in-memory BUILTIN_SKILLS
 *   - Installed skills -> sandbox filesystem (with lazy hydration)
 *
 * Replaces the previous approach where read_file had to know about skill paths.
 */

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { EnsureSkillReady } from "../skills/ensure-ready";
import type { SandboxClient } from "./sandbox-types";

export function createLoadSkillTool(
  builtinSkills: Record<string, string>,
  sandboxClient?: SandboxClient,
  ensureSkillReady?: EnsureSkillReady,
): ToolSet {
  return {
    load_skill: tool({
      description:
        "Load a skill's instructions by name. Call this before following any skill listed in <skills>.",
      inputSchema: z.object({
        name: z.string().describe("The skill name from the <skills> list"),
      }),
      execute: async ({ name }) => {
        // 1. Builtin skills (bundled at build time)
        if (builtinSkills[name]) {
          return builtinSkills[name];
        }

        // 2. Installed skills (sandbox filesystem with lazy hydration)
        if (sandboxClient) {
          if (ensureSkillReady) {
            try {
              await ensureSkillReady(name);
            } catch (err) {
              return `Error: Skill "${name}" is not available: ${err instanceof Error ? err.message : String(err)}`;
            }
          }
          try {
            const content = await sandboxClient.readFile(`/installed-skills/${name}/SKILL.md`);
            return content;
          } catch {
            // Not found on sandbox
          }
        }

        return `Error: Skill "${name}" not found.`;
      },
    }),
  };
}

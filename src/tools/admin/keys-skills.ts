/**
 * API keys + skills management tools.
 */

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { UserKeys } from "../../config/schema";
import * as configDb from "../../db/config";
import { listAllSkills } from "../../skills/loader";
import { BUILTIN_SKILLS } from "../../skills/builtin";
import type { AdminToolDeps } from "./utils";
import { validateSkillNames } from "./utils";

export function createKeysAndSkillTools(deps: AdminToolDeps): ToolSet {
  const { db, env, ownerId } = deps;

  return {
    get_keys: tool({
      description:
        "Get the current API keys. Values are masked for security (last 4 chars only).",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const keys = await configDb.getUserKeys(db, ownerId);
          if (!keys) return "No API keys configured.";

          const masked: Record<string, string> = {};
          for (const [k, v] of Object.entries(keys)) {
            if (v) {
              masked[k] = v.length > 4 ? `****${v.slice(-4)}` : "****";
            }
          }
          if (Object.keys(masked).length === 0)
            return "No API keys configured.";
          return Object.entries(masked)
            .map(([k, v]) => `- **${k}**: ${v}`)
            .join("\n");
        } catch (err) {
          return `Failed to get keys: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    update_keys: tool({
      description:
        "Update API keys. Set a key to a string value to add/change it. Set to null to remove it.",
      inputSchema: z.object({
        openai: z.string().nullable().optional(),
        anthropic: z.string().nullable().optional(),
        google: z.string().nullable().optional(),
        deepseek: z.string().nullable().optional(),
        moonshot: z.string().nullable().optional(),
        brave: z.string().nullable().optional(),
        xai: z.string().nullable().optional(),
      }),
      execute: async (input) => {
        try {
          const existing = (await configDb.getUserKeys(db, ownerId)) ?? {};
          const merged: UserKeys = { ...existing };

          for (const [k, v] of Object.entries(input)) {
            if (v === undefined) continue;
            if (v === null) {
              delete (merged as Record<string, string | undefined>)[k];
            } else {
              (merged as Record<string, string | undefined>)[k] = v;
            }
          }

          await configDb.upsertUserKeys(db, ownerId, merged);

          const updated = Object.entries(input)
            .filter(([, v]) => v !== undefined)
            .map(([k, v]) => (v === null ? `${k}: removed` : `${k}: set`));
          return `Keys updated:\n${updated.map((l) => `- ${l}`).join("\n")}`;
        } catch (err) {
          return `Failed to update keys: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    list_skills: tool({
      description:
        "List all available skills (bundled + installed).",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const skills = await listAllSkills(db);
          if (skills.length === 0) return "No skills found.";
          const lines = skills.map(
            (s) =>
              `- ${s.emoji ? s.emoji + " " : ""}**${s.name}** — ${s.description} [${s.source}${!s.available ? ", unavailable" : ""}]`,
          );
          return lines.join("\n");
        } catch (err) {
          return `Failed to list skills: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    delete_skill: tool({
      description:
        "Delete an installed (non-bundled) skill. Bundled skills cannot be deleted.",
      inputSchema: z.object({
        name: z.string().describe("The skill name to delete"),
        bot_id: z.string().optional().describe("Target bot ID. If not provided, deletes skill across all bots."),
      }),
      execute: async ({ name, bot_id }) => {
        try {
          if (name in BUILTIN_SKILLS) {
            return `Cannot delete bundled skill "${name}". Only installed skills can be deleted.`;
          }

          // Find affected bots before deleting (to clean up enabledSkills)
          let affectedBotIds: string[] = [];
          try {
            const query = bot_id
              ? db.prepare("SELECT bot_id FROM skills WHERE bot_id = ? AND name = ?").bind(bot_id, name)
              : db.prepare("SELECT bot_id FROM skills WHERE name = ?").bind(name);
            const { results } = await query.all<{ bot_id: string }>();
            affectedBotIds = results.map((r) => r.bot_id);
          } catch (e) {
            console.warn("[admin] Failed to query affected bots:", e);
          }

          const result = bot_id
            ? await db
                .prepare("DELETE FROM skills WHERE bot_id = ? AND name = ?")
                .bind(bot_id, name)
                .run()
            : await db
                .prepare("DELETE FROM skills WHERE name = ?")
                .bind(name)
                .run();

          if (result.meta.changes === 0) {
            return `Skill "${name}" not found.`;
          }

          // Remove from enabledSkills for affected bots
          for (const affectedBotId of affectedBotIds) {
            const bot = await configDb.getBot(db, ownerId, affectedBotId);
            if (bot && bot.enabledSkills.includes(name)) {
              bot.enabledSkills = bot.enabledSkills.filter((s) => s !== name);
              await configDb.upsertBot(db, bot);
            }
          }

          return `Skill "${name}" deleted (${result.meta.changes} instance(s) removed).`;
        } catch (err) {
          return `Failed to delete skill: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    set_skill_secret: tool({
      description:
        "Set an environment variable (API key / secret) for an installed skill. " +
        "The secret will be automatically available as an env var in exec commands for all bots with this skill enabled.",
      inputSchema: z.object({
        skill_name: z.string().describe("The skill name (e.g. 'notion')"),
        env_key: z.string().describe("The environment variable name (e.g. 'NOTION_API_KEY')"),
        env_value: z.string().describe("The secret value"),
      }),
      execute: async ({ skill_name, env_key, env_value }) => {
        try {
          // Validate skill name exists
          const err = await validateSkillNames(db, [skill_name]);
          if (err) return err;

          // Read existing secrets for this skill, merge new key
          const existing = await configDb.getSkillSecrets(db, ownerId);
          const current = { ...(existing[skill_name] ?? {}), [env_key]: env_value };
          await configDb.upsertSkillSecret(db, ownerId, skill_name, current);
          return `Successfully set ${env_key} for skill "${skill_name}". The secret is now available as an environment variable in exec commands.`;
        } catch (err) {
          return `Failed to set skill secret: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}

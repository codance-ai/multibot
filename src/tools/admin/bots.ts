/**
 * Bot management tools: list, get, create, update, delete, restore, clone.
 */

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { BotConfig } from "../../config/schema";
import * as configDb from "../../db/config";
import { destroySprite } from "../sprites-sandbox";
import type { AdminToolDeps } from "./utils";
import {
  validateSkillNames,
  UPDATE_BOT_CLEAR_FIELDS,
  sanitizeUpdatesWithClearFields,
  applyUpdateBotClearField,
} from "./utils";
import type { UpdateBotClearField } from "./utils";

export function createBotTools(deps: AdminToolDeps): ToolSet {
  const { db, env, ownerId } = deps;

  return {
    list_bots: tool({
      description: "List all bots for the current owner.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const bots = await configDb.listBots(db, ownerId);
          if (bots.length === 0) return "No bots found.";
          const lines = bots.map(
            (b) =>
              `- **${b.name}** (\`${b.botId}\`) — ${b.provider}/${b.model}, type: ${b.botType}`,
          );
          return lines.join("\n");
        } catch (err) {
          return `Failed to list bots: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    get_bot: tool({
      description: "Get full details of a bot by ID.",
      inputSchema: z.object({
        botId: z.string().describe("The bot ID to look up"),
      }),
      execute: async ({ botId }) => {
        try {
          const bot = await configDb.getBot(db, ownerId, botId);
          if (!bot) return `Bot not found: ${botId}`;
          return JSON.stringify(bot, null, 2);
        } catch (err) {
          return `Failed to get bot: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    create_bot: tool({
      description: "Create a new bot. Returns the new bot ID.",
      inputSchema: z.object({
        name: z.string().describe("Bot display name"),
        provider: z
          .enum(["openai", "anthropic", "google", "deepseek", "moonshot", "xai"])
          .describe("LLM provider"),
        model: z.string().describe("Model identifier"),
        soul: z.string().optional().describe("System prompt / soul"),
        agents: z.string().optional().describe("Agents prompt"),
        identity: z.string().optional().describe("Identity prompt"),
        baseUrl: z.string().optional().describe("Custom API base URL"),
        enabledSkills: z
          .array(z.string())
          .optional()
          .describe("List of enabled skill names"),
        maxIterations: z
          .number()
          .optional()
          .describe("Max agent loop iterations (default 10)"),
        memoryWindow: z
          .number()
          .optional()
          .describe("Number of messages in context window (default 50)"),
      }),
      execute: async (input) => {
        try {
          // Validate skill names if provided
          if (input.enabledSkills?.length) {
            const err = await validateSkillNames(db, input.enabledSkills);
            if (err) return err;
          }

          const botId = crypto.randomUUID();
          const config: BotConfig = {
            botId,
            ownerId,
            name: input.name,
            provider: input.provider,
            model: input.model,
            soul: input.soul ?? "",
            agents: input.agents ?? "",
            user: "",
            tools: "",
            identity: input.identity ?? "",
            baseUrl: input.baseUrl,
            channels: {},
            enabledSkills: input.enabledSkills ?? [],
            maxIterations: input.maxIterations ?? 10,
            memoryWindow: input.memoryWindow ?? 50,
            contextWindow: 128000,
            mcpServers: {},
            botType: "normal",
            allowedSenderIds: [],
          };
          await configDb.upsertBot(db, config);
          return `Bot created: **${input.name}** (\`${botId}\`)`;
        } catch (err) {
          return `Failed to create bot: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    update_bot: tool({
      description:
        "Update an existing bot. Only provided fields are changed. botId, ownerId, and botType are immutable.",
      inputSchema: z.object({
        botId: z.string().describe("The bot ID to update"),
        name: z.string().optional(),
        provider: z
          .enum(["openai", "anthropic", "google", "deepseek", "moonshot", "xai"])
          .optional(),
        model: z.string().optional(),
        soul: z.string().optional(),
        agents: z.string().optional(),
        identity: z.string().optional(),
        baseUrl: z.string().nullable().optional(),
        avatarUrl: z.string().nullable().optional(),
        enabledSkills: z.array(z.string()).optional(),
        maxIterations: z.number().optional(),
        memoryWindow: z.number().optional(),
        timezone: z.string().nullable().optional(),
        imageProvider: z.enum(["openai", "xai", "google"]).nullable().optional(),
        imageModel: z.string().nullable().optional(),
        allowedSenderIds: z.array(z.string()).optional(),
        clearFields: z
          .array(z.enum(UPDATE_BOT_CLEAR_FIELDS))
          .optional()
          .describe("Explicitly clear fields. Empty string/array values are ignored unless listed here."),
      }),
      execute: async ({ botId, clearFields, ...updates }) => {
        try {
          const existing = await configDb.getBot(db, ownerId, botId);
          if (!existing) return `Bot not found: ${botId}`;

          const normalized = sanitizeUpdatesWithClearFields<UpdateBotClearField>(
            updates,
            clearFields,
            {
              clearableFields: UPDATE_BOT_CLEAR_FIELDS,
              nullableClearFields: ["baseUrl", "avatarUrl", "timezone", "imageProvider", "imageModel"],
              ignoreEmptyStringFields: [
                "name",
                "model",
                "soul",
                "agents",
                "identity",
                "baseUrl",
                "avatarUrl",
                "timezone",
                "imageModel",
              ],
              ignoreEmptyArrayFields: ["enabledSkills", "allowedSenderIds"],
            },
          );
          if (normalized.error) return normalized.error;
          if (
            Object.keys(normalized.updates).length === 0 &&
            normalized.clearFields.size === 0
          ) {
            return "No effective update fields provided.";
          }

          // Validate skill names if enabledSkills is being updated
          const skillsToSet = normalized.updates.enabledSkills as string[] | undefined;
          if (skillsToSet?.length) {
            const err = await validateSkillNames(db, skillsToSet);
            if (err) return err;
          }

          // Merge updates, preserving immutable fields
          const merged: BotConfig = {
            ...existing,
            ...normalized.updates,
            // Immutable fields — always preserve original
            botId: existing.botId,
            ownerId: existing.ownerId,
            botType: existing.botType,
          };

          for (const field of normalized.clearFields) {
            applyUpdateBotClearField(merged, field);
          }

          await configDb.upsertBot(db, merged);
          return `Bot updated: **${merged.name}** (\`${botId}\`)`;
        } catch (err) {
          return `Failed to update bot: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    delete_bot: tool({
      description:
        "Soft-delete a bot. Also removes all channel token mappings. Cannot delete admin bots.",
      inputSchema: z.object({
        botId: z.string().describe("The bot ID to delete"),
      }),
      execute: async ({ botId }) => {
        try {
          const bot = await configDb.getBot(db, ownerId, botId);
          if (!bot) return `Bot not found: ${botId}`;
          if (bot.botType === "admin") return "Cannot delete an admin bot.";

          await configDb.deleteTokenMappingsForBot(db, ownerId, botId);
          // Clean up installed skills from D1
          try {
            await db.prepare("DELETE FROM skills WHERE bot_id = ?").bind(botId).run();
          } catch (e) {
            console.warn(`[admin/bots] Failed to clean up skills for bot ${botId}:`, e);
          }
          // Destroy Sprites sandbox (best-effort)
          if (env.SPRITES_TOKEN) {
            try {
              await destroySprite({
                token: env.SPRITES_TOKEN,
                spriteName: `multibot-${botId}`,
              });
            } catch (e) {
              console.warn(`[admin/bots] Failed to destroy sprite for bot ${botId}:`, e);
            }
          }
          await configDb.softDeleteBot(db, ownerId, botId);
          return `Bot deleted: **${bot.name}** (\`${botId}\`)`;
        } catch (err) {
          return `Failed to delete bot: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    restore_bot: tool({
      description: "Restore a previously soft-deleted bot.",
      inputSchema: z.object({
        botId: z.string().describe("The bot ID to restore"),
      }),
      execute: async ({ botId }) => {
        try {
          const bot = await configDb.restoreBot(db, ownerId, botId);
          if (!bot) return `Bot not found or not deleted: ${botId}`;
          return `Bot restored: **${bot.name}** (\`${botId}\`)`;
        } catch (err) {
          return `Failed to restore bot: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    clone_bot: tool({
      description:
        "Clone an existing bot with a new name. Copies all config (soul, agents, identity, provider, model, skills, etc.) but generates a new botId and starts with no channel bindings.",
      inputSchema: z.object({
        botId: z.string().describe("The source bot ID to clone from"),
        name: z.string().describe("Name for the new bot"),
      }),
      execute: async ({ botId, name }) => {
        try {
          const source = await configDb.getBot(db, ownerId, botId);
          if (!source) return `Bot not found: ${botId}`;
          if (source.botType === "admin")
            return "Cannot clone an admin bot.";

          const newBotId = crypto.randomUUID();
          const cloned: BotConfig = {
            ...source,
            botId: newBotId,
            ownerId,
            name,
            channels: {},
            allowedSenderIds: [],
          };
          await configDb.upsertBot(db, cloned);
          return `Bot cloned: **${name}** (\`${newBotId}\`) from **${source.name}**.\nProvider: ${cloned.provider}/${cloned.model}, skills: ${cloned.enabledSkills.length > 0 ? cloned.enabledSkills.join(", ") : "none"}\nNo channels bound — use bind_channel to connect.`;
        } catch (err) {
          return `Failed to clone bot: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}

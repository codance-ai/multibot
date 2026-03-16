/**
 * Batch operations + system status tools.
 */

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import * as configDb from "../../db/config";
import type { AdminToolDeps } from "./utils";
import {
  BATCH_UPDATE_BOT_CLEAR_FIELDS,
  sanitizeUpdatesWithClearFields,
  applyBatchUpdateBotClearField,
  validateSkillNames,
} from "./utils";
import type { BatchUpdateBotClearField } from "./utils";

export function createBatchTools(deps: AdminToolDeps): ToolSet {
  const { db, ownerId } = deps;

  return {
    batch_update_bots: tool({
      description:
        "Update multiple bots at once. Apply the same configuration changes to selected bots or all normal bots.",
      inputSchema: z.object({
        botIds: z
          .union([z.array(z.string()).min(1), z.literal("all")])
          .describe("Bot IDs to update, or 'all' for all normal bots"),
        model: z.string().optional(),
        provider: z
          .enum(["openai", "anthropic", "google", "deepseek", "moonshot", "xai"])
          .optional(),
        maxIterations: z.number().optional(),
        memoryWindow: z.number().optional(),
        enabledSkills: z.array(z.string()).optional(),
        timezone: z.string().nullable().optional(),
        imageProvider: z
          .enum(["openai", "xai", "google"])
          .nullable()
          .optional(),
        imageModel: z.string().nullable().optional(),
        clearFields: z
          .array(z.enum(BATCH_UPDATE_BOT_CLEAR_FIELDS))
          .optional()
          .describe("Explicitly clear fields. Empty string/array values are ignored unless listed here."),
      }),
      execute: async ({ botIds: botIdsInput, clearFields, ...updates }) => {
        try {
          const normalized = sanitizeUpdatesWithClearFields<BatchUpdateBotClearField>(
            updates,
            clearFields,
            {
              clearableFields: BATCH_UPDATE_BOT_CLEAR_FIELDS,
              nullableClearFields: ["timezone", "imageProvider", "imageModel"],
              ignoreEmptyStringFields: ["model", "timezone", "imageModel"],
              ignoreEmptyArrayFields: ["enabledSkills"],
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
          const batchSkills = normalized.updates.enabledSkills as string[] | undefined;
          if (batchSkills?.length) {
            const err = await validateSkillNames(db, batchSkills);
            if (err) return err;
          }

          let targetIds: string[];
          if (botIdsInput === "all") {
            const allBots = await configDb.listBots(db, ownerId);
            targetIds = allBots
              .filter((b) => b.botType === "normal")
              .map((b) => b.botId);
          } else {
            targetIds = botIdsInput;
          }

          if (targetIds.length === 0) return "No bots to update.";

          const succeeded: string[] = [];
          const failed: string[] = [];

          for (const id of targetIds) {
            const existing = await configDb.getBot(db, ownerId, id);
            if (!existing) {
              failed.push(`${id} (not found)`);
              continue;
            }
            if (existing.botType === "admin") {
              failed.push(`${existing.name} (admin bot)`);
              continue;
            }

            const merged: any = { ...existing };
            for (const [k, v] of Object.entries(normalized.updates)) {
              merged[k] = v;
            }
            for (const field of normalized.clearFields) {
              applyBatchUpdateBotClearField(merged, field);
            }
            merged.botId = existing.botId;
            merged.ownerId = existing.ownerId;
            merged.botType = existing.botType;

            try {
              await configDb.upsertBot(db, merged);
              succeeded.push(existing.name);
            } catch (err) {
              failed.push(
                `${existing.name} (${err instanceof Error ? err.message : String(err)})`,
              );
            }
          }

          const total = targetIds.length;
          let result = `Updated ${succeeded.length}/${total} bots`;
          if (succeeded.length > 0) result += `: ${succeeded.join(", ")}`;
          if (failed.length > 0)
            result += `\nFailed: ${failed.join(", ")}`;
          return result;
        } catch (err) {
          return `Failed to batch update: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    system_status: tool({
      description:
        "Get a full system overview: all bots with their channels, groups, API key status, and today's activity.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const sections: string[] = [];

          // Bots
          const bots = await configDb.listBots(db, ownerId);
          if (bots.length > 0) {
            const botLines = bots.map((b) => {
              const chans = Object.keys(b.channels);
              const chanStr = chans.length > 0 ? chans.join(", ") : "none";
              return `  - ${b.botType === "admin" ? "👑 " : ""}**${b.name}** — ${b.provider}/${b.model} [channels: ${chanStr}]`;
            });
            sections.push(`**Bots** (${bots.length}):\n${botLines.join("\n")}`);
          } else {
            sections.push("**Bots**: none");
          }

          // Groups
          const groups = await configDb.listGroups(db, ownerId);
          if (groups.length > 0) {
            const groupLines = groups.map((g) => {
              const botNames = bots
                .filter((b) => g.botIds.includes(b.botId))
                .map((b) => b.name);
              return `  - **${g.name}** — ${botNames.join(", ")} (orchestrator: ${g.orchestratorModel})`;
            });
            sections.push(`**Groups** (${groups.length}):\n${groupLines.join("\n")}`);
          } else {
            sections.push("**Groups**: none");
          }

          // API Keys
          const keys = await configDb.getUserKeys(db, ownerId);
          if (keys) {
            const configured = Object.entries(keys)
              .filter(([, v]) => !!v)
              .map(([k]) => k);
            sections.push(
              configured.length > 0
                ? `**API Keys**: ${configured.join(", ")}`
                : "**API Keys**: none configured",
            );
          } else {
            sections.push("**API Keys**: none configured");
          }

          // Today's activity
          const { results: usage } = await db
            .prepare(
              `SELECT m.bot_id, b.name, COUNT(*) as msg_count
               FROM messages m
               JOIN bots b ON m.bot_id = b.bot_id
               WHERE m.created_at >= date('now') AND b.owner_id = ?
               GROUP BY m.bot_id, b.name ORDER BY msg_count DESC`,
            )
            .bind(ownerId)
            .all<{ bot_id: string; name: string; msg_count: number }>();

          if (usage.length > 0) {
            const total = usage.reduce((s, r) => s + r.msg_count, 0);
            const lines = usage.map((r) => `  - ${r.name}: ${r.msg_count} msgs`);
            sections.push(`**Today's Activity** (${total} total msgs):\n${lines.join("\n")}`);
          } else {
            sections.push("**Today's Activity**: no messages yet");
          }

          return sections.join("\n\n");
        } catch (err) {
          return `Failed to get system status: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}

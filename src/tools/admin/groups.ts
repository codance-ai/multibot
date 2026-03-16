/**
 * Group management tools: list_groups, create_group, update_group, delete_group.
 */

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import * as configDb from "../../db/config";
import type { AdminToolDeps } from "./utils";

export function createGroupTools(deps: AdminToolDeps): ToolSet {
  const { db, ownerId } = deps;

  return {
    list_groups: tool({
      description: "List all groups for the current owner.",
      inputSchema: z.object({}),
      execute: async () => {
        try {
          const groups = await configDb.listGroups(db, ownerId);
          if (groups.length === 0) return "No groups found.";
          const lines = groups.map(
            (g) =>
              `- **${g.name}** (\`${g.groupId}\`) — ${g.botIds.length} bot(s), orchestrator: ${g.orchestratorModel}`,
          );
          return lines.join("\n");
        } catch (err) {
          return `Failed to list groups: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    create_group: tool({
      description:
        "Create a new group chat. Admin bots cannot be added to groups.",
      inputSchema: z.object({
        name: z.string().describe("Group display name"),
        botIds: z
          .array(z.string())
          .min(1)
          .describe("Bot IDs to include in the group"),
        note: z
          .string()
          .optional()
          .describe("A note providing context for the group chat (e.g. who the user is)"),
        orchestratorModel: z
          .string()
          .optional()
          .describe("Model for the group orchestrator (default: claude-sonnet-4-6)"),
      }),
      execute: async (input) => {
        try {
          // Validate all bots exist and none are admin type
          for (const botId of input.botIds) {
            const bot = await configDb.getBot(db, ownerId, botId);
            if (!bot) return `Bot not found: ${botId}`;
            if (bot.botType === "admin")
              return `Cannot add admin bot "${bot.name}" to a group.`;
          }

          const groupId = crypto.randomUUID();
          await configDb.upsertGroup(db, {
            groupId,
            ownerId,
            name: input.name,
            botIds: input.botIds,
            note: input.note ?? "",
            orchestratorProvider: "anthropic",
            orchestratorModel: input.orchestratorModel ?? "claude-sonnet-4-6",
          });
          return `Group created: **${input.name}** (\`${groupId}\`)`;
        } catch (err) {
          return `Failed to create group: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    update_group: tool({
      description:
        "Update an existing group. Only provided fields are changed. groupId and ownerId are immutable.",
      inputSchema: z.object({
        groupId: z.string().describe("The group ID to update"),
        name: z.string().optional(),
        botIds: z.array(z.string()).optional(),
        note: z.string().optional(),
        orchestratorProvider: z
          .enum(["openai", "anthropic", "google"])
          .optional(),
        orchestratorModel: z.string().optional(),
      }),
      execute: async ({ groupId, ...updates }) => {
        try {
          const existing = await configDb.getGroup(db, ownerId, groupId);
          if (!existing) return `Group not found: ${groupId}`;

          // If updating botIds, validate none are admin
          if (updates.botIds) {
            for (const botId of updates.botIds) {
              const bot = await configDb.getBot(db, ownerId, botId);
              if (!bot) return `Bot not found: ${botId}`;
              if (bot.botType === "admin")
                return `Cannot add admin bot "${bot.name}" to a group.`;
            }
          }

          const merged = {
            ...existing,
            ...Object.fromEntries(
              Object.entries(updates).filter(([, v]) => v !== undefined),
            ),
            // Immutable
            groupId: existing.groupId,
            ownerId: existing.ownerId,
          };

          await configDb.upsertGroup(db, merged);
          return `Group updated: **${merged.name}** (\`${groupId}\`)`;
        } catch (err) {
          return `Failed to update group: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    delete_group: tool({
      description: "Delete a group.",
      inputSchema: z.object({
        groupId: z.string().describe("The group ID to delete"),
      }),
      execute: async ({ groupId }) => {
        try {
          await configDb.deleteGroup(db, ownerId, groupId);
          return `Group deleted: \`${groupId}\``;
        } catch (err) {
          return `Failed to delete group: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}

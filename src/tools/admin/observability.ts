/**
 * Observability/query tools: sessions, memory, messages, webhook, usage.
 */

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import * as configDb from "../../db/config";
import { getMemory, upsertMemory, getHistoryEntries, insertHistoryEntry } from "../../db/d1";
import type { AdminToolDeps } from "./utils";

export function createObservabilityTools(deps: AdminToolDeps): ToolSet {
  const { db, ownerId } = deps;

  return {
    query_sessions: tool({
      description:
        "Query recent sessions from D1. Useful for checking bot activity and conversation history.",
      inputSchema: z.object({
        botId: z
          .string()
          .optional()
          .describe("Filter by bot ID (checks messages in the session)"),
        date: z
          .string()
          .optional()
          .describe("Filter by date (YYYY-MM-DD format)"),
        limit: z
          .number()
          .optional()
          .describe("Max sessions to return (default 20)"),
      }),
      execute: async ({ botId, date, limit }) => {
        try {
          const n = Math.min(limit ?? 20, 100);
          let sql =
            "SELECT s.id, s.channel, s.chat_id, s.group_id, s.created_at, COUNT(m.id) as message_count FROM sessions s LEFT JOIN messages m ON m.session_id = s.id";
          const conditions: string[] = [];
          const params: (string | number)[] = [];

          if (botId) {
            conditions.push(
              "s.id IN (SELECT DISTINCT session_id FROM messages WHERE bot_id = ?)",
            );
            params.push(botId);
          }

          if (date) {
            if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
              return "Invalid date format. Use YYYY-MM-DD.";
            }
            conditions.push("s.created_at >= ? AND s.created_at < date(?, '+1 day')");
            params.push(date, date);
          }

          if (conditions.length > 0) {
            sql += " WHERE " + conditions.join(" AND ");
          }

          sql += " GROUP BY s.id ORDER BY s.created_at DESC LIMIT ?";
          params.push(n);

          const stmt = db.prepare(sql);
          const { results } = await stmt.bind(...params).all();

          if (results.length === 0) return "No sessions found.";
          const lines = results.map(
            (r: any) =>
              `- \`${r.id}\` — ${r.channel}/${r.chat_id}${r.group_id ? ` (group: ${r.group_id})` : ""}, ${r.message_count} msgs, ${r.created_at}`,
          );
          return lines.join("\n");
        } catch (err) {
          return `Failed to query sessions: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    read_bot_memory: tool({
      description:
        "Read another bot's memory file (MEMORY.md or HISTORY.md). Content is truncated to maxLength (default 2000) chars. Pass a larger maxLength to read more.",
      inputSchema: z.object({
        botId: z.string().describe("Target bot ID"),
        file: z
          .enum(["MEMORY.md", "HISTORY.md"])
          .describe("Which memory file to read"),
        maxLength: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max characters to return (default 2000). Use larger value to read full content."),
      }),
      execute: async ({ botId, file, maxLength }) => {
        try {
          const bot = await configDb.getBot(db, ownerId, botId);
          if (!bot) return `Bot not found: ${botId}`;
          let content: string;
          if (file === "MEMORY.md") {
            content = await getMemory(db, botId);
          } else {
            // HISTORY.md
            const entries = await getHistoryEntries(db, botId, 100);
            content = entries.map((e) => e.content).join("\n\n");
          }
          if (!content) return "(empty)";
          const limit = maxLength ?? 2000;
          if (content.length > limit) {
            return content.slice(0, limit) + `... (truncated, total ${content.length} chars, use maxLength=${content.length} to read full)`;
          }
          return content;
        } catch (err) {
          return `Failed to read bot memory: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    edit_bot_memory: tool({
      description:
        "Edit a specific part of another bot's memory file by replacing a string. Safer than clearing and rewriting because it only changes the matched part.",
      inputSchema: z.object({
        botId: z.string().describe("Target bot ID"),
        old_string: z.string().describe("The exact text to find and replace"),
        new_string: z.string().describe("The replacement text"),
      }),
      execute: async ({ botId, old_string, new_string }) => {
        try {
          const bot = await configDb.getBot(db, ownerId, botId);
          if (!bot) return `Bot not found: ${botId}`;
          if (bot.botType === "admin")
            return "Cannot edit admin bot's memory.";

          const content = await getMemory(db, botId);
          if (!content) return `Cannot edit: MEMORY.md is empty for **${bot.name}**.`;
          const count = content.split(old_string).length - 1;
          if (count === 0)
            return `old_string not found in MEMORY.md. Use read_bot_memory to check current content.`;
          if (count > 1)
            return `old_string found ${count} times in MEMORY.md. Provide more surrounding context to make it unique.`;
          const updated = content.replace(old_string, new_string);
          await upsertMemory(db, botId, updated);
          return `Edited MEMORY.md for **${bot.name}** (\`${botId}\`): replaced ${old_string.length} chars with ${new_string.length} chars.`;
        } catch (err) {
          return `Failed to edit bot memory: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    correct_bot_history: tool({
      description:
        "Append a correction entry to a bot's HISTORY.md. Use when a bot has incorrect information in its history that could pollute memory review. " +
        "HISTORY.md is append-only — this does NOT edit existing entries, it adds a correction that memory review will pick up. " +
        "For immediate fixes, also use edit_bot_memory to correct MEMORY.md directly.",
      inputSchema: z.object({
        botId: z.string().describe("Target bot ID"),
        correction: z.string().describe(
          "The correction entry. Start with [CORRECTION] and clearly state what was wrong and what the correct information is."
        ),
      }),
      execute: async ({ botId, correction }) => {
        try {
          const bot = await configDb.getBot(db, ownerId, botId);
          if (!bot) return `Bot not found: ${botId}`;
          if (bot.botType === "admin")
            return "Cannot modify admin bot's history.";

          const entry = correction.startsWith("[CORRECTION]")
            ? correction
            : `[CORRECTION] ${correction}`;
          await insertHistoryEntry(db, botId, entry);
          return `Appended correction to HISTORY.md for **${bot.name}** (\`${botId}\`).`;
        } catch (err) {
          return `Failed to append correction: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    read_bot_messages: tool({
      description:
        "Read recent messages from a bot's conversation history. By default content is truncated to 200 chars and images are replaced with [image]. Pass full=true to see complete content.",
      inputSchema: z.object({
        botId: z.string().describe("Target bot ID"),
        chatId: z.string().optional().describe("Filter by chat ID"),
        limit: z.number().optional().describe("Max messages to return (default 20, max 50)"),
        offset: z.number().optional().describe("Skip first N messages for pagination (default 0)"),
        full: z.boolean().optional().describe("If true, return full content without truncation or image filtering (default false)"),
      }),
      execute: async ({ botId, chatId, limit, offset, full }) => {
        try {
          const bot = await configDb.getBot(db, ownerId, botId);
          if (!bot) return `Bot not found: ${botId}`;

          const n = Math.min(limit ?? 20, 50);
          const skip = Math.max(offset ?? 0, 0);
          let sql = "SELECT m.role, m.content, m.tool_calls, m.created_at FROM messages m";
          const params: (string | number)[] = [];

          if (chatId) {
            sql += " JOIN sessions s ON m.session_id = s.id WHERE m.bot_id = ? AND s.chat_id = ?";
            params.push(botId, chatId);
          } else {
            sql += " WHERE m.bot_id = ?";
            params.push(botId);
          }

          sql += " ORDER BY m.created_at DESC LIMIT ? OFFSET ?";
          params.push(n, skip);

          const { results } = await db
            .prepare(sql)
            .bind(...params)
            .all<{ role: string; content: string | null; tool_calls: string | null; created_at: string }>();

          if (results.length === 0) return "No messages found.";

          const lines = results.reverse().map((r) => {
            let toolsSuffix = "";
            if (r.tool_calls) {
              try {
                const parsed = JSON.parse(r.tool_calls);
                if (Array.isArray(parsed) && parsed.length > 0) {
                  const names = parsed.map((c: { toolName: string }) => c.toolName);
                  toolsSuffix = ` [tools: ${names.join(", ")}]`;
                }
              } catch (e) { console.warn("[observability] Failed to parse tool_calls:", e); }
            }
            let content = r.content ?? "(no content)";
            if (!full) {
              // Replace image references: ![alt](image:...) → [image]
              content = content.replace(/!\[[^\]]*\]\(image:[^)]*\)/g, "[image]");
              if (content.length > 200) {
                content = content.slice(0, 200) + "...";
              }
            }
            return `[${r.created_at}] ${r.role.toUpperCase()}${toolsSuffix}: ${content}`;
          });
          let output = lines.join("\n");
          if (results.length === n) {
            output += `\n(showing ${skip + 1}-${skip + results.length}, use offset=${skip + results.length} for more)`;
          }
          return output;
        } catch (err) {
          return `Failed to read messages: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    check_webhook: tool({
      description:
        "Check the Telegram webhook status for a bot. Shows URL, pending updates, last error, and connection health.",
      inputSchema: z.object({
        botId: z.string().describe("Target bot ID"),
      }),
      execute: async ({ botId }) => {
        try {
          const bot = await configDb.getBot(db, ownerId, botId);
          if (!bot) return `Bot not found: ${botId}`;

          const tg = bot.channels.telegram;
          if (!tg?.token) return `No Telegram channel bound to **${bot.name}**.`;

          const resp = await fetch(
            `https://api.telegram.org/bot${tg.token}/getWebhookInfo`,
          );
          if (!resp.ok) return `Telegram API error: ${resp.status} ${resp.statusText}`;

          const data = (await resp.json()) as {
            ok: boolean;
            result: {
              url: string;
              pending_update_count: number;
              last_error_date?: number;
              last_error_message?: string;
            };
          };

          if (!data.ok) return "Telegram API returned an error.";

          const info = data.result;
          const lines = [
            `**${bot.name}** Telegram Webhook:`,
            `- URL: ${info.url || "(not set)"}`,
            `- Pending updates: ${info.pending_update_count}`,
          ];

          if (info.last_error_date && info.last_error_date > 0) {
            const errorTime = new Date(info.last_error_date * 1000).toISOString();
            lines.push(`- Last error: ${info.last_error_message || "unknown"} (${errorTime})`);
          } else {
            lines.push("- No recent errors");
          }

          const hasError = info.last_error_date && info.last_error_date > 0;
          const highPending = info.pending_update_count > 5;
          const status = hasError ? "ERROR" : highPending ? "WARNING" : "OK";
          lines.push(`- Status: **${status}**`);

          return lines.join("\n");
        } catch (err) {
          return `Failed to check webhook: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    query_usage: tool({
      description:
        "Query message counts and activity stats for bots. Shows how active each bot has been in a time period.",
      inputSchema: z.object({
        botId: z.string().optional().describe("Filter by bot ID (omit for all bots)"),
        period: z.enum(["today", "week", "month"]).optional().describe("Time period (default: today)"),
      }),
      execute: async ({ botId, period }) => {
        try {
          const periodMap: Record<string, string> = {
            today: "date('now')",
            week: "date('now', '-7 days')",
            month: "date('now', '-30 days')",
          };
          const since = periodMap[period ?? "today"];

          let sql = `
            SELECT m.bot_id, b.name,
                   COUNT(*) as msg_count,
                   COUNT(DISTINCT m.session_id) as session_count
            FROM messages m
            JOIN bots b ON m.bot_id = b.bot_id
            WHERE m.created_at >= ${since}
            AND b.owner_id = ?`;
          const params: string[] = [ownerId];

          if (botId) {
            sql += " AND m.bot_id = ?";
            params.push(botId);
          }

          sql += " GROUP BY m.bot_id ORDER BY msg_count DESC";

          const { results } = await db
            .prepare(sql)
            .bind(...params)
            .all<{ bot_id: string; name: string; msg_count: number; session_count: number }>();

          if (results.length === 0) {
            return `No activity found for ${period ?? "today"}.`;
          }

          const label = period ?? "today";
          const lines = results.map(
            (r) => `- **${r.name}** (\`${r.bot_id}\`): ${r.msg_count} messages, ${r.session_count} sessions`,
          );
          return `Activity (${label}):\n${lines.join("\n")}`;
        } catch (err) {
          return `Failed to query usage: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}

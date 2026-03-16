/**
 * Channel management tools: bind_channel, unbind_channel.
 */

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import * as configDb from "../../db/config";
import type { AdminToolDeps } from "./utils";

export function createChannelTools(deps: AdminToolDeps): ToolSet {
  const { db, env, ownerId, baseUrl } = deps;

  return {
    bind_channel: tool({
      description:
        "Bind a channel (e.g. telegram, discord, slack) to a bot. Creates the token mapping and updates bot.channels.",
      inputSchema: z.object({
        botId: z.string().describe("The bot to bind"),
        channel: z.string().describe("Channel name, e.g. 'telegram', 'discord', 'slack'"),
        token: z.string().describe("The channel bot token"),
        webhookUrl: z.string().optional().describe("Optional webhook URL (for Discord, etc.)"),
      }),
      execute: async ({ botId, channel, token, webhookUrl }) => {
        try {
          const bot = await configDb.getBot(db, ownerId, botId);
          if (!bot) return `Bot not found: ${botId}`;

          // Create token mapping
          await configDb.upsertTokenMapping(db, channel, token, {
            ownerId,
            botId,
          });

          // Update bot.channels
          const channels = { ...bot.channels };
          const binding: Record<string, unknown> = { token, webhookUrl };

          // Auto-fetch bot identity (best-effort)
          if (channel === "telegram") {
            try {
              const meResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
              const meData = (await meResp.json()) as { ok: boolean; result?: { username?: string } };
              if (meData.ok && meData.result?.username) {
                binding.channelUsername = `@${meData.result.username}`;
              }
            } catch (e) { console.warn("[channels] Telegram identity fetch failed:", e); }
          } else if (channel === "discord") {
            try {
              const meResp = await fetch("https://discord.com/api/v10/users/@me", {
                headers: { Authorization: `Bot ${token}` },
              });
              const meData = (await meResp.json()) as { id?: string };
              if (meData.id) binding.channelUserId = meData.id;
            } catch (e) { console.warn("[channels] Discord identity fetch failed:", e); }
          } else if (channel === "slack") {
            try {
              const meResp = await fetch("https://slack.com/api/auth.test", {
                headers: { Authorization: `Bearer ${token}` },
              });
              const meData = (await meResp.json()) as { ok?: boolean; user_id?: string };
              if (meData.ok && meData.user_id) binding.channelUserId = meData.user_id;
            } catch (e) { console.warn("[channels] Slack identity fetch failed:", e); }
          }

          channels[channel] = binding as any;
          await configDb.upsertBot(db, { ...bot, channels });

          let result = `Channel **${channel}** bound to **${bot.name}**.`;

          // Auto-set Telegram webhook
          if (channel === "telegram") {
            try {
              const webhookApiUrl = `https://api.telegram.org/bot${token}/setWebhook`;
              const resp = await fetch(webhookApiUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  url: `${baseUrl}/webhook/telegram/${token}`,
                  secret_token: env.WEBHOOK_SECRET,
                }),
              });
              const data = (await resp.json()) as { ok: boolean; description?: string };
              if (data.ok) {
                result += "\nTelegram webhook set automatically.";
              } else {
                result += `\nWarning: Failed to set webhook: ${data.description ?? "unknown error"}`;
              }
            } catch (err) {
              result += `\nWarning: Failed to set webhook: ${err instanceof Error ? err.message : String(err)}`;
            }
          }

          return result;
        } catch (err) {
          return `Failed to bind channel: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),

    unbind_channel: tool({
      description: "Remove a channel binding from a bot.",
      inputSchema: z.object({
        botId: z.string().describe("The bot to unbind"),
        channel: z.string().describe("Channel name to remove"),
      }),
      execute: async ({ botId, channel }) => {
        try {
          const bot = await configDb.getBot(db, ownerId, botId);
          if (!bot) return `Bot not found: ${botId}`;

          const channelInfo = bot.channels[channel];
          if (!channelInfo) return `Channel **${channel}** is not bound to this bot.`;

          // Auto-delete Telegram webhook before removing binding
          let webhookDeleted = false;
          if (channel === "telegram") {
            try {
              const resp = await fetch(
                `https://api.telegram.org/bot${channelInfo.token}/deleteWebhook`,
              );
              const data = (await resp.json()) as { ok: boolean };
              webhookDeleted = data.ok;
            } catch (e) {
              console.warn("[channels] Telegram webhook delete failed:", e);
              // Non-fatal — continue with unbinding
            }
          }

          // Remove token mapping
          await configDb.deleteTokenMapping(db, channel, channelInfo.token);

          // Update bot.channels
          const channels = { ...bot.channels };
          delete channels[channel];
          await configDb.upsertBot(db, { ...bot, channels });

          let result = `Channel **${channel}** unbound from **${bot.name}**.`;
          if (channel === "telegram") {
            result += webhookDeleted
              ? "\nTelegram webhook deleted."
              : "\nWarning: Failed to delete Telegram webhook (binding removed anyway).";
          }
          return result;
        } catch (err) {
          return `Failed to unbind channel: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    }),
  };
}

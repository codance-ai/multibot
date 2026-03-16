import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { GroupConfig } from "../config/schema";
import type { ChannelSender } from "./message";

export type VoiceSender = (
  channel: string,
  channelToken: string,
  chatId: string,
  text: string,
) => Promise<{ voiceSent: boolean }>;

export type GroupMessagePersister = (
  groupConfig: GroupConfig,
  channel: string,
  chatId: string,
  senderBotId: string,
  message: string,
) => Promise<void>;

export type OrchestratorDispatcher = (
  groupConfig: GroupConfig,
  channel: string,
  chatId: string,
  senderBotId: string,
  senderBotName: string,
  message: string,
) => void;

export interface GroupMessageContext {
  channel: string;
  channelToken: string;
  botId: string;
  botName: string;
  groups: GroupConfig[];
  dispatchToOrchestrator?: OrchestratorDispatcher;
  voiceSender?: VoiceSender;
}

export function createGroupMessageTools(
  sender: ChannelSender,
  persister: GroupMessagePersister,
  ctx: GroupMessageContext,
): ToolSet {
  const groupList = ctx.groups.map((g) => `"${g.name}"`).join(", ");

  return {
    send_to_group: tool({
      description:
        `Send a message to a group chat you belong to. ` +
        `Available groups: ${groupList || "none"}. ` +
        `The message will be visible to all members and bots in the group.`,
      inputSchema: z.object({
        message: z.string().describe("The message content to send to the group"),
        group_name: z
          .string()
          .optional()
          .describe(
            "Target group name. Required if you belong to multiple groups.",
          ),
      }),
      execute: async ({ message, group_name }) => {
        if (ctx.groups.length === 0) {
          return "Error: You don't belong to any groups.";
        }

        // Resolve target group
        let targetGroup: GroupConfig;
        if (group_name) {
          const found = ctx.groups.find(
            (g) => g.name.toLowerCase() === group_name.toLowerCase(),
          );
          if (!found) {
            return `Error: Group "${group_name}" not found. Available: ${groupList}`;
          }
          targetGroup = found;
        } else if (ctx.groups.length === 1) {
          targetGroup = ctx.groups[0];
        } else {
          return `Error: You belong to multiple groups (${groupList}). Please specify group_name.`;
        }

        // Resolve chatId for this group on this channel
        const chatId = targetGroup.channel === ctx.channel ? targetGroup.chatId : undefined;
        if (!chatId) {
          return `Error: No chat found for group "${targetGroup.name}" on ${ctx.channel}. The group needs to receive at least one message on this channel first.`;
        }

        // Send to channel (prefer voice if available, fallback to text)
        if (ctx.voiceSender) {
          try {
            await ctx.voiceSender(ctx.channel, ctx.channelToken, chatId, message);
          } catch (e) {
            console.warn("[send_to_group] voiceSender failed, falling back to text:", e);
            await sender(ctx.channel, ctx.channelToken, chatId, message);
          }
        } else {
          await sender(ctx.channel, ctx.channelToken, chatId, message);
        }

        // Persist to all bots' sessions in the group
        await persister(
          targetGroup,
          ctx.channel,
          chatId,
          ctx.botId,
          message,
        );

        // Trigger orchestrator so other bots can respond (fire-and-forget)
        ctx.dispatchToOrchestrator?.(
          targetGroup, ctx.channel, chatId, ctx.botId, ctx.botName, message,
        );

        return `Message sent to group "${targetGroup.name}".`;
      },
    }),
  };
}

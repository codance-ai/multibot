/**
 * Bot invocation logic extracted from ChatCoordinator.executeTurn().
 * Pure refactoring — no behavior changes.
 */

import { getAgentByName } from "agents";
import type { Env, AgentRequestPayload, BotConfig, UserKeys, GroupConfig, GroupContext, InputMeta } from "../config/schema";
import type { SenderMeta, AttachmentRef, MediaItem } from "../channels/registry";
import type { Logger, SkillCall } from "../utils/logger";
import type { MultibotAgent } from "../agent/multibot";
import type { StoredMessage } from "../agent/loop";
import { GROUP_BOT_TIMEOUT_MS } from "./coordinator-utils";

export interface BotCallResult {
  botName: string;
  botId: string;
  reply: string;
  requestId?: string;
  newMessages?: StoredMessage[];
  imageCount: number;
  media: MediaItem[];
}

export interface BotCallTrace {
  round: number;
  wave?: number;
  botId: string;
  botName: string;
  requestId?: string;
  durationMs: number;
  status: "ok" | "error";
  inputTokens?: number;
  outputTokens?: number;
  skillCalls?: SkillCall[];
  voiceSent?: boolean;
}

/** Build sender metadata for channel messages */
export function buildSenderMeta(
  botName: string,
  botConfigs: BotConfig[],
): SenderMeta {
  const bc = botConfigs.find(b => b.name === botName);
  return { username: botName, avatarUrl: bc?.avatarUrl };
}

/** Get the channel token for a specific bot */
export function getSendTokenForBot(
  botName: string,
  botConfigs: BotConfig[],
  channel: string,
  defaultToken: string,
): string {
  const bot = botConfigs.find(b => b.name === botName);
  return bot?.channels[channel]?.token || defaultToken;
}

/** Invoke a bot agent and return its reply */
export async function callBot(params: {
  env: Env;
  botConfig: BotConfig;
  userKeys: UserKeys;
  groupId: string;
  groupConfig: GroupConfig;
  members: GroupContext["members"];
  channel: string;
  chatId: string;
  userId: string;
  userName: string;
  channelToken: string;
  sessionId: string;
  userMessage: string;
  round: number;
  wave?: number;
  attachments?: AttachmentRef[];
  parentRequestId?: string;
  isVoiceMessage?: boolean;
  inputMeta?: InputMeta;
  log: Logger;
  traceBotCalls: BotCallTrace[];
  /** Override per-bot timeout (defaults to GROUP_BOT_TIMEOUT_MS). */
  timeoutMs?: number;
}): Promise<BotCallResult> {
  const {
    env, botConfig, userKeys, groupId, groupConfig, members,
    channel, chatId, userId, userName, channelToken, sessionId,
    userMessage, round, wave, attachments, parentRequestId,
    isVoiceMessage, inputMeta, log, traceBotCalls,
  } = params;
  const effectiveTimeout = params.timeoutMs ?? GROUP_BOT_TIMEOUT_MS;

  const agentId = `gchat-${groupId}-${botConfig.botId}-${channel}-${chatId}`;
  const groupContext: GroupContext = {
    groupId,
    groupName: groupConfig.name,
    members,
    userName,
    note: groupConfig.note ?? "",
    round,
    wave,
  };
  const payload: AgentRequestPayload = {
    botConfig,
    userKeys,
    chatId,
    userId,
    userName,
    userMessage,
    channel,
    channelToken,
    groupContext,
    sessionId,
    parentRequestId: parentRequestId ?? log.requestId,
    attachments,
    coordinatorOwned: true,
    deadline: Date.now() + effectiveTimeout,
    ...(isVoiceMessage && { isVoiceMessage: true }),
    ...(inputMeta && { inputMeta }),
  };

  const callStart = performance.now();
  let callStatus: "ok" | "error" = "ok";
  let callInputTokens: number | undefined;
  let callOutputTokens: number | undefined;
  let callSkillCalls: SkillCall[] | undefined;
  let callRequestId: string | undefined;
  let timeoutId: ReturnType<typeof setTimeout>;
  try {
    const agent = await getAgentByName<Env, MultibotAgent>(
      env.MULTIBOT_AGENT,
      agentId,
    );
    const agentRequest = new Request("https://agent/group-chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const timeout = new Promise<never>((_, reject) => {
      timeoutId = setTimeout(
        () => reject(new Error(`Bot ${botConfig.name} timed out after ${effectiveTimeout / 1000}s`)),
        effectiveTimeout,
      );
    });
    const response = await Promise.race([agent.fetch(agentRequest), timeout]);
    clearTimeout(timeoutId!);
    const data = await response.json() as {
      requestId?: string;
      reply: string;
      inputTokens?: number;
      outputTokens?: number;
      skillCalls?: SkillCall[];
      model?: string;
      newMessages?: StoredMessage[];
      imageCount?: number;
      media?: MediaItem[];
    };
    callInputTokens = data.inputTokens;
    callOutputTokens = data.outputTokens;
    callSkillCalls = data.skillCalls;
    callRequestId = data.requestId;
    return { botName: botConfig.name, botId: botConfig.botId, reply: data.reply, requestId: data.requestId, newMessages: data.newMessages, imageCount: data.imageCount ?? 0, media: data.media ?? [] };
  } catch (e) {
    clearTimeout(timeoutId!);
    callStatus = "error";
    throw e;
  } finally {
    traceBotCalls.push({
      round,
      wave,
      botId: botConfig.botId,
      botName: botConfig.name,
      requestId: callRequestId,
      durationMs: Math.round(performance.now() - callStart),
      status: callStatus,
      inputTokens: callInputTokens,
      outputTokens: callOutputTokens,
      skillCalls: callSkillCalls,
    });
  }
}

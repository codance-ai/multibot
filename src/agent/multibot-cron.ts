import type { Env, BotConfig, UserKeys } from "../config/schema";
import * as configDb from "../db/config";
import { createModel } from "../providers/gateway";
import type { SandboxClient } from "../tools/sandbox-types";
import { runAgentLoop } from "./loop";
import type { MediaItem, SenderOptions, SendAudioOptions } from "../channels/registry";
import type { CronJobPayload } from "../cron/types";
import { getNextCronDateInTimezone } from "../tools/cron";
import type { CronScheduler } from "../tools/cron";
import { persistCronReplyToGroupSession } from "./cron-group-persist";
import * as d1 from "../db/d1";
import type { ToolSet } from "ai";
import { createLogger } from "../utils/logger";
import type { Logger, RequestTrace } from "../utils/logger";
import { REQUEST_TIMEOUT_MS } from "./multibot-helpers";
import { resolveAndNormalizeReply } from "./multibot-image";
import { attachmentsToJson } from "./multibot-helpers";
import { findAllGroupsForBot } from "../db/config";
import type { buildAgentTools } from "./multibot-build";
import type { buildPromptAndHistory } from "./multibot-build";

export interface CronDeps {
  env: Env;
  db: D1Database;
  loadBotConfigAndKeys: (ownerId: string, botId: string) => Promise<{ botConfig: BotConfig; userKeys: UserKeys } | null>;
  getSchedules: <T>() => Array<{ id: string; type: string; callback: string; payload: T; time?: number }>;
  cancelSchedule: (id: string) => Promise<boolean>;
  schedule: (when: Date | string, callback: string, payload: CronJobPayload) => Promise<{ id: string }>;
  buildAgentTools: typeof buildAgentTools;
  buildPromptAndHistory: typeof buildPromptAndHistory;
  getSandboxClient: (botId: string) => SandboxClient;
  buildLocalCronScheduler: () => CronScheduler;
  buildRemoteCronScheduler: (botId: string) => CronScheduler;
  ensureMcpConnected: (mcpServers: Record<string, { url: string; headers: Record<string, string> }>, log?: Logger) => Promise<void>;
  getMcpTools: () => ToolSet;
  sendChannelMessage: (ch: string, tok: string, cid: string, text: string, opts?: SenderOptions) => Promise<void>;
  sendChannelAudio?: (ch: string, tok: string, cid: string, audio: ArrayBuffer, opts?: SendAudioOptions) => Promise<{ captionSent: boolean }>;
  startTypingLoop: (ch: string, tok: string, cid: string, signal: AbortSignal, deadline?: number) => void;
  dispatchGroupOrchestrator: (params: {
    channel: string;
    token: string;
    ownerId: string;
    groupId: string;
    chatId: string;
    senderBotId: string;
    senderBotName: string;
    message: string;
    parentRequestId?: string;
  }) => void;
}

export async function executeCronJob(deps: CronDeps, payload: CronJobPayload, log: Logger): Promise<void> {
  const cronStartedAt = Date.now();
  let voiceSent = false;

  try {
    // 1. Load BotConfig + UserKeys from D1
    const loaded = await deps.loadBotConfigAndKeys(payload.ownerId, payload.botId);
    if (!loaded) {
      const schedules = deps.getSchedules<CronJobPayload>()
        .filter((s) => s.callback === "onCronJob");
      log.warn("BotConfig not found for cron job, cleaning up orphaned schedules", {
        orphanCount: schedules.length,
      });
      await Promise.all(schedules.map((s) => deps.cancelSchedule(s.id)));
      return;
    }
    let { botConfig } = loaded;
    const { userKeys } = loaded;

    // 2. Resolve channel token: prefer bot's own token over the one stored in payload
    const resolvedToken = botConfig.channels[payload.channel]?.token || payload.channelToken;

    // 3. Create model
    const model = createModel(botConfig, userKeys);

    // 4. Load skill secrets for enabled skills
    const { flat: skillSecrets, perSkill: perSkillSecrets } = await configDb.getSkillSecretsForBot(
      deps.db, botConfig.ownerId, botConfig.enabledSkills,
    );

    // 5. Build all tools (use local scheduler to avoid self-fetch deadlock)
    const cronBuildResult = await deps.buildAgentTools({
      env: deps.env,
      db: deps.db,
      botConfig, userKeys,
      channel: payload.channel,
      chatId: payload.chatId,
      channelToken: resolvedToken,
      enableMessageTool: true,
      localCronScheduler: true,
      log,
      skillSecrets,
      getSandboxClient: deps.getSandboxClient,
      buildLocalCronScheduler: deps.buildLocalCronScheduler,
      buildRemoteCronScheduler: deps.buildRemoteCronScheduler,
      ensureMcpConnected: deps.ensureMcpConnected,
      getMcpTools: deps.getMcpTools,
      sendChannelMessage: deps.sendChannelMessage,
      sendChannelAudio: deps.sendChannelAudio,
      dispatchGroupOrchestrator: deps.dispatchGroupOrchestrator,
    });
    const { tools, sandboxClient, groupVoiceSentRef } = cronBuildResult;
    botConfig = cronBuildResult.botConfig;

    // 6. Determine session ID for this cron job
    // Use cronSessionId for tz-cron chained one-shots, otherwise use scheduleId
    const sessionId =
      payload.cronSessionId ??
      (payload.scheduleId ? `cron-${payload.scheduleId}` : `cron-${Date.now()}`);

    // Ensure session exists in D1
    await d1.ensureSessionExists(deps.db, {
      channel: payload.channel,
      chatId: payload.chatId,
      botId: botConfig.botId,
    }, sessionId);

    // 8. Build system prompt and load conversation history
    const { systemPrompt, conversationHistory } = await deps.buildPromptAndHistory({
      db: deps.db,
      assetsBucket: deps.env.ASSETS_BUCKET,
      botConfig, sessionId,
      channel: payload.channel,
      chatId: payload.chatId,
      perSkillSecrets,
    });

    // 9. Start typing indicator
    const typingAbort = new AbortController();
    deps.startTypingLoop(
      payload.channel,
      resolvedToken,
      payload.chatId,
      typingAbort.signal
    );

    // 8. Run agent loop (no onProgress -- tool hints should not be sent to channel)
    const groupHint = tools.send_to_group
      ? " If the task mentions sharing to a group, use the send_to_group tool."
      : "";
    const userMessage = `[System] This is your scheduled task. Execute it in your own style.${groupHint} Task: ${payload.message}`;
    let result: Awaited<ReturnType<typeof runAgentLoop>>;
    try {
      result = await runAgentLoop({
        model,
        systemPrompt,
        userMessage,
        conversationHistory,
        tools,
        maxIterations: botConfig.maxIterations,
        log,
        botId: botConfig.botId,
        requestId: log.requestId,
        abortSignal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        contextWindowTokens: botConfig.contextWindow,
      });
    } finally {
      // Stop typing indicator -- must run even if runAgentLoop throws
      typingAbort.abort();
    }

    // 10. Normalize reply BEFORE persistence
    const { normalizedText, attachments, media } = await resolveAndNormalizeReply({
      reply: result.reply,
      toolResults: result.toolResults,
      newMessages: result.newMessages,
      sandboxClient,
      botId: botConfig.botId,
      baseUrl: deps.env.BASE_URL,
      webhookSecret: deps.env.WEBHOOK_SECRET,
    });

    // Detect whether the bot already delivered via send_to_group
    const sentToGroup = result.newMessages.some(
      (m) => m.role === "tool" && m.toolName === "send_to_group" && m.content?.startsWith("Message sent to group"),
    );

    // Always persist all assistant messages (including trailing text after send_to_group).
    // The trailing text closes the tool-call/result cycle in persisted history — removing it
    // would leave the session ending at a synthetic tool-result, causing providers like Gemini
    // to reject the next request with a message-ordering error.
    // Delivery suppression (not sending to channel) is handled separately below.

    // NOW persist (after normalization)
    await d1.persistUserMessage(deps.db, sessionId, userMessage, log.requestId);
    await d1.persistMessages(deps.db, sessionId, result.newMessages);

    if (normalizedText || media.length > 0) {

      // Only send to the cron's chatId if agent didn't already send via send_to_group
      if (!sentToGroup) {
        const { sendFinalReply, buildTtsPolicy } = await import("../voice/send-reply");
        const replyResult = await sendFinalReply(
          {
            text: normalizedText,
            media: media.length > 0 ? media : undefined,
            channelToken: resolvedToken,
            chatId: payload.chatId,
            ttsPolicy: buildTtsPolicy(botConfig, userKeys),
            isVoiceMessage: false,
          },
          {
            sendMessage: (tok, cid, txt, opts) => deps.sendChannelMessage(payload.channel, tok, cid, txt, opts),
            sendAudio: deps.sendChannelAudio
              ? (tok, cid, audio, opts) => deps.sendChannelAudio!(payload.channel, tok, cid, audio, opts)
              : undefined,
          },
        );
        voiceSent = replyResult.voiceSent;
      }

      // When send_to_group handled delivery, read the actual voiceSent result from the shared ref.
      if (sentToGroup && groupVoiceSentRef.value) {
        voiceSent = true;
      }

      // 10b. If cron sent to a group chat, persist reply to group session + trigger orchestrator
      try {
        const matchedGroups = await persistCronReplyToGroupSession({
          db: deps.env.D1_DB,
          ownerId: payload.ownerId,
          botId: botConfig.botId,
          channel: payload.channel,
          chatId: payload.chatId,
          reply: normalizedText,
          attachments: attachmentsToJson(attachments),
          requestId: log.requestId,
          findAllGroupsForBot: configDb.findAllGroupsForBot,
          getOrCreateSession: d1.getOrCreateSession,
          persistMessages: d1.persistMessages,
        });

        // Trigger orchestrator so other bots can respond to the cron message
        for (const { groupId, chatId: groupChatId } of matchedGroups) {
          deps.dispatchGroupOrchestrator({
            channel: payload.channel,
            token: resolvedToken,
            ownerId: payload.ownerId,
            groupId,
            chatId: groupChatId,
            senderBotId: botConfig.botId,
            senderBotName: botConfig.name,
            message: normalizedText,
            parentRequestId: log.requestId,
          });
        }
      } catch (err) {
        log.warn("Failed to persist cron reply to group session", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // 11. Re-schedule next occurrence for timezone-aware cron
    if (payload.cronExpr && payload.tz) {
      const nextDate = getNextCronDateInTimezone(payload.cronExpr, payload.tz);
      if (nextDate) {
        await deps.schedule(
          nextDate,
          "onCronJob",
          {
            ...payload,
            // Keep the same cronSessionId for chained one-shots
          }
        );
      } else {
        log.error("Failed to compute next tz-cron date", {
          cronExpr: payload.cronExpr,
          tz: payload.tz,
        });
      }
    }

    // 12. Flush request trace to R2
    if (deps.env.LOG_BUCKET && log.requestId) {
      const trace: RequestTrace = {
        requestId: log.requestId,
        botId: botConfig.botId,
        botName: botConfig.name,
        channel: payload.channel,
        chatId: payload.chatId,
        sessionId,
        status: "ok",
        startedAt: cronStartedAt,
        durationMs: Date.now() - cronStartedAt,
        model: result.model,
        llmCalls: result.iterations,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        skillCalls: result.skillCalls,
        iterations: result.iterations,
        voiceSent,
        userMessage: payload.message?.slice(0, 200),
        reply: normalizedText?.slice(0, 200),
      };
      await log.flush(deps.env.LOG_BUCKET, trace, deps.env.D1_DB);
    }

    log.info("Cron job completed");
  } catch (error) {
    log.error("Cron job failed", {
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    if (deps.env.LOG_BUCKET && log.requestId) {
      const trace: RequestTrace = {
        requestId: log.requestId,
        botId: payload.botId,
        channel: payload.channel, chatId: payload.chatId,
        status: "error",
        startedAt: cronStartedAt, durationMs: Date.now() - cronStartedAt,
        llmCalls: 0, inputTokens: 0, outputTokens: 0,
        skillCalls: [], iterations: 0,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        userMessage: payload.message?.slice(0, 200),
      };
      await log.flush(deps.env.LOG_BUCKET, trace, deps.env.D1_DB);
    }
    try {
      await deps.sendChannelMessage(
        payload.channel,
        payload.channelToken,
        payload.chatId,
        `Scheduled task failed: ${payload.message}`
      );
    } catch (e) {
      // Ignore notification errors
      console.warn("[cron] Failed to send error notification:", e);
    }
  }
}

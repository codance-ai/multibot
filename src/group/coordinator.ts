import { DurableObject } from "cloudflare:workers";
import { getAgentByName } from "agents";
import type { Env, AgentRequestPayload, BotConfig, UserKeys, GroupContext, InputMeta } from "../config/schema";
import * as configDb from "../db/config";
import * as d1 from "../db/d1";
import { createModel, DEFAULT_MODELS } from "../providers/gateway";
import { getAdapter } from "../channels/registry";
import type { AttachmentRef, SenderOptions } from "../channels/registry";
import { getAttachmentMetadataText } from "../utils/attachment-resolve";
import { createLogger } from "../utils/logger";
import type { RequestTrace } from "../utils/logger";
import type { MultibotAgent } from "../agent/multibot";
import { isSkipReply } from "./utils";
import { transcribeFromR2 } from "../voice/stt";
import {
  buildAttachmentFallbackPrompt, buildOrchestratorPrompt, buildContinuePrompt,
  parseMentions, resolveExplicitMentions, MAX_ROUNDS,
} from "./handler";
import type { GroupChatTrace } from "./handler";
import { TurnSerializer, EpochTracker, tryFastDispatch, fallbackDispatch, applyContinueGuard, pickNextParentRequestId, GROUP_BOT_TIMEOUT_MS, ORCHESTRATOR_TIMEOUT_MS, MAX_BOT_REPLIES_PER_TURN, TURN_DEADLINE_MS } from "./coordinator-utils";
import { callBot, buildSenderMeta, getSendTokenForBot } from "./coordinator-bot-call";
import type { BotCallResult, BotCallTrace } from "./coordinator-bot-call";
import { callOrchestratorDispatch, callOrchestratorContinue } from "./coordinator-llm";
import type { LanguageModel } from "ai";

/** Shared parameters for callBot across all rounds (everything except per-call fields). */
type CallBotSharedParams = Pick<
  Parameters<typeof callBot>[0],
  "env" | "userKeys" | "groupId" | "groupConfig" | "members" |
  "channel" | "chatId" | "userId" | "userName" | "channelToken" |
  "sessionId" | "isVoiceMessage" | "inputMeta" | "log" | "traceBotCalls"
>;

export { TurnSerializer, EpochTracker, tryFastDispatch, fallbackDispatch, applyContinueGuard, pickNextParentRequestId, GROUP_BOT_TIMEOUT_MS, ORCHESTRATOR_TIMEOUT_MS, MAX_BOT_REPLIES_PER_TURN, TURN_DEADLINE_MS } from "./coordinator-utils";

export interface IncomingTurnMessage {
  channel: string;
  token: string;
  ownerId: string;
  groupId: string;
  chatId: string;
  userId: string;
  userName: string;
  userMessage: string;
  parentRequestId?: string;
  isBotMessage?: boolean;
  senderBotId?: string;
  attachments?: AttachmentRef[];
  channelMentions?: string[];
  /** Reply-to name from channel (first_name or username), resolved to botId in coordinator */
  replyToName?: string;
  /** Channel-specific message ID for webhook retry dedup */
  messageId?: string;
  isVoiceMessage?: boolean;
}

export class ChatCoordinator extends DurableObject<Env> {
  private serializer = new TurnSerializer();
  private epoch = new EpochTracker();
  private lastDedupCleanup = 0;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/turn") {
      const data = await request.json() as IncomingTurnMessage;

      // Webhook retry dedup: check BEFORE epoch.bump() to avoid
      // invalidating an in-progress turn with a duplicate request.
      // Uses DO SQLite storage so dedup survives DO eviction/restart.
      if (data.messageId) {
        const key = `dedup:${data.messageId}`;
        const existing = await this.ctx.storage.get<number>(key);
        if (existing) {
          return new Response("OK");
        }
        await this.ctx.storage.put(key, Date.now());
        // Opportunistic cleanup: delete expired entries (non-blocking, throttled to every 5 min)
        const now = Date.now();
        if (now - this.lastDedupCleanup > 5 * 60 * 1000) {
          this.lastDedupCleanup = now;
          this.ctx.waitUntil(this.cleanupDedup());
        }
      }

      // Bump epoch BEFORE enqueue — so a new request arriving while a turn
      // is in-flight immediately invalidates the running turn's epoch snapshot.
      const epoch = this.epoch.bump();
      // Fire-and-forget: return immediately so the caller's waitUntil() doesn't
      // cancel the DO fetch. Use this.ctx.waitUntil() to keep the DO alive.
      this.ctx.waitUntil(
        this.serializer.enqueue(() =>
          this.executeTurn(data as IncomingTurnMessage, epoch),
        ),
      );
      return new Response("OK");
    }
    return new Response("Not Found", { status: 404 });
  }

  // ---------------------------------------------------------------------------
  // Core orchestration logic — migrated from processGroupChat() in handler.ts
  // Key differences:
  //   - Epoch fencing replaces hasNewUserMessage() stale guards
  //   - Coordinator owns persistence (coordinatorOwned: true, d1.persistMessages)
  //   - No cue injection for wave 2+ bots (they read D1 history)
  //   - 60s bot timeout (GROUP_BOT_TIMEOUT_MS), dynamic via remaining turn budget
  //   - Orchestrator LLM call wrapped in try/catch with fallbackDispatch()
  //   - Persist-then-send pattern
  // ---------------------------------------------------------------------------

  private async executeTurn(
    msg: IncomingTurnMessage,
    epoch: number,
  ): Promise<void> {
    const {
      channel, token, ownerId, groupId, chatId,
      userId, userName, userMessage, parentRequestId,
      isBotMessage, senderBotId, attachments,
    } = msg;

    const log = createLogger({ groupId, channel, chatId, parentRequestId });
    const traceDecisions: GroupChatTrace["decisions"] = [];
    const traceBotCalls: BotCallTrace[] = [];
    let orchestratorInputTokens = 0;
    let orchestratorOutputTokens = 0;
    const orchStart = performance.now();
    const channelToken = token;
    try {
      // 1. Load GroupConfig from D1
      const groupConfig = await configDb.getGroup(this.env.D1_DB, ownerId, groupId);
      if (!groupConfig) {
        log.error("Group not found");
        return;
      }

      // 2. Load all BotConfigs + UserKeys from D1 in parallel
      const [botConfigResults, userKeys] = await Promise.all([
        Promise.all(groupConfig.botIds.map(id => configDb.getBot(this.env.D1_DB, ownerId, id))),
        configDb.getUserKeys(this.env.D1_DB, ownerId),
      ]);
      const botConfigs = botConfigResults.filter((b): b is BotConfig => b !== null);

      // Lazy refresh: backfill channel identity for bots bound before this feature
      const botsNeedingIdentity = botConfigs.filter(b => {
        const binding = b.channels[channel];
        return binding && !binding.channelUsername && !binding.channelUserId;
      });
      if (botsNeedingIdentity.length > 0) {
        // If there are channel mentions to resolve, await refresh so resolution works on first turn
        if (msg.channelMentions && msg.channelMentions.length > 0) {
          await this.refreshBotIdentities(botsNeedingIdentity, channel).catch((e) => console.warn("[identity] refreshBotIdentities failed:", e));
          // Re-read updated configs so resolveExplicitMentions sees the new identity
          const refreshed = await Promise.all(
            botsNeedingIdentity.map(b => configDb.getBot(this.env.D1_DB, b.ownerId, b.botId)),
          );
          for (const updated of refreshed) {
            if (!updated) continue;
            const idx = botConfigs.findIndex(b => b.botId === updated.botId);
            if (idx >= 0) botConfigs[idx] = updated;
          }
        } else {
          this.ctx.waitUntil(
            this.refreshBotIdentities(botsNeedingIdentity, channel).catch((e) => console.warn("[identity] refreshBotIdentities failed:", e))
          );
        }
      }

      if (botConfigs.length === 0) {
        const adapter = getAdapter(channel);
        if (adapter) await adapter.sendMessage(channelToken, chatId, "No bots available in this group.");
        return;
      }

      if (!userKeys) {
        log.error("API keys not configured");
        const adapter = getAdapter(channel);
        if (adapter) await adapter.sendMessage(channelToken, chatId, "API keys not configured. Please add your API keys in Settings.");
        return;
      }

      // 3. Handle /new command
      const sessionCtx = { channel, chatId, groupId };
      if (/^\/new(@\S+)?$/i.test(userMessage.trim())) {
        const adapter = getAdapter(channel);
        const oldSessionId = await d1.getOrCreateSession(this.env.D1_DB, sessionCtx);
        await d1.createNewSession(this.env.D1_DB, sessionCtx);

        const consolidationResults = await Promise.allSettled(
          botConfigs.map(async (botConfig) => {
            const agentId = `gchat-${groupId}-${botConfig.botId}-${channel}-${chatId}`;
            const agent = await getAgentByName<Env, MultibotAgent>(
              this.env.MULTIBOT_AGENT,
              agentId,
            );
            const payload: AgentRequestPayload = {
              botConfig,
              userKeys,
              chatId,
              userId,
              userName,
              userMessage: "/new",
              channel,
              channelToken,
              sessionId: oldSessionId,
            };
            const req = new Request("https://agent/group-chat", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload),
            });
            await agent.fetch(req);
          }),
        );
        for (const r of consolidationResults) {
          if (r.status === "rejected") {
            log.error("Bot /new failed", { error: String(r.reason) });
          }
        }
        if (adapter) {
          await adapter.sendMessage(channelToken, chatId, "New session started for all bots.");
        }
        return;
      }

      // 4. Get or create the shared session and persist user message
      const sessionId = await d1.getOrCreateSession(this.env.D1_DB, sessionCtx);
      if (!isBotMessage) {
        // Build effectiveUserMessage with attachment metadata (same as private chat)
        // so unsupported/oversized file info is preserved in D1 history.
        // Note: this is for D1 only; each bot rebuilds its own effectiveUserMessage
        // from resolveAttachmentsForLLM() for the LLM current-turn.
        let effectiveUserMessage = userMessage;
        if (attachments?.length) {
          const metadataText = getAttachmentMetadataText(attachments);
          if (metadataText) {
            effectiveUserMessage = `${userMessage}\n\n${metadataText}`;
          }
        }
        await d1.persistUserMessage(this.env.D1_DB, sessionId, effectiveUserMessage, log.requestId, attachments);
      }

      // STT: transcribe voice message once for all group bots
      let sttUserMessage = userMessage; // mutable copy for STT
      let inputMeta: InputMeta | undefined;
      if (msg.isVoiceMessage && attachments?.length && this.env.AI && this.env.ASSETS_BUCKET) {
        const anySttEnabled = botConfigs.some(b => b.sttEnabled);
        if (anySttEnabled) {
          const audioRef = attachments.find(a => a.mediaType.startsWith("audio/"));
          if (audioRef) {
            const sttResult = await transcribeFromR2(this.env.AI, this.env.ASSETS_BUCKET, audioRef);
            if ("text" in sttResult) {
              sttUserMessage = userMessage
                ? `${userMessage}\n\n[Voice transcript]: ${sttResult.text}`
                : sttResult.text;
              inputMeta = { mode: "voice", sttStatus: "success" };
              log.info("STT transcription success", { textLength: sttResult.text.length });
            } else {
              inputMeta = { mode: "voice", sttStatus: "failed" };
              log.warn("STT transcription failed", { error: sttResult.error });
            }
          } else {
            inputMeta = { mode: "voice", sttStatus: "failed" };
            log.warn("STT skipped: voice message but no audio attachment in R2");
          }
        }
      } else if (msg.isVoiceMessage) {
        // Voice message but STT prerequisites not met (no AI binding, no R2, no attachments)
        inputMeta = { mode: "voice", sttStatus: "failed" };
      }

      // 4b. Single-bot group: skip orchestrator entirely — direct bot call
      if (botConfigs.length === 1) {
        const bot = botConfigs[0];

        // Sender is the only bot → no one can respond
        if (isBotMessage && senderBotId === bot.botId) {
          log.info("Single-bot group: sender is the only bot, skipping");
          return;
        }

        log.info("Single-bot group bypass", { botName: bot.name, botId: bot.botId });
        const singleMembers: GroupContext["members"] = [{ botId: bot.botId, botName: bot.name }];
        const singleTraceBotCalls: BotCallTrace[] = [];
        const singleAdapter = getAdapter(channel);

        const result = await callBot({
          env: this.env,
          botConfig: bot,
          userKeys,
          groupId,
          groupConfig,
          members: singleMembers,
          channel,
          chatId,
          userId,
          userName,
          channelToken,
          sessionId,
          userMessage: sttUserMessage,
          round: 1,
          attachments,
          ...(msg.isVoiceMessage && { isVoiceMessage: true }),
          ...(inputMeta && { inputMeta }),
          log,
          traceBotCalls: singleTraceBotCalls,
        });

        if (!isSkipReply(result.reply) || result.media.length > 0) {
          const { voiceSent } = await this.persistAndSend(result, {
            sessionId, botConfigs: [bot], channel, channelToken, chatId,
            channelAdapter: singleAdapter, log,
            userKeys, isVoiceMessage: msg.isVoiceMessage, inputMeta,
          });
          // Record voiceSent on the bot's trace entry
          const traceEntry = singleTraceBotCalls.findLast(bc => bc.botId === bot.botId);
          if (traceEntry) traceEntry.voiceSent = voiceSent;
        }

        // Flush trace
        const singleDuration = Math.round(performance.now() - orchStart);
        if (this.env.LOG_BUCKET && log.requestId) {
          const trace: RequestTrace = {
            requestId: log.requestId,
            parentRequestId,
            botId: bot.botId,
            botName: bot.name,
            channel,
            chatId,
            status: "ok",
            startedAt: Date.now() - singleDuration,
            durationMs: singleDuration,
            llmCalls: 0,
            inputTokens: singleTraceBotCalls.reduce((s, bc) => s + (bc.inputTokens ?? 0), 0),
            outputTokens: singleTraceBotCalls.reduce((s, bc) => s + (bc.outputTokens ?? 0), 0),
            skillCalls: singleTraceBotCalls.flatMap(bc => bc.skillCalls ?? []),
            iterations: 1,
            userMessage: userMessage?.slice(0, 200),
            botCalls: singleTraceBotCalls,
          };
          this.ctx.waitUntil(log.flush(this.env.LOG_BUCKET, trace, this.env.D1_DB).catch((e) => {
            console.error("Failed to flush single-bot trace to R2:", e);
          }));
        }
        return;
      }

      // 5. Resolve explicit mentions from structured channel data
      // Only fall back to text matching when channelMentions is undefined (legacy sender)
      let mentionedNames = msg.channelMentions !== undefined
        ? resolveExplicitMentions(msg.channelMentions, botConfigs, channel)
        : parseMentions(userMessage, botConfigs.map(b => b.name));

      // Reply target fallback: when no explicit mentions, the reply target should respond
      // Resolve replyToName (channel first_name/username) to a bot in-memory — no extra D1 reads
      if (mentionedNames.length === 0 && msg.replyToName) {
        const replyBot = botConfigs.find(b => {
          if (b.name === msg.replyToName) return true;
          const binding = b.channels[channel];
          if (binding?.channelUsername) {
            const username = binding.channelUsername.replace(/^@/, "");
            if (username.toLowerCase() === msg.replyToName!.toLowerCase()) return true;
          }
          return false;
        });
        if (replyBot) mentionedNames = [replyBot.name];
      }

      // 6. Build orchestrator model
      const orchestratorModel = await this.buildOrchestratorModel(groupConfig, userKeys, channel, channelToken, chatId);
      if (!orchestratorModel) return;

      // 7. Build group context
      const members: GroupContext["members"] = botConfigs.map(b => ({
        botId: b.botId,
        botName: b.name,
      }));
      const botsForOrchestrator = botConfigs.map(b => ({
        name: b.name,
        persona: b.soul.slice(0, 500),
        channelId: b.channels[channel]?.channelUsername ?? b.channels[channel]?.channelUserId,
      }));
      const botsForDispatch = botConfigs.map(b => ({ name: b.name, botId: b.botId }));
      const senderKind: "member" | "external" = isBotMessage && botConfigs.some(b => b.botId === senderBotId) ? "member" : "external";

      // 8. Load recent conversation history for orchestrator context
      let recentHistory = "";
      try {
        const recentMessages = await d1.getRecentMessages(this.env.D1_DB, sessionId, 10);
        if (recentMessages.length > 0) {
          recentHistory = recentMessages.map(m => {
            let name: string;
            if (m.role === "assistant" && m.bot_id) {
              const member = members.find(mb => mb.botId === m.bot_id);
              name = member?.botName ?? m.bot_id;
            } else {
              name = userName;
            }
            return `[${name}]: ${(m.content ?? "").slice(0, 200)}`;
          }).join("\n");
        }
      } catch (e) {
        log.warn("Failed to load orchestrator history (non-fatal)", {
          error: e instanceof Error ? e.message : String(e),
        });
      }

      // 9. Dispatch: fast-path for deterministic cases, LLM for ambiguous ones
      const orchestratorPrompt = userMessage.trim().length > 0
        ? userMessage
        : attachments?.length
          ? buildAttachmentFallbackPrompt(userName, attachments.length)
          : userMessage;

      let waves: string[][];
      let usedFastPath = false;

      // Fast-path: skip LLM dispatch when the routing decision is obvious
      const fastPathWaves = tryFastDispatch(botsForDispatch, mentionedNames, senderBotId);
      if (fastPathWaves) {
        waves = fastPathWaves;
        usedFastPath = true;
        traceDecisions.push({
          round: 1,
          respondents: waves,
          reasoning: "[fast-path] deterministic dispatch — skipped LLM",
          orchestratorDurationMs: 0,
        });
        log.info("Fast-path dispatch", { round: 1, waves, reasoning: "[fast-path] deterministic dispatch — skipped LLM", orchestratorDurationMs: 0, mentionedNames });
      } else {
        const firstPrompt = buildOrchestratorPrompt(groupConfig.name, botsForOrchestrator, mentionedNames, recentHistory || undefined, userName, senderKind);

        const dispatchResult = await callOrchestratorDispatch({
          model: orchestratorModel,
          systemPrompt: firstPrompt,
          userPrompt: orchestratorPrompt,
          botConfigs: botsForDispatch,
          mentionedNames,
          senderBotId,
          log,
        });
        waves = dispatchResult.waves;
        traceDecisions.push(dispatchResult.traceDecision);
        orchestratorInputTokens += dispatchResult.inputTokens;
        orchestratorOutputTokens += dispatchResult.outputTokens;

        // Final fallback if empty
        if (waves.length === 0 || waves.every(w => w.length === 0)) {
          waves = fallbackDispatch(botsForDispatch, mentionedNames, waves, senderBotId);
        }
      }

      const channelAdapter = getAdapter(channel);

      // 10. Execute Round 1 waves
      const allReplies: { round: number; botName: string; botId: string; reply: string; imageCount: number }[] = [];
      const botReplyCount = new Map<string, number>();
      const callBotShared = {
        env: this.env,
        userKeys,
        groupId,
        groupConfig,
        members,
        channel,
        chatId,
        userId,
        userName,
        channelToken,
        sessionId,
        ...(msg.isVoiceMessage && { isVoiceMessage: true as const }),
        ...(inputMeta && { inputMeta }),
        log,
        traceBotCalls,
      };

      const waveResult = await this.executeWaves(waves, {
        epoch, botConfigs, callBotShared, userMessage: sttUserMessage, attachments,
        sessionId, channel, channelToken, chatId, channelAdapter,
        allReplies, botReplyCount, log,
        userKeys, isVoiceMessage: msg.isVoiceMessage, inputMeta,
        turnStart: orchStart,
      });

      // 10b. Fallback: if all bot calls failed (not skipped, not stale epoch), notify the user
      if (allReplies.length === 0 && waveResult.hadBotError && !this.epoch.isStale(epoch)) {
        log.warn("All bot calls failed in round 1, sending fallback to user");
        try {
          if (channelAdapter) {
            await channelAdapter.sendMessage(channelToken, chatId, "Sorry, the bot couldn't process your message. Please try again.");
          }
        } catch (e) {
          log.error("Failed to send fallback message", { error: String(e) });
        }
      }

      // 11. Continue loop (rounds 2+)
      const continueLoopResult = await this.executeContinueLoop({
        epoch, startRound: 2,
        orchestratorModel, orchestratorPrompt,
        groupConfig, botsForOrchestrator, botConfigs,
        callBotShared, userMessage: sttUserMessage, attachments,
        sessionId, channel, channelToken, chatId, channelAdapter,
        allReplies, botReplyCount, traceDecisions, log,
        userName, senderKind,
        lastParentRequestId: waveResult.lastParentRequestId,
        userKeys, isVoiceMessage: msg.isVoiceMessage, inputMeta,
        turnStart: orchStart,
      });
      const round = continueLoopResult.round;
      orchestratorInputTokens += continueLoopResult.orchestratorInputTokens;
      orchestratorOutputTokens += continueLoopResult.orchestratorOutputTokens;

      // Flush orchestrator trace to R2
      const orchDuration = Math.round(performance.now() - orchStart);
      if (this.env.LOG_BUCKET && log.requestId) {
        const trace: RequestTrace = {
          requestId: log.requestId,
          parentRequestId,
          botId: `orchestrator:${groupId}`,
          botName: `group:${groupId}`,
          channel,
          chatId,
          status: "ok",
          startedAt: Date.now() - orchDuration,
          durationMs: orchDuration,
          llmCalls: traceDecisions.length,
          inputTokens: traceBotCalls.reduce((s, bc) => s + (bc.inputTokens ?? 0), 0) + orchestratorInputTokens,
          outputTokens: traceBotCalls.reduce((s, bc) => s + (bc.outputTokens ?? 0), 0) + orchestratorOutputTokens,
          skillCalls: traceBotCalls.flatMap(bc => bc.skillCalls ?? []),
          iterations: round - 1,
          userMessage: userMessage?.slice(0, 200),
          botCalls: traceBotCalls,
        };
        this.ctx.waitUntil(log.flush(this.env.LOG_BUCKET, trace, this.env.D1_DB).catch((e) => {
          console.error("Failed to flush orchestrator trace to R2:", e);
        }));
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      log.error("executeTurn failed", {
        error: errMsg,
        stack: e instanceof Error ? e.stack : undefined,
      });

      // Flush error trace to R2
      const orchDuration = Math.round(performance.now() - orchStart);
      if (this.env.LOG_BUCKET) {
        const trace: RequestTrace = {
          requestId: log.requestId!,
          parentRequestId,
          botId: `orchestrator:${groupId}`,
          botName: `group:${groupId}`,
          channel,
          chatId,
          status: "error",
          startedAt: Date.now() - orchDuration,
          durationMs: orchDuration,
          llmCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          skillCalls: [],
          iterations: 0,
          errorMessage: errMsg,
          errorStack: e instanceof Error ? e.stack : undefined,
          userMessage: userMessage?.slice(0, 200),
        };
        this.ctx.waitUntil(log.flush(this.env.LOG_BUCKET, trace, this.env.D1_DB).catch((e) => {
          console.error("Failed to flush orchestrator error trace to R2:", e);
        }));
      }

      // Try to send error to channel
      try {
        const adapter = getAdapter(channel);
        if (adapter) {
          await adapter.sendMessage(channelToken, chatId, "Sorry, something went wrong processing your message.");
        }
      } catch (e) {
        // Ignore notification errors
        console.warn("[coordinator] Failed to send error to channel:", e);
      }
    } finally {
      // Typing is now managed by individual bots — no coordinator cleanup needed
    }
  }

  // ---------------------------------------------------------------------------
  // Extracted sub-methods — pure refactoring, no behavior changes
  // ---------------------------------------------------------------------------

  /**
   * Persist bot reply to D1 and send to channel in parallel.
   * Deduplicates the pattern used in single-bot, round 1 waves, and continue loop.
   */
  private async persistAndSend(
    result: BotCallResult,
    opts: {
      sessionId: string;
      botConfigs: BotConfig[];
      channel: string;
      channelToken: string;
      chatId: string;
      channelAdapter: ReturnType<typeof getAdapter>;
      log: ReturnType<typeof createLogger>;
      // Voice context
      userKeys?: UserKeys;
      isVoiceMessage?: boolean;
      inputMeta?: InputMeta;
    },
  ): Promise<{ voiceSent: boolean }> {
    let voiceSent = false;
    const persistP = result.newMessages?.length
      ? d1.persistMessages(this.env.D1_DB, opts.sessionId, result.newMessages)
      : undefined;
    const sendP = opts.channelAdapter
      ? (async () => {
          try {
            const sendToken = getSendTokenForBot(result.botName, opts.botConfigs, opts.channel, opts.channelToken);
            const meta = buildSenderMeta(result.botName, opts.botConfigs);
            const senderOptions: SenderOptions = { meta };

            if (opts.userKeys) {
              const { sendFinalReply, buildTtsPolicy } = await import("../voice/send-reply");
              const respondingBot = opts.botConfigs.find(b => b.name === result.botName);
              const ttsPolicy = respondingBot
                ? buildTtsPolicy(respondingBot, opts.userKeys)
                : { ttsProvider: "fish" as const, voiceMode: "off" as const, ttsVoice: "", ttsModel: "s2-pro", apiKey: undefined };

              const replyResult = await sendFinalReply(
                {
                  text: result.reply,
                  media: result.media && result.media.length > 0 ? result.media : undefined,
                  channelToken: sendToken,
                  chatId: opts.chatId,
                  ttsPolicy,
                  isVoiceMessage: !!opts.isVoiceMessage,
                  sttFailed: opts.inputMeta?.sttStatus === "failed",
                  senderOptions,
                },
                {
                  sendMessage: (tok, cid, txt, sendOpts) => opts.channelAdapter!.sendMessage(tok, cid, txt, sendOpts),
                  sendAudio: opts.channelAdapter!.sendAudio?.bind(opts.channelAdapter!),
                },
              );
              if (replyResult.voiceSent) voiceSent = true;
            } else {
              // Fallback: no userKeys, just send text
              await opts.channelAdapter!.sendMessage(
                sendToken, opts.chatId, result.reply, {
                  ...senderOptions,
                  ...(result.media && result.media.length > 0 && { media: result.media }),
                },
              );
            }
          } catch (e) {
            opts.log.error("Send failed", { botName: result.botName, error: String(e) });
          }
        })()
      : undefined;
    await Promise.all([persistP, sendP].filter(Boolean));
    return { voiceSent };
  }

  /**
   * Build orchestrator LanguageModel from group config + user keys.
   * Returns null (after sending error to channel) if required API key is missing.
   */
  private async buildOrchestratorModel(
    groupConfig: { orchestratorProvider?: string; orchestratorModel?: string },
    userKeys: UserKeys,
    channel: string,
    channelToken: string,
    chatId: string,
  ): Promise<LanguageModel | null> {
    const orchestratorProvider = groupConfig.orchestratorProvider ?? "anthropic";
    const orchestratorModelId = groupConfig.orchestratorModel ?? DEFAULT_MODELS[orchestratorProvider] ?? "claude-sonnet-4-6";
    if (!userKeys[orchestratorProvider as keyof typeof userKeys]) {
      const adapter = getAdapter(channel);
      const providerLabel = orchestratorProvider.charAt(0).toUpperCase() + orchestratorProvider.slice(1);
      if (adapter) await adapter.sendMessage(channelToken, chatId, `Group chat requires a ${providerLabel} API key. Please configure it in Settings.`);
      return null;
    }
    return createModel({ provider: orchestratorProvider, model: orchestratorModelId }, userKeys);
  }

  /**
   * Execute round 1 wave loop: call bots in waves, persist + send results.
   */
  private async executeWaves(
    waves: string[][],
    opts: {
      epoch: number;
      botConfigs: BotConfig[];
      callBotShared: CallBotSharedParams;
      userMessage: string;
      attachments?: AttachmentRef[];
      sessionId: string;
      channel: string;
      channelToken: string;
      chatId: string;
      channelAdapter: ReturnType<typeof getAdapter>;
      allReplies: { round: number; botName: string; botId: string; reply: string; imageCount: number }[];
      botReplyCount: Map<string, number>;
      log: ReturnType<typeof createLogger>;
      // Voice context
      userKeys?: UserKeys;
      isVoiceMessage?: boolean;
      inputMeta?: InputMeta;
      turnStart: number;
    },
  ): Promise<{ lastParentRequestId: string | undefined; hadBotError: boolean }> {
    let waveParentRequestId: string | undefined;
    let hadBotError = false;
    for (let waveIdx = 0; waveIdx < waves.length; waveIdx++) {
      if (this.epoch.isStale(opts.epoch)) {
        opts.log.info("epoch_stale", { round: 1, wave: waveIdx + 1, phase: "pre_wave" });
        break;
      }

      // Budget check: skip wave if not enough time for a bot call
      const elapsed = performance.now() - opts.turnStart;
      const remaining = TURN_DEADLINE_MS - elapsed;
      if (remaining < 15_000) {
        opts.log.warn("Turn deadline approaching, skipping remaining waves", { elapsed: Math.round(elapsed), remaining: Math.round(remaining) });
        break;
      }

      const waveNum = waveIdx + 1;
      const waveNames = waves[waveIdx];
      const waveBots = opts.botConfigs.filter(b => waveNames.includes(b.name));

      // Dynamic per-bot timeout: fit within remaining turn budget
      const botTimeout = Math.min(GROUP_BOT_TIMEOUT_MS, remaining - 5_000);

      // Eager: each bot calls + persistAndSend immediately on completion.
      // Indexed slots preserve wave-declared order for allReplies.
      const slots: (BotCallResult | null)[] = new Array(waveBots.length).fill(null);

      await Promise.allSettled(
        waveBots.map(async (b, idx) => {
          try {
            const result = await callBot({
              ...opts.callBotShared,
              botConfig: b,
              userMessage: opts.userMessage,
              round: 1,
              wave: waveNum,
              attachments: opts.attachments,
              parentRequestId: waveParentRequestId,
              timeoutMs: botTimeout,
            });

            if (isSkipReply(result.reply) && result.media.length === 0) {
              opts.log.info("Bot skipped", { round: 1, wave: waveNum, botName: result.botName });
              return;
            }

            slots[idx] = result;
            const { voiceSent } = await this.persistAndSend(result, opts);
            const traceEntry = opts.callBotShared.traceBotCalls.findLast(bc => bc.botId === result.botId);
            if (traceEntry) traceEntry.voiceSent = voiceSent;
          } catch (e) {
            hadBotError = true;
            opts.log.error("Bot call failed", { round: 1, wave: waveNum, error: String(e) });
          }
        }),
      );

      // Collect in wave-declared order
      const waveSuccessRequestIds: string[] = [];
      for (const result of slots) {
        if (!result) continue;
        opts.allReplies.push({ round: 1, botName: result.botName, botId: result.botId, reply: result.reply, imageCount: result.imageCount ?? 0 });
        opts.botReplyCount.set(result.botId, (opts.botReplyCount.get(result.botId) ?? 0) + 1);
        if (result.requestId) waveSuccessRequestIds.push(result.requestId);
      }

      // Chain: exactly 1 successful reply → use its requestId as next wave's parent
      waveParentRequestId = pickNextParentRequestId(waveSuccessRequestIds);
    }
    return { lastParentRequestId: waveParentRequestId, hadBotError };
  }

  /**
   * Execute continue loop (rounds 2+): orchestrator evaluates, dispatches bots, persists + sends.
   * Returns the final round number reached.
   */
  private async executeContinueLoop(opts: {
    epoch: number;
    startRound: number;
    orchestratorModel: LanguageModel;
    orchestratorPrompt: string;
    groupConfig: { name: string };
    botsForOrchestrator: { name: string; persona: string; channelId?: string }[];
    botConfigs: BotConfig[];
    callBotShared: CallBotSharedParams;
    userMessage: string;
    attachments?: AttachmentRef[];
    sessionId: string;
    channel: string;
    channelToken: string;
    chatId: string;
    channelAdapter: ReturnType<typeof getAdapter>;
    allReplies: { round: number; botName: string; botId: string; reply: string; imageCount: number }[];
    botReplyCount: Map<string, number>;
    traceDecisions: GroupChatTrace["decisions"];
    log: ReturnType<typeof createLogger>;
    userName: string;
    senderKind: "member" | "external";
    lastParentRequestId?: string;
    // Voice context
    userKeys?: UserKeys;
    isVoiceMessage?: boolean;
    inputMeta?: InputMeta;
    turnStart: number;
  }): Promise<{ round: number; orchestratorInputTokens: number; orchestratorOutputTokens: number }> {
    let round = opts.startRound;
    let orchestratorInputTokens = 0;
    let orchestratorOutputTokens = 0;
    let roundParentRequestId = opts.lastParentRequestId;
    const autoEvaluate = opts.allReplies.length > 0;
    opts.log.info("Interaction loop entry", { autoEvaluate, round, maxRounds: MAX_ROUNDS, repliesCount: opts.allReplies.length });

    while (autoEvaluate && round <= MAX_ROUNDS) {
      if (this.epoch.isStale(opts.epoch)) {
        opts.log.info("epoch_stale", { round, phase: "pre_evaluate" });
        break;
      }

      const repliesForPrompt = opts.allReplies.map(r => ({
        round: r.round,
        botName: r.botName,
        reply: r.reply,
        ...(r.imageCount > 0 && { mediaCount: r.imageCount }),
      }));
      const continuePrompt = buildContinuePrompt(opts.groupConfig.name, opts.botsForOrchestrator, repliesForPrompt, round, opts.orchestratorPrompt, opts.userName, opts.senderKind);

      const continueCallResult = await callOrchestratorContinue({
        model: opts.orchestratorModel,
        systemPrompt: continuePrompt,
        log: opts.log,
        round,
      });

      if (!continueCallResult.ok) {
        opts.traceDecisions.push({
          round,
          respondents: [],
          shouldContinue: false,
          reasoning: `[timeout/error] ${continueCallResult.error.slice(0, 200)}`,
          orchestratorDurationMs: continueCallResult.orchDurationMs,
        });
        break;
      }

      const { result: continueResult, orchDurationMs: orchDurationN, inputTokens: contInTokens, outputTokens: contOutTokens } = continueCallResult;
      orchestratorInputTokens += contInTokens;
      orchestratorOutputTokens += contOutTokens;
      const continueAvailableNames = new Set(opts.botConfigs.map(b => b.name));
      const guarded = applyContinueGuard(continueResult, continueAvailableNames);
      const reasoning = continueResult.reasoning;

      opts.log.info("Interaction loop", {
        round,
        reasoning,
        respondents: guarded.respondents,
        shouldContinue: guarded.shouldContinue,
        orchestratorDurationMs: orchDurationN,
      });

      opts.traceDecisions.push({
        round,
        respondents: guarded.respondents,
        shouldContinue: guarded.shouldContinue,
        reasoning,
        orchestratorDurationMs: orchDurationN,
      });

      if (!guarded.shouldContinue || guarded.respondents.length === 0) {
        break;
      }

      if (this.epoch.isStale(opts.epoch)) {
        opts.log.info("epoch_stale", { round, phase: "pre_dispatch" });
        break;
      }

      // Budget check: stop continue loop if not enough time for a bot call
      const elapsed = performance.now() - opts.turnStart;
      const remaining = TURN_DEADLINE_MS - elapsed;
      if (remaining < 15_000) {
        opts.log.warn("Turn deadline approaching, ending continue loop", { round, elapsed: Math.round(elapsed), remaining: Math.round(remaining) });
        break;
      }

      const nextRespondentNames = guarded.respondents.filter(name => {
        const bot = opts.botConfigs.find(b => b.name === name);
        if (!bot) return false;
        return (opts.botReplyCount.get(bot.botId) ?? 0) < MAX_BOT_REPLIES_PER_TURN;
      });
      if (nextRespondentNames.length === 0) {
        opts.log.info("All respondents hit per-bot reply limit, ending interaction", { round });
        break;
      }
      const nextRespondentBots = opts.botConfigs.filter(b => nextRespondentNames.includes(b.name));

      // Dynamic per-bot timeout: fit within remaining turn budget
      const botTimeout = Math.min(GROUP_BOT_TIMEOUT_MS, remaining - 5_000);

      const roundResults = await Promise.allSettled(
        nextRespondentBots.map(b => callBot({
          ...opts.callBotShared,
          botConfig: b,
          userMessage: opts.userMessage,
          round,
          attachments: opts.attachments,
          parentRequestId: roundParentRequestId,
          timeoutMs: botTimeout,
        })),
      );

      let roundHasReplies = false;
      const roundSuccessRequestIds: string[] = [];
      for (const r of roundResults) {
        if (r.status !== "fulfilled") {
          opts.log.error("Bot call failed", { round, error: String(r.reason) });
          continue;
        }

        const result = r.value;
        if (isSkipReply(result.reply) && result.media.length === 0) {
          opts.log.info("Bot skipped", { round, botName: result.botName });
          continue;
        }

        const { voiceSent } = await this.persistAndSend(result, opts);
        const traceEntry = opts.callBotShared.traceBotCalls.findLast(bc => bc.botId === result.botId);
        if (traceEntry) traceEntry.voiceSent = voiceSent;

        opts.allReplies.push({ round, botName: result.botName, botId: result.botId, reply: result.reply, imageCount: result.imageCount ?? 0 });
        opts.botReplyCount.set(result.botId, (opts.botReplyCount.get(result.botId) ?? 0) + 1);
        roundHasReplies = true;
        if (result.requestId) roundSuccessRequestIds.push(result.requestId);
      }

      // Chain: exactly 1 successful reply → use its requestId as next round's parent
      roundParentRequestId = pickNextParentRequestId(roundSuccessRequestIds);

      if (!roundHasReplies) {
        opts.log.info("All respondents skipped, ending interaction", { round });
        break;
      }

      round++;
    }

    return { round, orchestratorInputTokens, orchestratorOutputTokens };
  }

  private async refreshBotIdentities(
    bots: BotConfig[],
    channel: string,
  ): Promise<void> {
    const adapter = getAdapter(channel);
    if (!adapter?.getBotIdentity) return;

    const TIMEOUT_MS = 3000;
    await Promise.allSettled(bots.map(async (bot) => {
      const binding = bot.channels[channel];
      if (!binding) return;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

      try {
        const identity = await adapter.getBotIdentity!(binding.token, controller.signal);
        if (identity) {
          await configDb.updateChannelIdentity(this.env.D1_DB, bot.ownerId, bot.botId, channel, identity);
        }
      } catch (e) {
        // Best-effort — don't fail the turn
        console.warn("[identity] Channel identity refresh failed:", e);
      } finally {
        clearTimeout(timer);
      }
    }));
  }

  /** Remove dedup entries older than 60s from DO storage. */
  private async cleanupDedup(): Promise<void> {
    const entries = await this.ctx.storage.list<number>({ prefix: "dedup:" });
    const now = Date.now();
    const expired: string[] = [];
    for (const [key, ts] of entries) {
      if (now - ts > 60_000) expired.push(key);
    }
    if (expired.length > 0) {
      await this.ctx.storage.delete(expired);
    }
  }
}

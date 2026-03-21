import { Agent, getAgentByName } from "agents";
import type { Env, AgentRequestPayload, BotConfig, UserKeys } from "../config/schema";
import * as configDb from "../db/config";
import { createModel } from "../providers/gateway";
import type { CronScheduler } from "../tools/cron";
import type { CronJobPayload } from "../cron/types";
import type { SandboxClient } from "../tools/sandbox-types";
import type { SenderOptions, SendAudioOptions } from "../channels/registry";
import { createSpritesSandboxClient, ensureSpriteHealthy } from "../tools/sprites-sandbox";
import { consolidateMemory, estimateTokens, reviewMemory } from "./memory";
import type { ChatCoordinator } from "../group/coordinator";
import type { LanguageModel } from "ai";
import { createLogger } from "../utils/logger";
import type { Logger, RequestTrace } from "../utils/logger";
import * as d1 from "../db/d1";
import { transcribeFromR2 } from "../voice/stt";

// Extracted modules
import {
  REQUEST_TIMEOUT_MS,
  PENDING_REQUEST_KEY,
  PENDING_ORPHAN_MS,
  withTimeout,
  type PendingRequest,
} from "./multibot-helpers";
import { startTypingLoop, sendChannelAudio, sendChannelMessage } from "./multibot-channel";
import { buildAgentTools, buildPromptAndHistory } from "./multibot-build";
import { processChat } from "./multibot-chat";
import { executeCronJob } from "./multibot-cron";
import { SubagentDrainManager } from "./subagent-drain";
import { executeSubagent } from "./subagent-exec";
import type { SubagentRun } from "./subagent-types";

export class MultibotAgent extends Agent<Env> {
  /** Prevents concurrent consolidation on the same session+bot pair. Key: "sessionId:botId". */
  private _consolidating = new Set<string>();
  private _drainManager?: SubagentDrainManager;

  /**
   * Ensure all configured MCP servers are registered, connected, and discovered.
   * Lazy: skips entirely when mcpServers is empty.
   * Each server is wrapped in try/catch so one failure doesn't block others.
   */
  private async ensureMcpConnected(
    mcpServers: Record<string, { url: string; headers: Record<string, string> }>,
    log?: Logger
  ): Promise<void> {
    if (Object.keys(mcpServers).length === 0) return;

    await this.mcp.ensureJsonSchema();

    const registered = new Set(this.mcp.listServers().map((s) => s.id));

    for (const [name, config] of Object.entries(mcpServers)) {
      try {
        if (!registered.has(name)) {
          await this.mcp.registerServer(name, {
            url: config.url,
            name,
            callbackUrl: "",
            transport:
              Object.keys(config.headers).length > 0
                ? { requestInit: { headers: config.headers } }
                : undefined,
          });
        }

        const result = await this.mcp.connectToServer(name);
        if (result.state === "failed") {
          log?.error("MCP server connection failed", { server: name, error: result.error });
          continue;
        }

        await this.mcp.discoverIfConnected(name);
      } catch (error) {
        log?.warn("MCP server setup failed (non-fatal)", {
          server: name,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  private get db(): D1Database {
    return this.env.D1_DB;
  }

  /**
   * Fire-and-forget dispatch to the group orchestrator DO so other bots can respond.
   * Used by both send_to_group tool and cron job group replies.
   */
  private dispatchGroupOrchestrator(params: {
    channel: string;
    token: string;
    ownerId: string;
    groupId: string;
    chatId: string;
    senderBotId: string;
    senderBotName: string;
    message: string;
    parentRequestId?: string;
  }): void {
    const coordinatorId = `coordinator:${params.groupId}:${params.channel}:${params.chatId}`;
    this.ctx.waitUntil(
      (async () => {
        try {
          const coordinator = await getAgentByName<Env, ChatCoordinator>(
            this.env.CHAT_COORDINATOR,
            coordinatorId,
          );
          const req = new Request("https://coordinator/turn", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              channel: params.channel,
              token: params.token,
              ownerId: params.ownerId,
              groupId: params.groupId,
              chatId: params.chatId,
              userId: `bot:${params.senderBotId}`,
              userName: params.senderBotName,
              userMessage: params.message,
              isBotMessage: true,
              senderBotId: params.senderBotId,
              parentRequestId: params.parentRequestId,
            }),
          });
          await coordinator.fetch(req);
        } catch (e) {
          console.error(JSON.stringify({
            msg: "Orchestrator dispatch failed",
            groupId: params.groupId,
            error: e instanceof Error ? e.message : String(e),
          }));
        }
      })()
    );
  }

  private getDrainManager(): SubagentDrainManager {
    if (!this._drainManager) {
      this._drainManager = new SubagentDrainManager(
        this.ctx.storage,
        () => this.buildChatDeps(),
        this.db,
        (p) => this.ctx.waitUntil(p),
      );
    }
    return this._drainManager;
  }

  /** Shared ChatDeps builder for processChat */
  private buildChatDeps() {
    return {
      env: this.env,
      db: this.db,
      waitUntil: (p: Promise<unknown>) => this.ctx.waitUntil(p),
      buildAgentTools,
      buildPromptAndHistory,
      getSandboxClient: (botId: string) => this.getSandboxClient(botId),
      buildLocalCronScheduler: () => this.buildLocalCronScheduler(),
      buildRemoteCronScheduler: (botId: string) => this.buildRemoteCronScheduler(botId),
      ensureMcpConnected: (mcpServers: Record<string, { url: string; headers: Record<string, string> }>, log?: Logger) =>
        this.ensureMcpConnected(mcpServers, log),
      getMcpTools: () => this.mcp.getAITools(),
      sendChannelMessage: (ch: string, tok: string, cid: string, text: string, opts?: SenderOptions) =>
        sendChannelMessage(ch, tok, cid, text, opts),
      sendChannelAudio: (ch: string, tok: string, cid: string, audio: ArrayBuffer, opts?: SendAudioOptions) => sendChannelAudio(ch, tok, cid, audio, opts),
      startTypingLoop,
      dispatchGroupOrchestrator: (params: {
        channel: string; token: string; ownerId: string; groupId: string;
        chatId: string; senderBotId: string; senderBotName: string;
        message: string; parentRequestId?: string;
      }) => this.dispatchGroupOrchestrator(params),
      consolidateSession: (model: LanguageModel, botConfig: BotConfig, sessionId: string, log?: Logger) =>
        this.consolidateSession(model, botConfig, sessionId, log),
      maybeConsolidate: (model: LanguageModel, botConfig: BotConfig, sessionId: string, log?: Logger) =>
        this.maybeConsolidate(model, botConfig, sessionId, log),
      startSubagent: (run: SubagentRun) => {
        this.ctx.waitUntil(
          (async () => {
            const botConfig = await configDb.getBot(this.db, run.ownerId, run.botId);
            if (!botConfig) {
              console.error("[subagent] Bot not found for sub-agent execution:", run.botId);
              return;
            }
            const userKeys = await configDb.getUserKeys(this.db, run.ownerId);
            const log = createLogger({ botId: run.botId, channel: run.channel, chatId: run.chatId });
            await executeSubagent(
              this.buildChatDeps(),
              run,
              botConfig,
              userKeys ?? {},
              this.ctx.storage,
              log,
              (completedRun) => this.getDrainManager().scheduleDrain(completedRun.parentSessionId),
            );
          })().catch(e => console.error("[subagent] Execution failed:", e))
        );
      },
    };
  }

  async onRequest(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // -- Cron proxy endpoints (called by remote CronScheduler) --
    if (path === "/cron/schedule") {
      const body = (await request.json()) as {
        type: "at" | "every" | "cron";
        when?: string;
        seconds?: number;
        expr?: string;
        payload: CronJobPayload;
      };
      let s: { id: string };
      if (body.type === "at") {
        s = { id: (await this.schedule(new Date(body.when!), "onCronJob" as keyof this & string, body.payload)).id };
      } else if (body.type === "every") {
        s = { id: (await this.scheduleEvery(body.seconds!, "onCronJob" as keyof this & string, body.payload)).id };
      } else {
        s = { id: (await this.schedule(body.expr!, "onCronJob" as keyof this & string, body.payload)).id };
      }
      return Response.json({ id: s.id });
    }

    if (path === "/cron/list") {
      const schedules = this.getSchedules<CronJobPayload>()
        .filter((s) => s.callback === "onCronJob")
        .map((s) => ({ id: s.id, type: s.type, payload: s.payload, time: s.time }));
      return Response.json(schedules);
    }

    if (path === "/cron/cancel") {
      const body = (await request.json()) as { id: string };
      const cancelled = await this.cancelSchedule(body.id);
      return Response.json({ cancelled });
    }

    let payload: AgentRequestPayload | null = null;
    let log = createLogger();
    const requestAbort = new AbortController();
    try {
      payload = (await request.json()) as AgentRequestPayload;

      log = createLogger({
        requestId: payload.requestId,
        parentRequestId: payload.parentRequestId,
        botId: payload.botConfig.botId,
        channel: payload.channel,
        chatId: payload.chatId,
      });
      if (path === "/group-chat") {
        // Group chat: progress streams to channel, final reply via coordinator
        const coordinatorOwned = !!payload.coordinatorOwned;
        const result = await withTimeout(
          this.keepAliveWhile(() =>
            processChat(this.buildChatDeps(), payload!, {
              sendProgressToChannel: true,
              sendFinalToChannel: false,
              sendToolHints: false,
              enableMessageTool: false,
              enableTyping: true,
              persistMessages: !coordinatorOwned,
              abortSignal: requestAbort.signal,
            }, log)
          ),
          REQUEST_TIMEOUT_MS,
          requestAbort,
        );
        return Response.json({
          requestId: log.requestId,
          reply: result.reply,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          skillCalls: result.skillCalls,
          model: result.model,
          imageCount: result.imageCount,
          media: result.media,
          ...(coordinatorOwned && { newMessages: result.newMessages }),
        });
      }

      // Default: /chat -- normal single-bot chat

      // Recover orphaned sub-agent runs (non-blocking)
      this.ctx.waitUntil(
        this.getDrainManager().recoverOrphans().catch(e =>
          console.warn("[subagent] Orphan recovery failed:", e)
        )
      );

      // Detect orphaned pending request from a previous DO eviction/deployment.
      // If a prior processChat was killed mid-flight, notify the user.
      const stale = await this.ctx.storage.get<PendingRequest>(PENDING_REQUEST_KEY);
      if (stale && Date.now() - stale.timestamp > PENDING_ORPHAN_MS) {
        await this.ctx.storage.delete(PENDING_REQUEST_KEY);
        log.warn("Orphaned pending request detected", { staleSince: new Date(stale.timestamp).toISOString() });
        try {
          await sendChannelMessage(
            stale.channel, stale.channelToken, stale.chatId,
            "Sorry, your previous message wasn't processed due to a system restart. Please resend it."
          );
        } catch (e) {
          console.warn("[pending] Failed to notify stale pending:", e);
        }
      }

      // Track this request as pending before fire-and-forget processing
      const pendingRequestId = log.requestId;
      await this.ctx.storage.put(PENDING_REQUEST_KEY, {
        requestId: pendingRequestId,
        channel: payload!.channel,
        channelToken: payload!.channelToken,
        chatId: payload!.chatId,
        timestamp: Date.now(),
      } as PendingRequest);

      // STT: transcribe voice messages before processing
      if (payload.isVoiceMessage && payload.botConfig.sttEnabled && this.env.AI && this.env.ASSETS_BUCKET) {
        const audioRef = payload.attachments?.find(a => a.mediaType.startsWith("audio/"));
        if (audioRef) {
          const sttResult = await transcribeFromR2(this.env.AI, this.env.ASSETS_BUCKET, audioRef);
          if ("text" in sttResult) {
            const originalText = payload.userMessage;
            payload.userMessage = originalText
              ? `${originalText}\n\n[Voice transcript]: ${sttResult.text}`
              : sttResult.text;
            payload.inputMeta = { mode: "voice", sttStatus: "success" };
          } else {
            payload.inputMeta = { mode: "voice", sttStatus: "failed" };
            log.warn("STT transcription failed", { error: sttResult.error });
          }
        } else {
          // Voice message detected but audio not in R2 (download may have failed)
          payload.inputMeta = { mode: "voice", sttStatus: "failed" };
          log.warn("STT skipped: voice message but no audio attachment in R2");
        }
      }

      // Fire-and-forget: return immediately so the caller's waitUntil() doesn't
      // cancel the DO fetch. Use this.ctx.waitUntil() to keep the DO alive.
      this.ctx.waitUntil(
        withTimeout(
          this.keepAliveWhile(() =>
            processChat(this.buildChatDeps(), payload!, {
              sendProgressToChannel: true,
              sendFinalToChannel: true,
              sendToolHints: true,
              enableMessageTool: true,
              enableTyping: true,
              abortSignal: requestAbort.signal,
            }, log, {
              spawnDepth: 0,
              storage: this.ctx.storage,
            })
          ),
          REQUEST_TIMEOUT_MS,
          requestAbort,
        ).catch(async (error: any) => {
          const isTimeout = error?.name === "AbortError" || error?.name === "TimeoutError";
          log.error(isTimeout ? "Request timed out" : "Request failed", {
            errorName: error?.name,
            errorMessage: error?.message,
            statusCode: error?.statusCode ?? error?.status,
            stack: error?.stack,
          });

          // Flush error trace to R2
          if (this.env.LOG_BUCKET && log.requestId) {
            const errorTrace: RequestTrace = {
              requestId: log.requestId,
              parentRequestId: payload?.parentRequestId,
              botId: payload?.botConfig.botId,
              botName: payload?.botConfig.name,
              channel: payload?.channel,
              chatId: payload?.chatId,
              status: "error",
              startedAt: Date.now(),
              durationMs: 0,
              llmCalls: 0,
              inputTokens: 0,
              outputTokens: 0,
              skillCalls: [],
              iterations: 0,
              errorMessage: error?.message,
              errorStack: error?.stack,
              userMessage: payload?.userMessage?.slice(0, 200),
            };
            try { await log.flush(this.env.LOG_BUCKET, errorTrace, this.env.D1_DB); } catch (e) { console.warn("[trace] Failed to flush error trace:", e); }
          }

          // Send error to channel
          try {
            const status = error?.statusCode ?? error?.status;
            let errorMsg: string;
            if (isTimeout) {
              errorMsg = "Request timed out. The response was taking too long. Please try again.";
            } else if (status === 401 || status === 403) {
              errorMsg = "API key may be invalid or expired. Please check your configuration.";
            } else if (status === 429) {
              errorMsg = "Rate limited by the AI provider. Please try again later.";
            } else {
              errorMsg = "Sorry, something went wrong processing your message.";
            }
            await sendChannelMessage(
              payload!.channel, payload!.channelToken, payload!.chatId, errorMsg
            );
          } catch (e) {
            console.warn("[chat] Failed to send error to channel:", e);
          }
        }).finally(async () => {
          // Clear pending request only if it still belongs to this request (compare-and-set).
          // A newer request may have overwritten the key -- don't delete theirs.
          try {
            const current = await this.ctx.storage.get<PendingRequest>(PENDING_REQUEST_KEY);
            if (current?.requestId === pendingRequestId) {
              await this.ctx.storage.delete(PENDING_REQUEST_KEY);
            }
          } catch (e) {
            console.warn("[pending] Failed to cleanup pending request:", e);
          }
        })
      );
      return new Response("OK", { status: 200 });
    } catch (error: any) {
      const isTimeout = error?.name === "AbortError" || error?.name === "TimeoutError";
      log.error(isTimeout ? "Request timed out" : "Request failed", {
        errorName: error?.name,
        errorMessage: error?.message,
        statusCode: error?.statusCode ?? error?.status,
        url: error?.url,
        stack: error?.stack,
      });

      // Flush error trace to R2
      if (this.env.LOG_BUCKET && log.requestId) {
        const errorTrace: RequestTrace = {
          requestId: log.requestId,
          parentRequestId: payload?.parentRequestId,
          botId: payload?.botConfig.botId,
          botName: payload?.botConfig.name,
          channel: payload?.channel,
          chatId: payload?.chatId,
          status: "error",
          startedAt: Date.now(),
          durationMs: 0,
          llmCalls: 0,
          inputTokens: 0,
          outputTokens: 0,
          skillCalls: [],
          iterations: 0,
          errorMessage: error?.message,
          errorStack: error?.stack,
          userMessage: payload?.userMessage?.slice(0, 200),
        };
        this.ctx.waitUntil(log.flush(this.env.LOG_BUCKET, errorTrace, this.env.D1_DB));
      }

      // /chat errors are handled inside the fire-and-forget .catch() above.
      // /group-chat errors are returned as HTTP 500 -- the coordinator owns channel messaging.
      return new Response("Internal error", { status: 500 });
    }
  }

  /**
   * Load BotConfig and UserKeys from D1 (used by onCronJob which doesn't receive them in payload).
   */
  private async loadBotConfigAndKeys(
    ownerId: string,
    botId: string
  ): Promise<{ botConfig: BotConfig; userKeys: UserKeys } | null> {
    const botConfig = await configDb.getBot(this.env.D1_DB, ownerId, botId);
    if (!botConfig) return null;
    const userKeys = (await configDb.getUserKeys(this.env.D1_DB, ownerId)) ?? {};
    return { botConfig, userKeys };
  }

  // DO-level sprite health lock — survives across requests within same DO instance.
  // When DO is evicted, lock is lost, but ensureSpriteHealthy handles "already exists" gracefully.
  // Entries expire after SPRITE_CACHE_TTL so zombie sprites are detected via periodic health pings.
  private static readonly SPRITE_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
  private spriteReadyPromises = new Map<string, { promise: Promise<void>; expiresAt: number }>();

  private ensureSpriteReady(botId: string): () => Promise<void> {
    const token = this.env.SPRITES_TOKEN!;
    const spriteName = `multibot-${botId}`;
    return () => {
      const cached = this.spriteReadyPromises.get(botId);
      if (cached && Date.now() < cached.expiresAt) {
        return cached.promise;
      }
      const promise = ensureSpriteHealthy({ token, spriteName }).catch((err) => {
        this.spriteReadyPromises.delete(botId); // Allow retry on failure
        throw err;
      });
      this.spriteReadyPromises.set(botId, {
        promise,
        expiresAt: Date.now() + MultibotAgent.SPRITE_CACHE_TTL,
      });
      return promise;
    };
  }

  /**
   * Get a SandboxClient for the given bot (Fly.io Sprites backend).
   */
  private getSandboxClient(botId: string): SandboxClient {
    const token = this.env.SPRITES_TOKEN;
    if (!token) throw new Error("SPRITES_TOKEN is required for sandbox");
    return createSpritesSandboxClient(
      { token, spriteName: `multibot-${botId}` },
      this.ensureSpriteReady(botId),
    );
  }

  /**
   * Build a CronScheduler that delegates to Agent's schedule/cancel methods (local DO).
   * Used only inside onCronJob to avoid self-fetch deadlock.
   */
  private buildLocalCronScheduler(): CronScheduler {
    return {
      scheduleAt: async (when, payload) => {
        const s = await this.schedule(
          when,
          "onCronJob" as keyof this & string,
          payload
        );
        return { id: s.id };
      },
      scheduleEvery: async (seconds, payload) => {
        const s = await this.scheduleEvery(
          seconds,
          "onCronJob" as keyof this & string,
          payload
        );
        return { id: s.id };
      },
      scheduleCron: async (expr, payload) => {
        const s = await this.schedule(
          expr,
          "onCronJob" as keyof this & string,
          payload
        );
        return { id: s.id };
      },
      listSchedules: async () => {
        return this.getSchedules<CronJobPayload>()
          .filter((s) => s.callback === "onCronJob")
          .map((s) => ({
            id: s.id,
            type: s.type,
            payload: s.payload,
            time: s.time,
          }));
      },
      cancelSchedule: (id) => this.cancelSchedule(id),
    };
  }

  /**
   * Build a CronScheduler that proxies to the canonical cron-{botId} DO via HTTP.
   * All cron operations for a bot are centralized in one DO regardless of chat context.
   */
  private buildRemoteCronScheduler(botId: string): CronScheduler {
    const cronAgentId = `cron-${botId}`;
    const fetchCron = async (path: string, body: unknown) => {
      const agent = await getAgentByName<Env, MultibotAgent>(this.env.MULTIBOT_AGENT, cronAgentId);
      const resp = await agent.fetch(new Request(`https://agent${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }));
      return resp.json();
    };

    return {
      scheduleAt: async (when, payload) => {
        return fetchCron("/cron/schedule", { type: "at", when: when.toISOString(), payload }) as Promise<{ id: string }>;
      },
      scheduleEvery: async (seconds, payload) => {
        return fetchCron("/cron/schedule", { type: "every", seconds, payload }) as Promise<{ id: string }>;
      },
      scheduleCron: async (expr, payload) => {
        return fetchCron("/cron/schedule", { type: "cron", expr, payload }) as Promise<{ id: string }>;
      },
      listSchedules: async () => {
        return fetchCron("/cron/list", {}) as Promise<Array<{ id: string; type: string; payload: CronJobPayload; time?: number }>>;
      },
      cancelSchedule: async (id) => {
        const result = await fetchCron("/cron/cancel", { id }) as { cancelled: boolean };
        return result.cancelled;
      },
    };
  }

  /**
   * Workaround for workerd issue #2240: when a DO cold-starts from an alarm,
   * this.name may not be hydrated, causing the Agents SDK's onStart to crash
   * with "Attempting to read .name on MultibotAgent before it was set."
   * Pre-hydrate the name from DO storage before super.alarm() triggers onStart.
   */
  async alarm(): Promise<void> {
    // this.name throws if #_name is unset (partyserver workerd#2240).
    // There is no public API to check readiness without triggering a throw.
    try {
      this.name;
    } catch {
      try {
        // "__ps_name" = NAME_STORAGE_KEY in partyserver/dist/index.js
        const storedName = await this.ctx.storage.get<string>("__ps_name");
        if (storedName) {
          await this.setName(storedName);
        } else {
          console.warn("[alarm] __ps_name not found in storage -- orphaned DO, dropping alarm");
          return;
        }
      } catch (e) {
        // setName calls #ensureInitialized() -> onStart(), which may throw for other reasons.
        // Swallow here so super.alarm() gets a chance to retry initialization (partyserver
        // resets #status to "zero" on failure, so #ensureInitialized will re-run onStart).
        console.warn("[alarm] Failed to pre-hydrate name:", e);
      }
    }
    return super.alarm();
  }

  /**
   * Callback invoked by the Agents SDK scheduler when a cron job fires.
   * Loads bot config, runs the agent loop with the job's message, and sends the reply.
   * For timezone-aware cron: re-schedules the next occurrence (chained one-shots).
   */
  async onCronJob(payload: CronJobPayload): Promise<void> {
    const log = createLogger({
      botId: payload.botId,
      channel: payload.channel,
      chatId: payload.chatId,
    });
    log.info("Cron job started", { message: payload.message });

    await this.keepAliveWhile(async () => {
      await executeCronJob({
        env: this.env,
        db: this.db,
        loadBotConfigAndKeys: (ownerId, botId) => this.loadBotConfigAndKeys(ownerId, botId),
        getSchedules: <T>() => this.getSchedules<T>(),
        cancelSchedule: (id) => this.cancelSchedule(id),
        schedule: (when, callback, cronPayload) =>
          this.schedule(when, callback as keyof this & string, cronPayload),
        buildAgentTools,
        buildPromptAndHistory,
        getSandboxClient: (botId) => this.getSandboxClient(botId),
        buildLocalCronScheduler: () => this.buildLocalCronScheduler(),
        buildRemoteCronScheduler: (botId) => this.buildRemoteCronScheduler(botId),
        ensureMcpConnected: (mcpServers, log) => this.ensureMcpConnected(mcpServers, log),
        getMcpTools: () => this.mcp.getAITools(),
        sendChannelMessage: (ch, tok, cid, text, opts) => sendChannelMessage(ch, tok, cid, text, opts),
        sendChannelAudio: (ch, tok, cid, audio, opts) => sendChannelAudio(ch, tok, cid, audio, opts),
        startTypingLoop,
        dispatchGroupOrchestrator: (params) => this.dispatchGroupOrchestrator(params),
      }, payload, log);
    });
  }

  /**
   * Consolidate all messages in a session (background task for /new).
   * Matches nanobot's /new -- archive_all=true, messages preserved (append-only).
   */
  private async consolidateSession(
    model: LanguageModel,
    botConfig: BotConfig,
    sessionId: string,
    log?: Logger
  ): Promise<void> {
    const consolidateKey = `${sessionId}:${botConfig.botId}`;
    if (this._consolidating.has(consolidateKey)) return;
    this._consolidating.add(consolidateKey);
    try {
      const allMessages = await d1.getMessagesForConsolidation(this.db, sessionId, botConfig.botId);

      log?.info("Consolidation starting (/new)", {
        sessionId,
        botId: botConfig.botId,
        messageCount: allMessages.length,
      });

      if (allMessages.length === 0) {
        log?.info("Consolidation skipped: no messages", { sessionId, botId: botConfig.botId });
        return;
      }

      const newBoundary = await consolidateMemory({
        model,
        db: this.db,
        botId: botConfig.botId,
        messages: allMessages,
        memoryWindow: botConfig.memoryWindow,
        archiveAll: true,
        timezone: botConfig.timezone,
      });

      if (newBoundary !== null) {
        await d1.updateSessionConsolidated(this.db, sessionId, botConfig.botId, newBoundary);
        // /new: delete all consolidated messages (user explicitly started a new session)
        await d1.deleteConsolidatedMessages(this.db, sessionId, botConfig.botId, newBoundary);
        log?.info("Memory consolidation complete (/new), messages cleaned", {
          sessionId,
          botId: botConfig.botId,
          boundary: newBoundary,
        });
      } else {
        log?.info("Consolidation returned null (LLM may not have called archive_conversation)", {
          sessionId,
          botId: botConfig.botId,
        });
      }
    } catch (error) {
      log?.warn("Consolidation error (non-fatal)", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this._consolidating.delete(consolidateKey);
    }
  }

  private async maybeConsolidate(
    model: LanguageModel,
    botConfig: BotConfig,
    sessionId: string,
    log?: Logger
  ): Promise<void> {
    const consolidateKey = `${sessionId}:${botConfig.botId}`;
    if (this._consolidating.has(consolidateKey)) return;
    this._consolidating.add(consolidateKey);
    try {
      const memoryWindow = botConfig.memoryWindow ?? 50;

      const lastConsolidated = await d1.getSessionLastConsolidated(this.db, sessionId, botConfig.botId);

      const allMessages = await d1.getMessagesForConsolidation(this.db, sessionId, botConfig.botId, lastConsolidated);

      // Token-based trigger: estimate total tokens of unconsolidated messages
      const contextWindow = botConfig.contextWindow ?? 128000;
      const tokenThreshold = Math.floor(contextWindow * 0.5);
      const totalTokens = allMessages.reduce((sum, m) => {
        const content = (m.content ?? "").slice(0, 2000);
        return sum + estimateTokens(content) + 30;
      }, 0);
      const tokenTriggered = totalTokens > tokenThreshold;

      const keepCount = Math.floor(memoryWindow / 2);
      const countTriggered = allMessages.length > keepCount;

      if (!countTriggered && !tokenTriggered) {
        log?.info("Consolidation skipped: within both count and token thresholds", {
          sessionId, botId: botConfig.botId,
          messageCount: allMessages.length, keepCount,
          estimatedTokens: totalTokens, tokenThreshold,
        });
        return;
      }

      log?.info("Consolidation triggered", {
        sessionId, botId: botConfig.botId,
        trigger: countTriggered && tokenTriggered ? "count+token" : countTriggered ? "count" : "token",
        messageCount: allMessages.length, keepCount,
        estimatedTokens: totalTokens, tokenThreshold,
      });

      const newBoundary = await consolidateMemory({
        model,
        db: this.db,
        botId: botConfig.botId,
        messages: allMessages,
        memoryWindow,
        timezone: botConfig.timezone,
      });

      if (newBoundary !== null) {
        await d1.updateSessionConsolidated(this.db, sessionId, botConfig.botId, newBoundary);
        log?.info("Memory consolidation complete", {
          sessionId,
          boundary: newBoundary,
        });

        // High-water mark deletion: if total messages exceed memoryWindow * 4,
        // delete the already-consolidated portion to control D1 growth.
        const highWaterMark = memoryWindow * 4;
        const totalCount = await d1.countSessionMessages(this.db, sessionId, botConfig.botId);
        if (totalCount > highWaterMark) {
          await d1.deleteConsolidatedMessages(this.db, sessionId, botConfig.botId, newBoundary);
          log?.info("High-water mark deletion: removed consolidated messages", {
            sessionId,
            boundary: newBoundary,
            totalBefore: totalCount,
          });
        }

        // Eager memory review: when token pressure is high, fast-track key facts
        // into long-term memory instead of waiting for the next cron cycle.
        if (tokenTriggered && botConfig.botType !== "admin") {
          try {
            const reviewed = await reviewMemory({
              model, db: this.db, botId: botConfig.botId,
              contextWindow,
            });
            if (reviewed) {
              log?.info("Eager memory review completed after high-pressure consolidation", {
                sessionId, botId: botConfig.botId,
              });
            }
          } catch (reviewError) {
            log?.warn("Eager memory review failed (non-fatal)", {
              error: reviewError instanceof Error ? reviewError.message : String(reviewError),
            });
          }
        }
      }
    } catch (error) {
      log?.warn("Consolidation error (non-fatal)", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
    } finally {
      this._consolidating.delete(consolidateKey);
    }
  }
}

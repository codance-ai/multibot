import type { Env, AgentRequestPayload, BotConfig, UserKeys } from "../config/schema";
import * as configDb from "../db/config";
import { createModel } from "../providers/gateway";
import type { SandboxClient } from "../tools/sandbox-types";
import { runAgentLoop } from "./loop";
import type { StoredMessage } from "./loop";
import { getAdapter, type SenderOptions, type MediaItem } from "../channels/registry";
import { resolveAttachmentsForLLM, type ContentPart, type SandboxFile, type ResolvedAttachments } from "../utils/attachment-resolve";
import { isSkipReply } from "../group/utils";
import type { ToolSet, LanguageModel } from "ai";
import type { Logger, RequestTrace, SkillCall } from "../utils/logger";
import * as d1 from "../db/d1";
import type { ChatContext } from "../db/d1";
import { uint8ArrayToBase64, formatSizeCompact } from "./multibot-helpers";
import { resolveAndNormalizeReply } from "./multibot-image";
import type { CronScheduler } from "../tools/cron";
import type { buildAgentTools } from "./multibot-build";
import type { buildPromptAndHistory } from "./multibot-build";

export interface ChatDeps {
  env: Env;
  db: D1Database;
  waitUntil: (p: Promise<unknown>) => void;
  buildAgentTools: typeof buildAgentTools;
  buildPromptAndHistory: typeof buildPromptAndHistory;
  getSandboxClient: (botId: string) => SandboxClient;
  buildLocalCronScheduler: () => CronScheduler;
  buildRemoteCronScheduler: (botId: string) => CronScheduler;
  ensureMcpConnected: (mcpServers: Record<string, { url: string; headers: Record<string, string> }>, log?: Logger) => Promise<void>;
  getMcpTools: () => ToolSet;
  sendChannelMessage: (ch: string, tok: string, cid: string, text: string, opts?: SenderOptions) => Promise<void>;
  sendChannelAudio?: (ch: string, tok: string, cid: string, audio: ArrayBuffer, opts?: import("../channels/registry").SendAudioOptions) => Promise<{ captionSent: boolean }>;
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
  consolidateSession: (model: LanguageModel, botConfig: BotConfig, sessionId: string, log?: Logger) => Promise<void>;
  maybeConsolidate: (model: LanguageModel, botConfig: BotConfig, sessionId: string, log?: Logger) => Promise<void>;
  startSubagent?: (run: import("./subagent-types").SubagentRun) => void;
}

export interface ChatOptions {
  sendProgressToChannel: boolean;
  sendFinalToChannel: boolean;
  sendToolHints: boolean;
  enableMessageTool: boolean;
  enableTyping: boolean;
  persistMessages?: boolean; // default true
  abortSignal?: AbortSignal;
}

export interface ChatResult {
  reply: string;
  inputTokens: number;
  outputTokens: number;
  skillCalls: SkillCall[];
  model?: string;
  imageCount?: number;
  media?: MediaItem[];
  newMessages?: StoredMessage[];
}

/**
 * Shared chat processing logic for both /chat and /group-chat endpoints.
 */
export interface SubagentContext {
  spawnDepth: number;
  storage: DurableObjectStorage;
  subagentSystemPromptSuffix?: string;
}

export async function processChat(
  deps: ChatDeps,
  payload: AgentRequestPayload,
  options: ChatOptions,
  log?: Logger,
  subagentCtx?: SubagentContext,
): Promise<ChatResult> {
  let { botConfig } = payload;
  const {
    userKeys,
    chatId,
    userMessage,
    channel,
    channelToken,
    groupContext,
  } = payload;

  const chatCtx: ChatContext = {
    channel,
    chatId,
    groupId: groupContext?.groupId,
    botId: botConfig.botId,
  };

  // Handle /new command -- respond immediately, consolidate in background
  // In group chat, orchestrator passes the old sessionId and creates the new session itself.
  // In private chat, we get the old session and create a new one here.
  if (/^\/new(@\S+)?$/i.test(userMessage.trim())) {
    const oldSessionId = payload.sessionId ?? await d1.getOrCreateSession(deps.db, chatCtx);
    if (!payload.sessionId) {
      await d1.createNewSession(deps.db, chatCtx);
    }
    // Bump session epoch so stale sub-agent results from the old session are dropped
    if (subagentCtx?.storage) {
      const { bumpSessionEpoch } = await import("./subagent-storage");
      await bumpSessionEpoch(subagentCtx.storage, oldSessionId).catch(e =>
        console.warn("[chat] Failed to bump session epoch:", e)
      );
    }
    if (options.sendFinalToChannel) {
      await deps.sendChannelMessage(
        channel,
        channelToken,
        chatId,
        "New session started."
      );
    }
    deps.waitUntil(
      (async () => {
        try {
          const model = createModel(botConfig, userKeys);
          await deps.consolidateSession(model, botConfig, oldSessionId, log);
        } catch (error) {
          log?.warn("Consolidation failed in /new (non-fatal)", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })()
    );
    // Flush /new trace to R2
    if (deps.env.LOG_BUCKET && log?.requestId) {
      const trace: RequestTrace = {
        requestId: log.requestId,
        parentRequestId: payload.parentRequestId,
        botId: botConfig.botId,
        botName: botConfig.name,
        channel,
        chatId,
        status: "ok",
        startedAt: Date.now(),
        durationMs: 0,
        llmCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        skillCalls: [],
        iterations: 0,
        userMessage: userMessage?.slice(0, 200),
        reply: "New session started.",
      };
      deps.waitUntil(log.flush(deps.env.LOG_BUCKET, trace, deps.env.D1_DB));
    }
    return { reply: "New session started.", inputTokens: 0, outputTokens: 0, skillCalls: [] };
  }

  // Derive bot-specific send identity for progress messages in group chat
  const progressToken = groupContext
    ? (botConfig.channels[channel]?.token || channelToken)
    : channelToken;
  const progressOptions: SenderOptions | undefined = groupContext
    ? { meta: { username: botConfig.name, avatarUrl: botConfig.avatarUrl } }
    : undefined;

  // Start typing indicator early — before Phase 1 I/O so the user sees
  // feedback immediately, not after D1 queries + tool/prompt building.
  let typingAbort: AbortController | null = null;
  if (options.enableTyping) {
    typingAbort = new AbortController();
    // Combine with request abort signal so typing stops immediately on timeout,
    // even if runAgentLoop hasn't thrown yet (withTimeout rejects a separate chain).
    const typingSignal = options.abortSignal
      ? AbortSignal.any([typingAbort.signal, options.abortSignal])
      : typingAbort.signal;
    deps.startTypingLoop(channel, progressToken, chatId, typingSignal, payload.deadline);
  }

  try {
  // === Phase 1 (parallel): independent I/O operations ===
  // - getOrCreateSession: D1 query for session
  // - getSkillSecretsForBot: D1 query for skill secrets (enabledSkills)
  // - resolveAttachmentsForLLM: R2 reads for attachments
  const sessionPromise = payload.sessionId
    ? Promise.resolve(payload.sessionId)
    : d1.getOrCreateSession(deps.db, chatCtx);

  const skillSecretsPromise = configDb.getSkillSecretsForBot(
    deps.db, botConfig.ownerId, botConfig.enabledSkills,
  );

  const attachmentsPromise: Promise<ResolvedAttachments | undefined> =
    (payload.attachments?.length && deps.env.ASSETS_BUCKET)
      ? resolveAttachmentsForLLM(payload.attachments, deps.env.ASSETS_BUCKET)
      : Promise.resolve(undefined);

  const [sessionId, skillSecretsResult, resolved] = await Promise.all([
    sessionPromise,
    skillSecretsPromise,
    attachmentsPromise,
  ]);
  const { flat: skillSecrets, perSkill: perSkillSecrets } = skillSecretsResult;

  log = log?.child({ sessionId });
  // Create LLM model
  const model = createModel(botConfig, userKeys);

  // Extract attachment results
  let attachmentParts: ContentPart[] | undefined;
  let attachmentMetadata: string | undefined;
  let sandboxFiles: SandboxFile[] = [];
  if (resolved) {
    if (resolved.contentParts.length > 0) attachmentParts = resolved.contentParts;
    attachmentMetadata = resolved.metadataText;
    sandboxFiles = resolved.sandboxFiles;
  }

  // === Phase 2 (serial): buildAgentTools needs skillSecrets from Phase 1 ===
  const buildResult = await deps.buildAgentTools({
    env: deps.env,
    db: deps.db,
    botConfig, userKeys, channel, chatId, channelToken,
    enableMessageTool: options.enableMessageTool,
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
  let { tools } = buildResult;
  const { sandboxClient } = buildResult;
  botConfig = buildResult.botConfig;

  // Add sub-agent tools if context provided (needs sessionId from Phase 1)
  if (subagentCtx?.storage && deps.startSubagent) {
    const { createSubagentTools } = await import("../tools/subagent");
    const { mergeTools } = await import("../tools/registry");
    const subagentTools = createSubagentTools({
      storage: subagentCtx.storage,
      spawnDepth: subagentCtx.spawnDepth,
      config: botConfig.subagent,
      parentSessionId: sessionId,
      ownerId: botConfig.ownerId,
      botId: botConfig.botId,
      channel, chatId, channelToken,
      userId: payload.userId,
      userName: payload.userName,
      createChildSession: (ch, cid, bid) =>
        d1.createNewSession(deps.db, { channel: ch, chatId: cid, botId: bid }),
      startSubagent: deps.startSubagent,
    });
    tools = mergeTools(tools, subagentTools);
  }

  // === Phase 3 (parallel): operations that need sandboxClient from Phase 2 ===
  // - buildPromptAndHistory: needs sessionId (Phase 1) + assetsBucket for multimodal content
  // - materializeSandboxFiles: needs sandboxClient (Phase 2) + sandboxFiles (Phase 1)
  const [promptResult, sandboxAnnotation] = await Promise.all([
    deps.buildPromptAndHistory({
      db: deps.db,
      assetsBucket: deps.env.ASSETS_BUCKET,
      botConfig, sessionId, channel, chatId, groupContext,
      perSkillSecrets,
    }),
    materializeSandboxFiles(sandboxClient, sandboxFiles, log),
  ]);

  let { systemPrompt } = promptResult;
  const { conversationHistory, tokenUsage } = promptResult;

  // Append sub-agent context to system prompt if this is a sub-agent execution
  if (subagentCtx?.subagentSystemPromptSuffix) {
    systemPrompt += subagentCtx.subagentSystemPromptSuffix;
  }

  log?.info("Context token usage", {
    systemPromptTokens: tokenUsage.systemPromptTokens,
    historyTokens: tokenUsage.historyTokens,
    totalTokens: tokenUsage.totalTokens,
    contextWindow: tokenUsage.contextWindow,
    usageRatio: Math.round(tokenUsage.usageRatio * 100) + "%",
    trimmedCount: tokenUsage.trimmedCount,
  });

  // Prepend metadata annotation for unsupported file types
  let effectiveUserMessage = userMessage;
  if (attachmentMetadata) {
    effectiveUserMessage = `${userMessage}\n\n${attachmentMetadata}`;
  }

  // STT failure hint: tell the bot to ask user to resend
  if (payload.inputMeta?.sttStatus === "failed") {
    effectiveUserMessage += "\n\n[System: The user sent a voice message but transcription failed. Ask them to resend or type their message instead.]";
  }

  // Persist incoming user message (serial after Phase 3)
  // Skip for group chat: orchestrator handles user message persistence
  // Text file content is NOT inlined here — it's reconstructed from R2
  // by buildPromptAndHistory() for both private and group chat history.
  if (!groupContext) {
    await d1.persistUserMessage(deps.db, sessionId, effectiveUserMessage, payload.parentRequestId, payload.attachments);
  }

  // Voice delivery hint: tell the bot this reply will be delivered as voice
  // Appended AFTER persist so it only affects the current LLM turn, not stored history
  if (payload.inputMeta?.sttStatus === "success" && botConfig.voiceMode === "mirror") {
    effectiveUserMessage += "\n\n[System: The user sent a voice message. Your reply will be delivered as voice.]";
  }

  // Run agent loop with onProgress
  const loopStart = performance.now();

  const onProgress = options.sendProgressToChannel
    ? async (text: string) => {
        // Respect deadline -- no-op after timeout
        if (payload.deadline && Date.now() > payload.deadline) return;
        // Don't send [skip] signals to channel (LLM may emit [skip] alongside tool calls)
        if (groupContext && isSkipReply(text)) return;
        try {
          await deps.sendChannelMessage(channel, progressToken, chatId, text, progressOptions);
          // In group chat, stop typing after first successful progress send
          // (single chat keeps typing until final reply for better UX)
          if (groupContext && typingAbort) { typingAbort.abort(); typingAbort = null; }
          // Re-send typing immediately — sending a message clears the typing
          // indicator on most platforms (Telegram, Discord). Without this,
          // the user sees no typing for up to 4s until the loop's next cycle.
          if (typingAbort && !typingAbort.signal.aborted) {
            getAdapter(channel)?.sendTyping(progressToken, chatId).catch(() => {});
          }
        } catch (e) {
          log?.error("Progress send failed", { error: String(e) });
        }
      }
    : undefined;

  // When coordinatorOwned, the user message is already in D1 history (persisted
  // by the coordinator before calling bots). Don't append it again as the current
  // turn -- D1 history always ends with a user-role message so the LLM responds
  // naturally. Images are also reconstructed from D1 history.
  const coordinatorOwned = !!(groupContext && payload.coordinatorOwned);
  const appendUserTurn = !coordinatorOwned;

  // In group chat round 1 wave 1, prefix with user name so LLM knows who's speaking
  const llmUserMessage = (!coordinatorOwned && groupContext && groupContext.round <= 1 && (groupContext.wave ?? 1) <= 1)
    ? `[${groupContext.userName}]: ${effectiveUserMessage}`
    : effectiveUserMessage;

  const result = await runAgentLoop({
    model,
    systemPrompt,
    userMessage: llmUserMessage,
    conversationHistory,
    tools,
    maxIterations: botConfig.maxIterations,
    onProgress,
    sendToolHints: options.sendToolHints,
    log,
    botId: botConfig.botId,
    requestId: log?.requestId,
    attachmentParts: appendUserTurn ? attachmentParts : undefined,
    sandboxAnnotation: appendUserTurn ? sandboxAnnotation : undefined,
    appendUserTurn,
    abortSignal: options.abortSignal,
    contextWindowTokens: botConfig.contextWindow,
  });
  const loopDurationMs = Math.round(performance.now() - loopStart);
  let voiceSent = false;

  // --- Tool-output-authoritative image handling ---
  const { normalizedText, attachments, media } = await resolveAndNormalizeReply({
    reply: result.reply,
    toolResults: result.toolResults,
    newMessages: result.newMessages,
    sandboxClient,
    botId: botConfig.botId,
    baseUrl: deps.env.BASE_URL,
    webhookSecret: deps.env.WEBHOOK_SECRET,
  });

  // Skip D1 persistence for [skip] replies (bot chose silence in group chat).
  // Use result.reply (not fullReply) to match handler.ts skip evaluation.
  // Intentionally drops all newMessages including any tool calls -- a bot that
  // ultimately skips has nothing worth persisting in conversation history.
  const shouldPersist = !groupContext || !isSkipReply(result.reply);
  const doPersist = (options.persistMessages ?? true) && shouldPersist;
  if (doPersist) {
    await d1.persistMessages(deps.db, sessionId, result.newMessages);
  }

  // Send reply — with TTS if applicable
  if (options.sendFinalToChannel && (normalizedText || media.length > 0)) {
    const { sendFinalReply, buildTtsPolicy } = await import("../voice/send-reply");
    const ttsPolicy = buildTtsPolicy(botConfig, userKeys);
    const adapter = (await import("../channels/registry")).getAdapter(channel);

    const replyResult = await sendFinalReply(
      {
        text: normalizedText,
        media: media.length > 0 ? media : undefined,
        channelToken,
        chatId,
        ttsPolicy,
        isVoiceMessage: !!payload.isVoiceMessage,
        sttFailed: payload.inputMeta?.sttStatus === "failed",
      },
      {
        sendMessage: (tok, cid, txt, opts) => deps.sendChannelMessage(channel, tok, cid, txt, opts),
        sendAudio: adapter?.sendAudio?.bind(adapter),
      },
    );
    if (replyResult.voiceSent) voiceSent = true;
  }

  // Check if consolidation is needed (non-blocking)
  deps.waitUntil(deps.maybeConsolidate(model, botConfig, sessionId, log));

  // Flush request trace to R2
  if (deps.env.LOG_BUCKET && log?.requestId) {
    const trace: RequestTrace = {
      requestId: log.requestId,
      parentRequestId: payload.parentRequestId,
      botId: botConfig.botId,
      botName: botConfig.name,
      channel,
      chatId,
      sessionId,
      status: "ok",
      startedAt: Date.now() - loopDurationMs,
      durationMs: loopDurationMs,
      model: result.model,
      llmCalls: result.iterations,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      skillCalls: result.skillCalls,
      iterations: result.iterations,
      voiceSent,
      userMessage: userMessage?.slice(0, 200),
      reply: normalizedText?.slice(0, 200),
    };
    deps.waitUntil(log.flush(deps.env.LOG_BUCKET, trace, deps.env.D1_DB));
  }

  return {
    reply: normalizedText,
    imageCount: attachments.length,
    media,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    skillCalls: result.skillCalls,
    model: result.model,
    ...(!(options.persistMessages ?? true) && { newMessages: result.newMessages }),
  };
  } finally {
    // Stop typing indicator — must run on ANY error path (Phase 1-3 failures,
    // runAgentLoop timeout/abort, or post-processing errors).
    if (typingAbort) typingAbort.abort();
  }
}

/**
 * Materialize attachment files to the sandbox filesystem so skills/exec can access them.
 * Returns an annotation string describing the written files, or undefined if none were written.
 */
export async function materializeSandboxFiles(
  sandboxClient: SandboxClient,
  sandboxFiles: SandboxFile[],
  log?: Logger,
): Promise<string | undefined> {
  if (sandboxFiles.length === 0) return undefined;
  try {
    await sandboxClient.mkdir("/tmp/attachments", { recursive: true });
    const results = await Promise.allSettled(
      sandboxFiles.map(async (f) => {
        const base64 = uint8ArrayToBase64(f.data);
        await sandboxClient.writeFile(f.path, base64, { encoding: "base64" });
        return f;
      }),
    );
    const written = results
      .filter((r): r is PromiseFulfilledResult<SandboxFile> => r.status === "fulfilled")
      .map((r) => r.value);
    if (written.length > 0) {
      return written
        .map((f) => `[File available at ${f.path} (${formatSizeCompact(f.sizeBytes)}, ${f.mediaType})]`)
        .join("\n");
    }
    return undefined;
  } catch (e) {
    log?.warn("Sandbox file materialization failed", { error: String(e) });
    return undefined;
  }
}

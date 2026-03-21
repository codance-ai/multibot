import { getAgentByName } from "agents";
import type { Env, AgentRequestPayload } from "./config/schema";
import { getAdapter } from "./channels/registry";
import type { AttachmentRef } from "./channels/registry";
import { extractTelegramFileRefs } from "./channels/telegram";
import { extractSlackFileRefs } from "./channels/slack";
import { downloadAndUploadFiles } from "./utils/file-download";
import type { ChannelFileRef } from "./utils/file-download";
import type { MultibotAgent } from "./agent/multibot";
import type { ChatCoordinator } from "./group/coordinator";
import { defineRoute, dispatch } from "./api/router";
import {
  handleListBots,
  handleCreateBot,
  handleGetBot,
  handleUpdateBot,
  handleDeleteBot,
  handleRestoreBot,
} from "./api/bots";
import { handleBindChannel, handleUnbindChannel } from "./api/channels";
import {
  handleListGroups,
  handleCreateGroup,
  handleGetGroup,
  handleUpdateGroup,
  handleDeleteGroup,
} from "./api/groups";
import { handleGetKeys, handleUpdateKeys } from "./api/keys";
import { handleListSkills, handleDeleteSkill } from "./api/skills";
import { handleListSkillSecrets, handleSetSkillSecret, handleDeleteSkillSecret } from "./api/skill-secrets";
import { handleListLogs, handleListSessions, handleListMessages, handleListSubagentRuns } from "./api/logs";
import { createLogger } from "./utils/logger";
import type { RequestTrace } from "./utils/logger";
import { validateSession, handleLogin, handleLogout, handleAuthCheck } from "./api/auth";
import { handleInternalUpload } from "./api/upload";
import * as configDb from "./db/config";
import * as d1Db from "./db/d1";
import { isAdminBotAuthorized } from "./auth/admin-auth";
import { ensureAdminBot } from "./api/admin-init";
import { reviewMemory } from "./agent/memory";
import { createModel } from "./providers/gateway";

// Re-export Durable Object classes so Cloudflare can find them
export { MultibotAgent } from "./agent/multibot";
export { DiscordGateway } from "./discord/gateway";
export { ChatCoordinator } from "./group/coordinator";

const API_ROUTES = [
  defineRoute("GET", "/api/bots", handleListBots),
  defineRoute("POST", "/api/bots", handleCreateBot),
  defineRoute("GET", "/api/bots/:botId", handleGetBot),
  defineRoute("PUT", "/api/bots/:botId", handleUpdateBot),
  defineRoute("DELETE", "/api/bots/:botId", handleDeleteBot),
  defineRoute("POST", "/api/bots/:botId/restore", handleRestoreBot),
  defineRoute("POST", "/api/bots/:botId/channels/:channel", handleBindChannel),
  defineRoute("DELETE", "/api/bots/:botId/channels/:channel", handleUnbindChannel),
  defineRoute("GET", "/api/groups", handleListGroups),
  defineRoute("POST", "/api/groups", handleCreateGroup),
  defineRoute("GET", "/api/groups/:groupId", handleGetGroup),
  defineRoute("PUT", "/api/groups/:groupId", handleUpdateGroup),
  defineRoute("DELETE", "/api/groups/:groupId", handleDeleteGroup),
  defineRoute("GET", "/api/keys", handleGetKeys),
  defineRoute("PUT", "/api/keys", handleUpdateKeys),
  defineRoute("GET", "/api/skills", handleListSkills),
  defineRoute("DELETE", "/api/skills/:skillName", handleDeleteSkill),
  defineRoute("GET", "/api/skill-secrets", handleListSkillSecrets),
  defineRoute("PUT", "/api/skill-secrets/:skillName", handleSetSkillSecret),
  defineRoute("DELETE", "/api/skill-secrets/:skillName", handleDeleteSkillSecret),
  defineRoute("GET", "/api/logs/sessions", handleListSessions),
  defineRoute("GET", "/api/logs/messages", handleListMessages),
  defineRoute("GET", "/api/logs/subagent-runs", handleListSubagentRuns),
  defineRoute("GET", "/api/logs", handleListLogs),
];

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/" || url.pathname === "/health") {
      return new Response("multibot is running", { status: 200 });
    }

    // Auth endpoints (no session required)
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      return handleLogin(request, env);
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      return handleLogout(request);
    }
    if (url.pathname === "/api/auth/check" && request.method === "GET") {
      return handleAuthCheck(request, env);
    }

    // Internal upload: PUT /upload (token-based auth, not session)
    if (request.method === "PUT" && url.pathname === "/upload") {
      return handleInternalUpload(request, env);
    }

    // API routes: /api/*
    if (url.pathname.startsWith("/api/")) {
      const ownerId = await validateSession(request, env);
      if (!ownerId) {
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      }
      // Auto-create admin bot if needed (non-blocking)
      ctx.waitUntil(ensureAdminBot(env.D1_DB, ownerId).catch((e) => console.warn("[ensureAdminBot] Failed:", e)));
      const result = await dispatch(API_ROUTES, request, env, url.pathname, ownerId);
      if (result) return result;
      return new Response("Not found", { status: 404 });
    }

    // Voice sample preview — serve from R2
    if (url.pathname.startsWith("/voice-samples/") && request.method === "GET") {
      const filename = url.pathname.split("/").pop();
      if (!filename || !env.ASSETS_BUCKET) {
        return new Response("Not found", { status: 404 });
      }
      const obj = await env.ASSETS_BUCKET.get(`voice-samples/${filename}`);
      if (!obj) return new Response("Not found", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "Content-Type": filename.endsWith(".ogg") ? "audio/ogg" : "audio/mpeg",
          "Cache-Control": "public, max-age=86400",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // Media serving: GET /media/*
    if (request.method === "GET" && url.pathname.startsWith("/media/")) {
      return handleMediaServe(env, url.pathname);
    }

    // Channel Webhook: POST /webhook/{channel}/{token}
    const webhookMatch = url.pathname.match(/^\/webhook\/([^/]+)\/(.+)$/);
    if (request.method === "POST" && webhookMatch) {
      const [, channel, token] = webhookMatch;
      return handleWebhook(request, env, ctx, channel, token);
    }

    return new Response("Not found", { status: 404 });
  },

  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const db = env.D1_DB;
    try {
      await d1Db.cleanupRequestTraceIndex(db);
    } catch (e) {
      console.error(
        `[request-trace-index] Cleanup failed:`,
        e instanceof Error ? e.message : String(e)
      );
    }

    const botsWithMemory = await d1Db.getBotsWithMemory(db);
    if (botsWithMemory.length === 0) return;

    for (const { bot_id, owner_id } of botsWithMemory) {
      try {
        const botConfig = await configDb.getBot(db, owner_id, bot_id);
        if (!botConfig) continue;
        // Admin bot manages other bots — its history entries contain other bots'
        // persona details which would pollute its own MEMORY.md. Skip review.
        if (botConfig.botType === "admin") continue;

        const userKeys = await configDb.getUserKeys(db, owner_id);
        if (!userKeys) continue;

        const model = createModel(botConfig, userKeys);
        const updated = await reviewMemory({ model, db, botId: bot_id, contextWindow: botConfig.contextWindow });

        if (updated) {
          console.log(`[memory-review] Updated memory for bot ${bot_id}`);
        }
      } catch (e) {
        console.error(`[memory-review] Failed for bot ${bot_id}:`, e instanceof Error ? e.message : String(e));
      }
    }
  },
};

function formatReplyPrefix(replyToName: string, replyToText?: string): string {
  if (replyToText) {
    const truncated = replyToText.length > 100
      ? replyToText.slice(0, 100) + "..."
      : replyToText;
    return `[Reply to ${replyToName}: "${truncated}"]`;
  }
  return `[Reply to ${replyToName}]`;
}

async function handleWebhook(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  channel: string,
  token: string
): Promise<Response> {
  const adapter = getAdapter(channel);
  // Discord uses WebSocket gateway, not HTTP webhooks
  if (!adapter?.parseWebhook) return new Response("OK", { status: 200 });

  // Parse body once
  const body: any = await request.json();

  // 1. Channel-specific pre-processing (Telegram auth, Slack URL verification)
  const preResponse = adapter.preProcessWebhook?.(request, body, env);
  if (preResponse) return preResponse;

  // 2. Look up token mapping from D1
  const mapping = await configDb.getTokenMapping(env.D1_DB, channel, token);
  if (!mapping) return new Response("Unknown token", { status: 404 });

  // 3. Parse channel-specific update
  const parsed = adapter.parseWebhook(body);
  if (!parsed) return new Response("OK", { status: 200 });
  const { chatId, userId, userName, chatType, messageId, replyToName } = parsed;
  let { userMessage } = parsed;
  const isVoiceMessage = parsed.isVoiceMessage;

  // 3b. Extract & download user-attached files → R2
  let attachments: AttachmentRef[] | undefined;
  if (env.ASSETS_BUCKET) {
    let refs: ChannelFileRef[] = [];
    if (channel === "telegram") {
      refs = extractTelegramFileRefs(body);
    } else if (channel === "slack") {
      refs = extractSlackFileRefs(body, token);
    }
    // Discord files handled in gateway.ts (WebSocket path)
    if (refs.length > 0) {
      const uploaded = await downloadAndUploadFiles(refs, env.ASSETS_BUCKET, mapping.botId, token);
      if (uploaded.length > 0) {
        attachments = uploaded;
      }
    }
  }

  // 4. Route based on chat type — runtime group lookup
  const isGroupChat = chatType !== "private";

  // Early D1 write: any bot with reply context shares it BEFORE the D1 group lookup,
  // giving the processing bot's concurrent request more time to see the value.
  if (isGroupChat && replyToName && parsed.messageDate) {
    try {
      await d1Db.insertReplyHint(env.D1_DB, {
        channel,
        chatId,
        messageDate: parsed.messageDate,
        userId,
        replyToName,
        replyToText: parsed.replyToText?.slice(0, 200),
      });
    } catch (e) {
      // Best-effort: don't fail the webhook on a hint write error
      console.warn("[replyHint] Failed to write reply hint:", e);
    }
  }

  if (isGroupChat) {
    const group = await configDb.findGroupForBot(env.D1_DB, mapping.ownerId, mapping.botId);
    if (group) {
      // Primary bot dedup: only the first bot in the group triggers processing (deterministic, no race)
      if (mapping.botId !== group.botIds[0]) {
        return new Response("OK", { status: 200 });
      }

      // Resolve reply context: use local parsed data or fetch from D1 hint (written by non-processing bot).
      let resolvedReplyToName = replyToName;
      let resolvedReplyToText = parsed.replyToText;
      if (!resolvedReplyToName && parsed.messageDate) {
        const hintKey = { channel, chatId, messageDate: parsed.messageDate, userId };
        const hint = await d1Db.getReplyHint(env.D1_DB, hintKey)
          ?? (await new Promise(resolve => setTimeout(resolve, 50)),
              await d1Db.getReplyHint(env.D1_DB, hintKey));
        if (hint) {
          resolvedReplyToName = hint.replyToName;
          resolvedReplyToText = hint.replyToText;
        }
      }
      if (resolvedReplyToName) {
        userMessage = `${formatReplyPrefix(resolvedReplyToName, resolvedReplyToText)} ${userMessage}`;
      }

      // Piggyback cleanup: delete old hints (non-blocking)
      ctx.waitUntil(d1Db.cleanupReplyHints(env.D1_DB).catch((e) => console.warn("[replyHint] Cleanup failed:", e)));

      const groupLog = createLogger({ channel, chatId, botId: mapping.botId });
      return handleGroupWebhook(env, ctx, channel, token, mapping.ownerId, group.groupId, chatId, userId, userName, userMessage, groupLog.requestId, attachments, parsed.mentions, resolvedReplyToName, messageId, isVoiceMessage);
    }
    // No group found — fall through to single-bot flow
  }

  // Single-bot: prepend reply context directly
  if (replyToName) {
    userMessage = `${formatReplyPrefix(replyToName, parsed.replyToText)} ${userMessage}`;
  }

  // Single-bot flow — load config from D1
  const botConfig = await configDb.getBot(env.D1_DB, mapping.ownerId, mapping.botId);
  if (!botConfig) return new Response("Bot not found", { status: 404 });

  // Admin bot: enforce sender whitelist (#280)
  if (!isAdminBotAuthorized(botConfig, userId)) {
    const rejectToken = channel === "slack"
      ? (botConfig.channels.slack?.token ?? token)
      : token;
    ctx.waitUntil(
      adapter.sendMessage(rejectToken, chatId, "You are not authorized to use this bot.").catch((e) => console.warn("[webhook] Failed to send rejection message:", e))
    );
    return new Response("OK", { status: 200 });
  }

  let channelToken = token;
  if (channel === "slack") {
    channelToken = botConfig.channels.slack?.token ?? token;
  }

  const userKeys = await configDb.getUserKeys(env.D1_DB, mapping.ownerId);
  if (!userKeys)
    return new Response("API keys not configured", { status: 500 });

  const agentId = `chat-${mapping.botId}-${channel}-${chatId}`;
  const log = createLogger({ channel, botId: mapping.botId, chatId });

  log.info("Webhook received");

  const payload: AgentRequestPayload = {
    botConfig,
    userKeys,
    chatId,
    userId,
    userName,
    userMessage,
    channel,
    channelToken,
    parentRequestId: log.requestId,
    attachments,
    ...(isVoiceMessage && { isVoiceMessage: true }),
  };

  // Fire-and-forget: DO returns immediately and processes in the background.
  // DO handles its own errors (send error msg to user, flush trace).
  ctx.waitUntil(
    (async () => {
      try {
        const agent = await getAgentByName<Env, MultibotAgent>(
          env.MULTIBOT_AGENT,
          agentId
        );
        const agentRequest = new Request("https://agent/chat", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        await agent.fetch(agentRequest);
      } catch (e) {
        // Only catches DO instantiation or network errors.
        // Processing errors are handled inside the DO.
        log.error("Failed to dispatch to agent DO", {
          error: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
        });
      }
    })()
  );

  return new Response("OK", { status: 200 });
}

async function handleGroupWebhook(
  env: Env,
  ctx: ExecutionContext,
  channel: string,
  token: string,
  ownerId: string,
  groupId: string,
  chatId: string,
  userId: string,
  userName: string,
  userMessage: string,
  parentRequestId?: string,
  attachments?: AttachmentRef[],
  channelMentions?: string[],
  replyToName?: string,
  messageId?: string,
  isVoiceMessage?: boolean,
): Promise<Response> {
  const log = createLogger({ channel, chatId, groupId, requestId: parentRequestId });

  // Persist group-channel → chatId mapping in D1
  ctx.waitUntil(
    configDb.updateGroupChat(env.D1_DB, ownerId, groupId, channel, chatId)
  );

  // Fire-and-forget to orchestrator DO (no wall-clock limit inside DO)
  const coordinatorId = `coordinator:${groupId}:${channel}:${chatId}`;
  ctx.waitUntil(
    (async () => {
      try {
        const coordinator = await getAgentByName<Env, ChatCoordinator>(
          env.CHAT_COORDINATOR,
          coordinatorId,
        );
        const req = new Request("https://coordinator/turn", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ channel, token, ownerId, groupId, chatId, userId, userName, userMessage, parentRequestId, attachments, channelMentions, replyToName, messageId, ...(isVoiceMessage && { isVoiceMessage: true }) }),
        });
        await coordinator.fetch(req);
      } catch (e) {
        log.error("Failed to dispatch to orchestrator DO", {
          error: e instanceof Error ? e.message : String(e),
          stack: e instanceof Error ? e.stack : undefined,
        });
        // Send error message to group chat (best-effort)
        try {
          const adapter = getAdapter(channel);
          if (adapter) {
            await adapter.sendMessage(token, chatId,
              "Sorry, something went wrong processing your message. Please try again.");
          }
        } catch (e) {
          console.warn("[webhook] Failed to send error message to group:", e);
        }
        if (env.LOG_BUCKET && log.requestId) {
          const trace: RequestTrace = {
            requestId: log.requestId,
            botId: `orchestrator:${groupId}`,
            channel, chatId,
            status: "error",
            startedAt: Date.now(), durationMs: 0,
            llmCalls: 0, inputTokens: 0, outputTokens: 0,
            skillCalls: [], iterations: 0,
            errorMessage: e instanceof Error ? e.message : String(e),
            errorStack: e instanceof Error ? e.stack : undefined,
            userMessage: userMessage?.slice(0, 200),
          };
          await log.flush(env.LOG_BUCKET, trace, env.D1_DB);
        }
      }
    })()
  );

  return new Response("OK", { status: 200 });
}

/**
 * Serve images from ASSETS_BUCKET (R2).
 * GET /media/{botId}/{filename}.png
 */
async function handleMediaServe(env: Env, pathname: string): Promise<Response> {
  const bucket = env.ASSETS_BUCKET;
  if (!bucket) {
    return new Response("Media storage not configured", { status: 500 });
  }

  // pathname is /media/... — R2 key is media/...
  // No auth: intentional — Telegram/Discord fetch images directly by URL.
  // URLs contain UUID and are not guessable.
  const key = pathname.slice(1); // strip leading /
  if (!key.startsWith("media/") || key.includes("..")) {
    return new Response("Not found", { status: 404 });
  }
  const object = await bucket.get(key);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(object.body, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType ?? "image/png",
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
}

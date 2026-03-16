import type { Env, BotConfig, UserKeys, GroupContext } from "../config/schema";
import { getTools, mergeTools } from "../tools/registry";
import { createMemoryTools } from "../tools/memory";
import { createAdminTools } from "../tools/admin";
import { createCronTools } from "../tools/cron";
import type { CronScheduler } from "../tools/cron";
import { createExecTools } from "../tools/exec";
import { createFilesystemTools } from "../tools/filesystem";
import { createWebSearchTool } from "../tools/web-search";
import { createBrowseTools } from "../tools/browse";
import type { SandboxClient } from "../tools/sandbox-types";
import { createSkillHydrator } from "../skills/ensure-ready";
import { findAllGroupsForBot } from "../db/config";
import { createGroupMessageTools } from "../tools/group-message";
import { createSkillTools } from "../tools/skill";
import { createLoadSkillTool } from "../tools/load-skill";
import { BUILTIN_SKILLS, BUILTIN_SKILL_ASSETS } from "../skills/builtin";
import { createMaterializationEngine } from "../skills/materialize";
import { resolveWorkspaceImages } from "../utils/media";
import { generateUploadToken } from "../api/upload";
import { loadMemoryContext, estimateTokens, estimateRowTokens, HISTORY_RECENT_CHAR_LIMIT, HISTORY_OLDER_CHAR_LIMIT, type TokenUsage } from "./memory";
import { buildSystemPrompt } from "./context";
import { convertStoredTimestamp } from "../utils/time";
import { IMAGE_PROVIDER_DEFAULTS } from "./multibot-helpers";
import * as d1 from "../db/d1";
import type { ChatContext } from "../db/d1";
import type { ToolSet, ModelMessage } from "ai";
import type { Logger } from "../utils/logger";
import type { ContentPart } from "../utils/attachment-resolve";
import { isInlineTextType, MAX_INLINE_TEXT_SIZE } from "../utils/attachment-resolve";
import type { ToolCallPart, ToolResultPart } from "ai";

/**
 * Build all tools for the agent loop.
 */
export async function buildAgentTools(params: {
  env: Env;
  db: D1Database;
  botConfig: BotConfig;
  userKeys: UserKeys;
  channel: string;
  chatId: string;
  channelToken: string;
  enableMessageTool: boolean;
  localCronScheduler?: boolean;
  log?: Logger;
  skillSecrets?: Record<string, string>;
  // Callbacks for things that need `this`:
  getSandboxClient: (botId: string) => SandboxClient;
  buildLocalCronScheduler: () => CronScheduler;
  buildRemoteCronScheduler: (botId: string) => CronScheduler;
  ensureMcpConnected: (mcpServers: Record<string, { url: string; headers: Record<string, string> }>, log?: Logger) => Promise<void>;
  getMcpTools: () => ToolSet;
  sendChannelMessage: (ch: string, tok: string, cid: string, text: string) => Promise<void>;
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
}): Promise<{ tools: ToolSet; sandboxClient: SandboxClient; botConfig: BotConfig }> {
  let { botConfig } = params;
  const {
    env, db, userKeys, channel, chatId, channelToken,
    enableMessageTool, log,
  } = params;
  const staticTools = getTools();
  const memoryTools = createMemoryTools(db, botConfig.botId);
  // Admin bots get management tools; normal bots get none (skill tools removed per #280)
  const adminTools = botConfig.botType === "admin"
    ? createAdminTools(env, botConfig.ownerId)
    : {};
  // Use bot's own channel token for cron payloads (fixes group chat channelToken bug)
  const cronToken = botConfig.channels[channel]?.token || channelToken;
  const cronScheduler = params.localCronScheduler
    ? params.buildLocalCronScheduler()
    : params.buildRemoteCronScheduler(botConfig.botId);
  const cronTools = createCronTools(cronScheduler, {
    channel,
    chatId,
    channelToken: cronToken,
    botId: botConfig.botId,
    ownerId: botConfig.ownerId,
  });
  const sandboxClient = params.getSandboxClient(botConfig.botId);
  // Create materialization engine for builtin skill assets
  const materialize = createMaterializationEngine(sandboxClient);
  // Always create hydrator: installed skills are hydrated on-demand when LLM accesses them
  const hydrator = createSkillHydrator({ sandbox: sandboxClient });

  const imageEnv: Record<string, string> = {};
  if (botConfig.imageProvider && userKeys[botConfig.imageProvider] && IMAGE_PROVIDER_DEFAULTS[botConfig.imageProvider]) {
    const imgProvider = botConfig.imageProvider;
    const imgDefaults = IMAGE_PROVIDER_DEFAULTS[imgProvider];
    imageEnv["IMAGE_PROVIDER"] = imgProvider;
    imageEnv["IMAGE_API_KEY"] = userKeys[imgProvider]!;
    imageEnv["IMAGE_MODEL"] = botConfig.imageModel || imgDefaults.model;
    imageEnv["IMAGE_BASE_URL"] = imgDefaults.baseUrl;
  }
  const execSecrets = { ...params.skillSecrets, ...imageEnv };
  // Resolve workspace images immediately after exec (sprite is hot)
  const onExecOutput = params.env.BASE_URL
    ? async (output: string) => {
        const token = await generateUploadToken(botConfig.botId, params.env.WEBHOOK_SECRET);
        const uploadUrl = `${params.env.BASE_URL}/upload?token=${encodeURIComponent(token)}&botId=${encodeURIComponent(botConfig.botId)}`;
        return resolveWorkspaceImages(
          output,
          (cmd) => sandboxClient.exec(cmd, { timeout: 10_000 }),
          uploadUrl,
        );
      }
    : undefined;
  const execTools = createExecTools(
    sandboxClient, Object.keys(execSecrets).length > 0 ? execSecrets : undefined, hydrator,
    materialize, BUILTIN_SKILL_ASSETS, onExecOutput,
  );
  const filesystemTools = createFilesystemTools(
    sandboxClient, materialize, BUILTIN_SKILL_ASSETS,
  );
  const loadSkillTools = createLoadSkillTool(BUILTIN_SKILLS, sandboxClient, hydrator);
  const webSearchTools = createWebSearchTool(userKeys.brave ?? "");
  // Group message tool: available in private chat when bot belongs to groups
  let groupMessageTools = {};
  if (enableMessageTool) {
    const groups = await findAllGroupsForBot(
      env.D1_DB, botConfig.ownerId, botConfig.botId
    );
    if (groups.length > 0) {
      groupMessageTools = createGroupMessageTools(
        (ch, tok, cid, text) => params.sendChannelMessage(ch, tok, cid, text),
        async (groupConfig, ch, cid, senderBotId, message) => {
          const sessionCtx: ChatContext = {
            channel: ch,
            chatId: cid,
            groupId: groupConfig.groupId,
          };
          const sessionId = await d1.getOrCreateSession(db, sessionCtx);
          await d1.persistMessages(db, sessionId, [
            { role: "assistant", content: message, botId: senderBotId, requestId: log?.requestId },
          ]);
        },
        {
          channel,
          channelToken: botConfig.channels[channel]?.token || channelToken,
          botId: botConfig.botId,
          botName: botConfig.name,
          groups,
          dispatchToOrchestrator: (groupConfig, ch, cid, senderBotId, senderBotName, message) => {
            params.dispatchGroupOrchestrator({
              channel: ch,
              token: botConfig.channels[ch]?.token || channelToken,
              ownerId: botConfig.ownerId,
              groupId: groupConfig.groupId,
              chatId: cid,
              senderBotId,
              senderBotName,
              message,
              parentRequestId: log?.requestId,
            });
          },
        },
      );
    }
  }
  const skillTools = botConfig.botType === "admin"
    ? createSkillTools({
        db: env.D1_DB,
        sandbox: sandboxClient,
        botId: botConfig.botId,
        ownerId: botConfig.ownerId,
        getSandboxClient: params.getSandboxClient,
      })
    : {};
  await params.ensureMcpConnected(botConfig.mcpServers ?? {}, log);
  const mcpTools = Object.keys(botConfig.mcpServers ?? {}).length > 0
    ? params.getMcpTools()
    : {};
  const browseResult = createBrowseTools(sandboxClient, env.ASSETS_BUCKET, botConfig.botId, chatId);
  const browseTools = browseResult.tools;
  const tools = mergeTools(
    staticTools, memoryTools, adminTools, cronTools,
    execTools, filesystemTools, loadSkillTools, webSearchTools,
    mcpTools, groupMessageTools, skillTools, browseTools,
  );
  return { tools, sandboxClient, botConfig };
}

/**
 * Build system prompt and load conversation history for a session.
 */
export async function buildPromptAndHistory(params: {
  db: D1Database;
  assetsBucket?: R2Bucket;
  botConfig: BotConfig;
  sessionId: string;
  channel: string;
  chatId: string;
  groupContext?: GroupContext;
  perSkillSecrets?: Record<string, Record<string, string>>;
}): Promise<{ systemPrompt: string; conversationHistory: ModelMessage[]; tokenUsage: TokenUsage }> {
  const { db, assetsBucket, botConfig, sessionId, channel, chatId, groupContext } = params;
  const memoryContext = await loadMemoryContext(db, botConfig.botId);
  const systemPrompt = await buildSystemPrompt({
    botConfig,
    memoryContext,
    db,
    channel,
    chatId,
    groupContext,
    perSkillSecrets: params.perSkillSecrets,
  });
  const historyLimit = (botConfig.memoryWindow ?? 50) * 2;
  let rows = await d1.getConversationHistory(db, sessionId, historyLimit);

  // --- Token-budget history trimming ---
  const contextWindow = botConfig.contextWindow ?? 128000;
  const systemPromptTokens = estimateTokens(systemPrompt);
  // Reserve 25% of context window for LLM output + current user turn + tool schemas
  const historyTokenBudget = Math.floor(contextWindow * 0.75) - systemPromptTokens;

  // How many recent rows get the higher truncation limit (4000 vs 2000 chars).
  // Shared between token estimation and actual truncation to keep them in sync.
  const RECENT_COUNT = 10;
  let trimmedCount = 0;

  if (historyTokenBudget <= 0 && rows.length > 1) {
    // System prompt alone exceeds budget — keep only the newest row
    trimmedCount = rows.length - 1;
    rows = rows.slice(-1);
    console.log(`[build] Token budget exhausted by system prompt, keeping only newest message`);
  } else if (historyTokenBudget > 0 && rows.length > 0) {
    // Estimate tokens per row from newest to oldest, keep rows that fit within budget
    let accumulatedTokens = 0;
    let cutoffIdx = 0; // index in rows (chronological ASC) where we start keeping

    for (let i = rows.length - 1; i >= 0; i--) {
      const isRecent = i >= rows.length - RECENT_COUNT;
      const rowTokens = estimateRowTokens(rows[i], isRecent);
      if (accumulatedTokens + rowTokens > historyTokenBudget && i < rows.length - 1) {
        // This row would exceed budget and it's not the last (newest) row — trim from here
        cutoffIdx = i + 1;
        break;
      }
      accumulatedTokens += rowTokens;
    }

    if (cutoffIdx > 0) {
      trimmedCount = cutoffIdx;
      rows = rows.slice(cutoffIdx);
      console.log(`[build] Token budget trimming: dropped ${trimmedCount} oldest messages (budget: ${historyTokenBudget} tokens)`);
    }
  }

  const historyTokens = rows.reduce((sum, row, idx) => {
    const isRecent = idx >= rows.length - RECENT_COUNT;
    return sum + estimateRowTokens(row, isRecent);
  }, 0);

  const totalTokens = systemPromptTokens + historyTokens;
  const tokenUsage: TokenUsage = {
    systemPromptTokens,
    historyTokens,
    totalTokens,
    contextWindow,
    usageRatio: totalTokens / contextWindow,
    trimmedCount,
  };

  // Reconstruct attachments for recent user messages (max 5 attachment-bearing messages)
  // to balance cost/latency vs multimodal context
  const MAX_HISTORY_ATTACHMENTS = 5;
  /** Truncate older text file attachments in history to limit token usage (chars). */
  const HISTORY_TEXT_ATTACHMENT_LIMIT = 2000;
  let attachmentCount = 0;
  const attachmentRowIndices = new Set<number>();
  // Scan from most recent to find which rows have attachments
  for (let i = rows.length - 1; i >= 0 && attachmentCount < MAX_HISTORY_ATTACHMENTS; i--) {
    if (rows[i].role === "user" && rows[i].attachments) {
      attachmentRowIndices.add(i);
      attachmentCount++;
    }
  }

  // Pre-fetch attachment bytes for qualifying rows (multimodal content only)
  // Sandbox materialization is NOT done here — current-turn attachments are
  // materialized in processChat (Phase 3), and the system prompt tells the LLM
  // to ask the user to re-upload if a history file is missing from /tmp/attachments.
  const attachmentPartsCache = new Map<number, ContentPart[]>();
  // Latest attachment row gets full text; older rows are truncated
  const latestAttachmentIdx = attachmentRowIndices.size > 0
    ? Math.max(...attachmentRowIndices)
    : -1;
  if (attachmentRowIndices.size > 0 && assetsBucket) {
    await Promise.all(
      [...attachmentRowIndices].map(async (idx) => {
        try {
          const parsed = JSON.parse(rows[idx].attachments!) as Array<{ r2Key: string; mediaType: string; fileName?: string }>;
          const parts: ContentPart[] = [];
          for (const att of parsed) {
            const obj = await assetsBucket.get(att.r2Key);
            if (!obj) continue;
            const bytes = new Uint8Array(await obj.arrayBuffer());
            if (att.mediaType.startsWith("image/")) {
              parts.push({ type: "image", image: bytes, mediaType: att.mediaType });
            } else if (att.mediaType === "application/pdf") {
              parts.push({ type: "file", data: bytes, mediaType: att.mediaType });
            } else if (isInlineTextType(att.mediaType) && bytes.byteLength <= MAX_INLINE_TEXT_SIZE) {
              let text = new TextDecoder().decode(bytes);
              const label = att.fileName ? `[File: ${att.fileName}]` : `[File: ${att.mediaType}]`;
              // Truncate older history text attachments to limit token usage
              if (idx !== latestAttachmentIdx && text.length > HISTORY_TEXT_ATTACHMENT_LIMIT) {
                text = text.slice(0, HISTORY_TEXT_ATTACHMENT_LIMIT) + "\u2026[truncated]";
              }
              parts.push({ type: "text", text: `${label}\n${text}` });
            }
            // Skip other types in history (oversized text files have metadata already in message)
          }
          if (parts.length > 0) attachmentPartsCache.set(idx, parts);
        } catch (e) {
          // Skip malformed attachments JSON
          console.warn("[build] Malformed attachments JSON:", e);
        }
      })
    );
  }

  // Find the last user message index (current turn -- never truncated)
  let lastUserIdx = -1;
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].role === "user") { lastUserIdx = i; break; }
  }

  const conversationHistory: ModelMessage[] = rows.flatMap((row, idx) => {
    const ts = row.created_at ? convertStoredTimestamp(row.created_at, botConfig.timezone) : "";
    let text = row.content ?? "";

    // Apply tiered truncation (skip current turn)
    if (idx !== lastUserIdx) {
      const isRecent = idx >= rows.length - RECENT_COUNT;
      const limit = isRecent ? HISTORY_RECENT_CHAR_LIMIT : HISTORY_OLDER_CHAR_LIMIT;
      if (text.length > limit) {
        text = text.slice(0, limit) + "\u2026";
      }
    }

    if (row.role === "user") {
      if (groupContext) {
        text = `[${ts}] [${groupContext.userName}]: ${text}`;
      } else if (ts) {
        text = `[${ts}] ${text}`;
      }
      // Include multimodal attachment parts for qualifying history rows
      const cachedParts = attachmentPartsCache.get(idx);
      if (cachedParts) {
        const content: any[] = [{ type: "text" as const, text }, ...cachedParts];
        return [{ role: "user" as const, content }];
      }
      // For user messages with attachments that were NOT reconstructed as multimodal,
      // add a plain text annotation (not in assistant content — avoids LLM echo).
      // Skip if message already contains specific [Attached: ...] metadata (from effectiveUserMessage).
      if (row.attachments && !cachedParts && !text.includes("[Attached:")) {
        try {
          const atts = JSON.parse(row.attachments) as Array<{ mediaType?: string }>;
          if (Array.isArray(atts) && atts.length > 0) {
            const imgs = atts.filter(a => a.mediaType?.startsWith("image/")).length;
            const fls = atts.filter(a => !a.mediaType?.startsWith("image/")).length;
            const parts: string[] = [];
            if (imgs > 0) parts.push(`${imgs} image${imgs > 1 ? "s" : ""}`);
            if (fls > 0) parts.push(`${fls} file${fls > 1 ? "s" : ""}`);
            if (parts.length > 0) {
              text = `[User attached ${parts.join(", ")}]\n${text}`;
            }
          }
        } catch (e) {
          console.warn("[build] Failed to parse user attachments JSON:", e);
        }
      }
      return [{ role: "user" as const, content: [{ type: "text" as const, text }] }];
    }

    // --- Assistant messages ---

    if (row.role === "assistant") {
      if (groupContext && row.bot_id && row.bot_id !== botConfig.botId) {
        // Other bot's assistant message -> show as user perspective
        const member = groupContext.members.find(m => m.botId === row.bot_id);
        const name = member?.botName ?? row.bot_id;
        const groupText = `<group_reply from="${name}" at="${ts}">\n${text}\n</group_reply>`;
        return [{
          role: "user" as const,
          content: [{ type: "text" as const, text: groupText }],
        }];
      }

      // Reconstruct native tool call/result messages from stored tool_calls JSON
      if (row.tool_calls) {
        try {
          const parsed = JSON.parse(row.tool_calls) as Array<{
            toolCallId: string;
            toolName: string;
            input: unknown;
            result?: string;
          }>;
          if (Array.isArray(parsed) && parsed.length > 0) {
            const messages: ModelMessage[] = [];

            // Assistant message with tool-call parts (+ optional text)
            const assistantParts: Array<{ type: "text"; text: string } | ToolCallPart> = [];
            if (text) {
              assistantParts.push({ type: "text" as const, text });
            }
            for (const tc of parsed) {
              assistantParts.push({
                type: "tool-call" as const,
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                input: tc.input ?? {},
              });
            }
            messages.push({ role: "assistant" as const, content: assistantParts });

            // Tool result messages
            const resultParts: ToolResultPart[] = [];
            for (const tc of parsed) {
              resultParts.push({
                type: "tool-result" as const,
                toolCallId: tc.toolCallId,
                toolName: tc.toolName,
                output: { type: "text" as const, value: tc.result ?? "" },
              });
            }
            if (resultParts.length > 0) {
              messages.push({ role: "tool" as const, content: resultParts });
            }

            return messages;
          }
        } catch (e) {
          console.warn("[build] Failed to parse tool_calls JSON:", e);
        }
      }

      // Plain assistant message (no tool calls)
      if (!text) return []; // skip empty rows
    }

    // Convert 'subagent' role to 'user' for LLM consumption (all providers support 'user')
    const llmRole = row.role === "subagent" ? "user" : row.role;
    return [{
      role: llmRole as "user" | "assistant",
      content: [{ type: "text" as const, text }],
    }];
  });
  return { systemPrompt, conversationHistory, tokenUsage };
}

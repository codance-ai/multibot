import { DurableObject } from "cloudflare:workers";
import type { Env, AgentRequestPayload } from "../config/schema";
import { getAgentByName } from "agents";
import type { MultibotAgent } from "../agent/multibot";
import type { ChatCoordinator } from "../group/coordinator";
import { createLogger } from "../utils/logger";
import type { Logger, RequestTrace } from "../utils/logger";
import * as configDb from "../db/config";
import type { AttachmentRef } from "../channels/registry";
import { downloadAndUploadFiles } from "../utils/file-download";
import type { ChannelFileRef } from "../utils/file-download";

const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";

/** GUILDS(1) | GUILD_MESSAGES(512) | DIRECT_MESSAGES(4096) | MESSAGE_CONTENT(32768) */
const INTENTS = 1 | 512 | 4096 | 32768; // 37377

/** Op codes */
const OP_DISPATCH = 0;
const OP_HEARTBEAT = 1;
const OP_IDENTIFY = 2;
const OP_RECONNECT = 7;
const OP_INVALID_SESSION = 9;
const OP_HELLO = 10;
const OP_HEARTBEAT_ACK = 11;

/** Base reconnect delay in ms (exponential backoff: 5s, 10s, 20s, 40s, 60s cap) */
const RECONNECT_BASE_DELAY = 5_000;
/** Maximum reconnect delay in ms */
const RECONNECT_MAX_DELAY = 60_000;
/** Alarm interval for health check (60s) */
const ALARM_INTERVAL = 60_000;

/**
 * Discord gateway close codes that indicate non-recoverable errors.
 * Reconnecting with the same config will always fail for these.
 * https://discord.com/developers/docs/events/gateway#disconnections
 */
export const NON_RECOVERABLE_CLOSE_CODES = new Set([
  4004, // Authentication failed
  4010, // Invalid shard
  4011, // Sharding required
  4012, // Invalid API version
  4013, // Invalid intent(s)
  4014, // Disallowed intent(s)
]);

export interface GatewayPayload {
  op: number;
  d: any;
  s?: number | null;
  t?: string | null;
}

export interface DiscordMessage {
  id: string;
  channel_id: string;
  content: string;
  author: {
    id: string;
    username: string;
    bot?: boolean;
  };
  guild_id?: string;
  attachments?: {
    id: string;
    url: string;
    content_type?: string;
    size?: number;
    filename?: string;
  }[];
  mentions?: { id: string; username: string }[];
}

interface GatewayConfig {
  botToken: string;
  ownerId: string;
  botId?: string;
}

/** Parse raw WebSocket message into a GatewayPayload, or null on failure. */
export function parseGatewayPayload(raw: string): GatewayPayload | null {
  try {
    return JSON.parse(raw) as GatewayPayload;
  } catch {
    console.warn("[discord] Invalid gateway payload JSON");
    return null;
  }
}

/** Return true if the message should be handled (not a bot, has content or usable attachment). */
export function shouldHandleMessage(msg: DiscordMessage): boolean {
  if (msg.author.bot) return false;
  const hasContent = !!msg.content;
  const hasUsableAttachment = msg.attachments?.some(a => a.content_type && a.url) ?? false;
  return hasContent || hasUsableAttachment;
}

/** Extract file attachment refs from a Discord message (all types). */
export function extractDiscordFileRefs(msg: DiscordMessage): ChannelFileRef[] {
  if (!msg.attachments) return [];
  return msg.attachments
    .filter(a => a.content_type && a.url)
    .map(a => ({
      downloadUrl: a.url,
      mediaType: a.content_type!,
      fileName: a.filename,
    }));
}

/** Check if a Discord attachment is an audio file */
export function isAudioAttachment(attachment: { content_type?: string }): boolean {
  return !!attachment.content_type?.startsWith("audio/");
}

/** Build the op:2 IDENTIFY payload for Discord Gateway. */
export function buildIdentifyPayload(token: string) {
  return {
    op: OP_IDENTIFY,
    d: {
      token,
      intents: INTENTS,
      properties: {
        os: "multibot",
        browser: "multibot",
        device: "multibot",
      },
    },
  };
}

export class DiscordGateway extends DurableObject<Env> {
  private ws: WebSocket | null = null;
  private seq: number | null = null;
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private botToken: string | null = null;
  private botId: string | null = null;
  private ownerId: string | null = null;
  private connected = false;
  private lastAckAt = 0;
  private reconnectAttempt = 0;
  private log: Logger = createLogger({ requestId: "discord-gateway" });

  async onStart(): Promise<void> {
    // Load stored config
    const stored = await this.ctx.storage.get<GatewayConfig>("config");
    if (stored) {
      this.botToken = stored.botToken;
      this.botId = stored.botId ?? null;
      this.ownerId = stored.ownerId;
      this.log = this.log.child({ botId: stored.botId });
      this.connect();
    }
    // Schedule health-check alarm
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL);
  }

  /**
   * Called to initialize the gateway with credentials.
   * Group routing is determined at runtime via findGroupForBot lookup.
   */
  async configure(
    botToken: string,
    ownerId: string,
    opts: { botId?: string },
  ): Promise<void> {
    this.botToken = botToken;
    this.botId = opts.botId ?? null;
    this.ownerId = ownerId;
    this.log = this.log.child({ botId: this.botId ?? undefined });
    const config: GatewayConfig = {
      botToken,
      ownerId,
      ...(this.botId && { botId: this.botId }),
    };
    await this.ctx.storage.put("config", config);
    if (!this.connected) {
      this.connect();
    }
  }

  /**
   * Fully shut down this gateway: disconnect, clear state, remove stored config.
   * Called during bot deletion cascade.
   */
  async shutdown(): Promise<void> {
    // Clear in-memory state
    this.botToken = null;
    this.botId = null;
    this.ownerId = null;
    this.connected = false;

    // Clear heartbeat
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    // Close WebSocket
    if (this.ws) {
      try { this.ws.close(); } catch (e) { console.warn("[discord] WebSocket close failed:", e); }
      this.ws = null;
    }

    // Delete stored config so onStart won't reconnect
    await this.ctx.storage.delete("config");

    // Cancel alarm
    await this.ctx.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    // Health check: reconnect if not connected
    if (!this.connected && this.botToken) {
      this.log.info("Alarm: reconnecting");
      this.connect();
    }
    // Re-schedule alarm
    await this.ctx.storage.setAlarm(Date.now() + ALARM_INTERVAL);
  }

  private connect(): void {
    if (this.ws) {
      try { this.ws.close(); } catch (e) { console.warn("[discord] WebSocket close failed on reconnect:", e); }
      this.ws = null;
    }
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    try {
      const ws = new WebSocket(DISCORD_GATEWAY_URL);
      this.ws = ws;

      ws.addEventListener("message", (event) => {
        this.onMessage(event.data as string);
      });

      ws.addEventListener("close", (event) => {
        this.log.info("WebSocket closed", { code: event.code, reason: event.reason });
        this.connected = false;
        if (NON_RECOVERABLE_CLOSE_CODES.has(event.code)) {
          this.log.error("Non-recoverable close code, not reconnecting", { code: event.code });
          return;
        }
        this.scheduleReconnect();
      });

      ws.addEventListener("error", () => {
        this.log.error("WebSocket error");
        this.connected = false;
      });

      ws.addEventListener("open", () => {
        this.log.info("WebSocket opened");
      });
    } catch (error) {
      this.log.error("Failed to create WebSocket", {
        error: error instanceof Error ? error.message : String(error),
      });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    const attempt = this.reconnectAttempt++;
    const delay = Math.min(
      RECONNECT_BASE_DELAY * Math.pow(2, attempt) + Math.random() * 1000,
      RECONNECT_MAX_DELAY,
    );
    this.log.info("Scheduling reconnect", { attempt, delayMs: Math.round(delay) });
    setTimeout(() => {
      if (!this.connected && this.botToken) {
        this.connect();
      }
    }, delay);
  }

  private onMessage(raw: string): void {
    const payload = parseGatewayPayload(raw);
    if (!payload) {
      this.log.error("Invalid JSON", { raw: raw.slice(0, 200) });
      return;
    }

    // Update sequence number
    if (payload.s !== null && payload.s !== undefined) {
      this.seq = payload.s;
    }

    switch (payload.op) {
      case OP_HELLO:
        this.handleHello(payload.d);
        break;
      case OP_DISPATCH:
        this.handleDispatch(payload.t ?? "", payload.d);
        break;
      case OP_HEARTBEAT_ACK:
        this.lastAckAt = Date.now();
        break;
      case OP_RECONNECT:
        this.log.info("Server requested reconnect");
        this.connected = false;
        this.ws?.close();
        break;
      case OP_INVALID_SESSION:
        this.log.info("Invalid session, reconnecting");
        this.connected = false;
        this.ws?.close();
        break;
      default:
        break;
    }
  }

  private handleHello(d: { heartbeat_interval: number }): void {
    const interval = d.heartbeat_interval;

    // Start heartbeat with zombie detection
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval);
    this.lastAckAt = Date.now();
    this.heartbeatInterval = setInterval(() => {
      // If no ACK received since last heartbeat, connection is zombied
      if (this.lastAckAt > 0 && Date.now() - this.lastAckAt > interval + 5_000) {
        this.log.warn("Heartbeat ACK timeout, reconnecting");
        this.connected = false;
        this.ws?.close(4000, "Heartbeat ACK timeout");
        return;
      }
      this.sendWs({ op: OP_HEARTBEAT, d: this.seq });
    }, interval);

    // Send IDENTIFY
    this.sendWs(buildIdentifyPayload(this.botToken!));

    this.connected = true;
    this.reconnectAttempt = 0; // Reset backoff on successful connection
    this.log.info("Identified", { heartbeatMs: interval });
  }

  private handleDispatch(eventName: string, d: any): void {
    if (eventName === "READY") {
      this.log.info("READY", { user: `${d.user?.username}#${d.user?.discriminator}` });
      return;
    }

    if (eventName === "MESSAGE_CREATE") {
      this.handleMessageCreate(d as DiscordMessage);
    }
  }

  private handleMessageCreate(msg: DiscordMessage): void {
    if (!shouldHandleMessage(msg)) return;

    const channelId = msg.channel_id;
    const userId = msg.author.id;
    const userName = msg.author.username;
    const userMessage = msg.content;
    const channelMentions = (msg.mentions ?? []).map(u => u.id);

    // Extract and download Discord file attachments → R2
    const fileRefs = extractDiscordFileRefs(msg);
    const isVoiceMessage = msg.attachments?.some(a => isAudioAttachment(a)) ?? false;

    const discordMessageId = msg.id;

    // Route based on whether this is a guild (server) message or DM
    this.ctx.waitUntil(
      (async () => {
        let attachments: AttachmentRef[] | undefined;
        if (fileRefs.length > 0 && this.env.ASSETS_BUCKET && this.botId) {
          const uploaded = await downloadAndUploadFiles(fileRefs, this.env.ASSETS_BUCKET, this.botId);
          if (uploaded.length > 0) attachments = uploaded;
        }
        await this.routeMessage(channelId, userId, userName, userMessage, msg.guild_id, attachments, channelMentions, discordMessageId, isVoiceMessage);
      })()
    );
  }

  private async routeMessage(
    channelId: string,
    userId: string,
    userName: string,
    userMessage: string,
    guildId?: string,
    attachments?: AttachmentRef[],
    channelMentions?: string[],
    messageId?: string,
    isVoiceMessage?: boolean,
  ): Promise<void> {
    if (!this.botId || !this.ownerId) return;

    // Guild messages: try runtime group lookup via D1
    if (guildId) {
      const group = await configDb.findGroupForBot(this.env.D1_DB, this.ownerId, this.botId);
      if (group) {
        await this.routeToGroup(channelId, userId, userName, userMessage, group.groupId, attachments, channelMentions, messageId, isVoiceMessage);
        return;
      }
    }

    // DM or no group found: single-bot flow
    await this.routeToAgent(channelId, userId, userName, userMessage, attachments, isVoiceMessage);
  }

  private async routeToGroup(
    channelId: string,
    userId: string,
    userName: string,
    userMessage: string,
    groupId: string,
    attachments?: AttachmentRef[],
    channelMentions?: string[],
    messageId?: string,
    isVoiceMessage?: boolean,
  ): Promise<void> {
    const startedAt = Date.now();
    const routeLog = this.log.child({ requestId: crypto.randomUUID(), chatId: channelId });
    try {
      if (!this.ownerId || !this.botToken) {
        routeLog.error("Missing group config");
        return;
      }
      // Persist group-channel → chatId mapping in D1
      this.ctx.waitUntil(
        configDb.updateGroupChat(this.env.D1_DB, this.ownerId, groupId, "discord", channelId)
      );

      const coordinatorId = `coordinator:${groupId}:discord:${channelId}`;
      const coordinator = await getAgentByName<Env, ChatCoordinator>(
        this.env.CHAT_COORDINATOR,
        coordinatorId,
      );
      const req = new Request("https://coordinator/turn", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: "discord",
          token: this.botToken,
          ownerId: this.ownerId,
          groupId,
          chatId: channelId,
          userId,
          userName,
          userMessage,
          attachments,
          channelMentions,
          messageId,
          ...(isVoiceMessage && { isVoiceMessage: true }),
        }),
      });
      await coordinator.fetch(req);
    } catch (error) {
      routeLog.error("routeToGroup failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.env.LOG_BUCKET && routeLog.requestId) {
        const trace: RequestTrace = {
          requestId: routeLog.requestId,
          botId: `orchestrator:${groupId}`,
          channel: "discord", chatId: channelId,
          status: "error",
          startedAt, durationMs: Date.now() - startedAt,
          llmCalls: 0, inputTokens: 0, outputTokens: 0,
          skillCalls: [], iterations: 0,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
          userMessage: userMessage?.slice(0, 200),
        };
        await routeLog.flush(this.env.LOG_BUCKET, trace, this.env.D1_DB);
      }
    }
  }

  private async routeToAgent(
    channelId: string,
    userId: string,
    userName: string,
    userMessage: string,
    attachments?: AttachmentRef[],
    isVoiceMessage?: boolean,
  ): Promise<void> {
    const startedAt = Date.now();
    const routeLog = this.log.child({ requestId: crypto.randomUUID(), chatId: channelId });
    try {
      if (!this.botId || !this.ownerId || !this.botToken) {
        routeLog.error("Missing bot config");
        return;
      }

      // Load BotConfig from D1
      const botConfig = await configDb.getBot(this.env.D1_DB, this.ownerId, this.botId);
      if (!botConfig) {
        routeLog.error("BotConfig not found");
        return;
      }

      // Load UserKeys from D1
      const userKeys = await configDb.getUserKeys(this.env.D1_DB, this.ownerId);
      if (!userKeys) {
        routeLog.error("UserKeys not found");
        return;
      }

      // Build agent ID: chat-{botId}-discord-{channelId}
      const agentId = `chat-${this.botId}-discord-${channelId}`;

      const payload: AgentRequestPayload = {
        botConfig,
        userKeys,
        chatId: channelId,
        userId,
        userName,
        userMessage,
        channel: "discord",
        channelToken: this.botToken,
        parentRequestId: routeLog.requestId,
        attachments,
        ...(isVoiceMessage && { isVoiceMessage: true }),
      };

      const agent = await getAgentByName<Env, MultibotAgent>(
        this.env.MULTIBOT_AGENT,
        agentId
      );
      const agentRequest = new Request("https://agent/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      await agent.fetch(agentRequest);
    } catch (error) {
      routeLog.error("routeToAgent failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (this.env.LOG_BUCKET && routeLog.requestId) {
        const trace: RequestTrace = {
          requestId: routeLog.requestId,
          botId: this.botId ?? undefined,
          channel: "discord", chatId: channelId,
          status: "error",
          startedAt, durationMs: Date.now() - startedAt,
          llmCalls: 0, inputTokens: 0, outputTokens: 0,
          skillCalls: [], iterations: 0,
          errorMessage: error instanceof Error ? error.message : String(error),
          errorStack: error instanceof Error ? error.stack : undefined,
          userMessage: userMessage?.slice(0, 200),
        };
        await routeLog.flush(this.env.LOG_BUCKET, trace, this.env.D1_DB);
      }
    }
  }

  private sendWs(data: object): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}

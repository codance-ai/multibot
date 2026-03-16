import { z } from "zod";
import type { MultibotAgent } from "../agent/multibot";
import type { DiscordGateway } from "../discord/gateway";
import type { AttachmentRef } from "../channels/registry";

// -- Cloudflare bindings --

export interface Env {
  D1_DB: D1Database;
  MULTIBOT_AGENT: DurableObjectNamespace<MultibotAgent>;
  DISCORD_GATEWAY: DurableObjectNamespace<DiscordGateway>;
  CHAT_COORDINATOR: DurableObjectNamespace;
  WEBHOOK_SECRET: string;
  DASHBOARD_PASSWORD?: string;
  OWNER_ID?: string;
  LOG_BUCKET?: R2Bucket;
  ASSETS_BUCKET?: R2Bucket;
  BASE_URL?: string;
  // Sprites sandbox config
  SPRITES_TOKEN?: string;     // Fly.io Sprites API token
  AI?: Ai;
}

// -- Bot config: stored in D1 "bots" table --

export const BotConfigSchema = z.object({
  botId: z.string(),
  name: z.string().min(1, "Name is required"),
  ownerId: z.string(),
  // Bootstrap files (aligned with nanobot's BOOTSTRAP_FILES)
  soul: z.string().default(""),
  agents: z.string().default(""),
  user: z.string().default(""),
  tools: z.string().default(""),
  identity: z.string().default(""),
  provider: z.enum(["openai", "anthropic", "google", "deepseek", "moonshot", "xai"]),
  model: z.string().min(1, "Model is required"),
  baseUrl: z.string().optional(),
  avatarUrl: z.string().optional(),
  channels: z.record(z.string(), z.object({
    token: z.string(),
    webhookUrl: z.string().optional(),
    channelUsername: z.string().optional(),
    channelUserId: z.string().optional(),
  })).default({}),
  enabledSkills: z.array(z.string()).default([]),
  maxIterations: z.number().default(10),
  memoryWindow: z.number().default(50),
  contextWindow: z.number().default(128000),
  timezone: z.string().optional(),
  imageProvider: z.enum(["openai", "xai", "google"]).optional(),
  imageModel: z.string().optional(),
  mcpServers: z.record(z.string(), z.object({
    url: z.string(),
    headers: z.record(z.string(), z.string()).default({}),
  })).default({}),
  subagent: z.object({
    maxSpawnDepth: z.number().optional(),
    maxChildrenPerSession: z.number().optional(),
    subagentTimeout: z.number().optional(),
  }).optional(),
  botType: z.enum(["normal", "admin"]).default("normal"),
  allowedSenderIds: z.array(z.string()).default([]),
  sttEnabled: z.boolean().default(false),
  voiceMode: z.enum(["off", "always", "mirror"]).default("off"),
  ttsProvider: z.enum(["elevenlabs", "fish"]).default("fish"),
  ttsVoice: z.string().default(""),
  ttsModel: z.string().default("s2-pro"),
});

export type BotConfig = z.infer<typeof BotConfigSchema>;

// -- Schemas for Bot CRUD API --

export const CreateBotSchema = BotConfigSchema.omit({ botId: true, ownerId: true, botType: true });
export const UpdateBotSchema = CreateBotSchema.partial();

// -- Schemas for Channel & Key API --

export const BindChannelSchema = z.object({
  token: z.string(),
  webhookUrl: z.string().optional(),
});
export const UpdateKeysSchema = z.object({
  openai: z.string().nullable().optional(),
  anthropic: z.string().nullable().optional(),
  google: z.string().nullable().optional(),
  deepseek: z.string().nullable().optional(),
  moonshot: z.string().nullable().optional(),
  brave: z.string().nullable().optional(),
  xai: z.string().nullable().optional(),
  elevenlabs: z.string().nullable().optional(),
  fish: z.string().nullable().optional(),
});

// -- Group config: stored in D1 "groups" table --

export const GroupConfigSchema = z.object({
  groupId: z.string(),
  name: z.string().min(1, "Name is required"),
  ownerId: z.string(),
  botIds: z.array(z.string()).min(1, "At least one bot is required"),
  note: z.string().default(""),
  orchestratorProvider: z.enum(["openai", "anthropic", "google"]).default("anthropic"),
  orchestratorModel: z.string().default("claude-sonnet-4-6"),
  channel: z.string().optional(),
  chatId: z.string().optional(),
});

export type GroupConfig = z.infer<typeof GroupConfigSchema>;

export const CreateGroupSchema = GroupConfigSchema.omit({
  groupId: true,
  ownerId: true,
  channel: true,
  chatId: true,
});
export const UpdateGroupSchema = CreateGroupSchema.partial();

// -- Token mapping: stored in D1 "channel_tokens" table --
// Group routing is determined at runtime via findGroupForBot lookup

export const TokenMappingSchema = z.object({
  ownerId: z.string(),
  botId: z.string(),
});

export type TokenMapping = z.infer<typeof TokenMappingSchema>;

// -- User API keys: stored in D1 "user_keys" table --

export const UserKeysSchema = z.object({
  openai: z.string().optional(),
  anthropic: z.string().optional(),
  google: z.string().optional(),
  deepseek: z.string().optional(),
  moonshot: z.string().optional(),
  brave: z.string().optional(),
  xai: z.string().optional(),
  elevenlabs: z.string().optional(),
  fish: z.string().optional(),
});

export type UserKeys = z.infer<typeof UserKeysSchema>;

// -- Telegram webhook payload (subset) --

export const TelegramUpdateSchema = z.object({
  update_id: z.number(),
  message: z
    .object({
      message_id: z.number(),
      chat: z.object({
        id: z.number(),
        type: z.enum(["private", "group", "supergroup", "channel"]),
      }),
      from: z
        .object({
          id: z.number(),
          first_name: z.string(),
          username: z.string().optional(),
        })
        .optional(),
      text: z.string().optional(),
      caption: z.string().optional(),
      entities: z.array(z.object({
        type: z.string(),
        offset: z.number(),
        length: z.number(),
        user: z.object({
          id: z.number(),
          first_name: z.string(),
          username: z.string().optional(),
        }).optional(),
      })).optional(),
      caption_entities: z.array(z.object({
        type: z.string(),
        offset: z.number(),
        length: z.number(),
        user: z.object({
          id: z.number(),
          first_name: z.string(),
          username: z.string().optional(),
        }).optional(),
      })).optional(),
      photo: z
        .array(
          z.object({
            file_id: z.string(),
            file_size: z.number().optional(),
            width: z.number().optional(),
            height: z.number().optional(),
          })
        )
        .optional(),
      document: z
        .object({
          file_id: z.string(),
          file_name: z.string().optional(),
          mime_type: z.string().optional(),
          file_size: z.number().optional(),
        })
        .optional(),
      voice: z
        .object({
          file_id: z.string(),
          duration: z.number(),
          file_size: z.number().optional(),
        })
        .optional(),
      audio: z
        .object({
          file_id: z.string(),
          duration: z.number(),
          file_size: z.number().optional(),
          mime_type: z.string().optional(),
          file_name: z.string().optional(),
        })
        .optional(),
      date: z.number(),
      reply_to_message: z
        .object({
          from: z
            .object({
              first_name: z.string(),
              username: z.string().optional(),
            })
            .optional(),
          text: z.string().optional(),
          caption: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>;

// -- Payload passed from Gateway to Agent --

export interface GroupContext {
  groupId: string;
  groupName: string;
  members: { botId: string; botName: string }[];
  userName: string;
  note: string;
  round: number;
  wave?: number;
}

/** Metadata about voice input modality */
export interface InputMeta {
  mode: "voice";
  sttStatus: "success" | "failed";
  audioDurationSec?: number;
}

export interface AgentRequestPayload {
  botConfig: BotConfig;
  userKeys: UserKeys;
  chatId: string;
  userId: string;
  userName: string;
  userMessage: string;
  channel: string;
  channelToken: string;
  groupContext?: GroupContext;
  sessionId?: string;
  requestId?: string;
  parentRequestId?: string;
  attachments?: AttachmentRef[];
  /** When true, ChatCoordinator owns persistence — bot DO should skip D1 writes */
  coordinatorOwned?: boolean;
  /** Unix timestamp (ms) after which progress sends and typing should no-op */
  deadline?: number;
  isVoiceMessage?: boolean;
  inputMeta?: InputMeta;
}

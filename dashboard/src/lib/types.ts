export interface BotConfig {
  botId: string;
  name: string;
  ownerId: string;
  soul: string;
  agents: string;
  user: string;
  tools: string;
  identity: string;
  provider: "openai" | "anthropic" | "google" | "deepseek" | "moonshot" | "xai";
  model: string;
  baseUrl?: string;
  avatarUrl?: string;
  imageProvider?: "openai" | "xai" | "google";
  imageModel?: string;
  channels: Record<string, { token: string; webhookUrl?: string }>;
  enabledSkills: string[];
  maxIterations: number;
  memoryWindow: number;
  timezone?: string;
  mcpServers: Record<string, { url: string; headers: Record<string, string> }>;
  botType: "normal" | "admin";
  allowedSenderIds: string[];
  sttEnabled?: boolean;
  voiceMode?: "off" | "always" | "mirror";
  ttsProvider?: "elevenlabs" | "fish";
  ttsVoice?: string;
  ttsModel?: string;
}

export interface CreateBotInput {
  name: string;
  soul?: string;
  agents?: string;
  user?: string;
  tools?: string;
  identity?: string;
  provider: "openai" | "anthropic" | "google" | "deepseek" | "moonshot" | "xai";
  model: string;
  baseUrl?: string;
  avatarUrl?: string;
  imageProvider?: "openai" | "xai" | "google";
  imageModel?: string;
  channels?: Record<string, { token: string; webhookUrl?: string }>;
  enabledSkills?: string[];
  maxIterations?: number;
  memoryWindow?: number;
  timezone?: string;
  mcpServers?: Record<string, { url: string; headers: Record<string, string> }>;
  allowedSenderIds?: string[];
  sttEnabled?: boolean;
  voiceMode?: "off" | "always" | "mirror";
  ttsProvider?: "elevenlabs" | "fish";
  ttsVoice?: string;
  ttsModel?: string;
}

export type UpdateBotInput = Partial<CreateBotInput>;

export interface MaskedKeys {
  openai: string | null;
  anthropic: string | null;
  google: string | null;
  deepseek: string | null;
  moonshot: string | null;
  brave: string | null;
  xai: string | null;
  elevenlabs: string | null;
  fish: string | null;
}

export interface UpdateKeysInput {
  openai?: string | null;
  anthropic?: string | null;
  google?: string | null;
  deepseek?: string | null;
  moonshot?: string | null;
  brave?: string | null;
  xai?: string | null;
  elevenlabs?: string | null;
  fish?: string | null;
}

// -- Groups --

export interface GroupConfig {
  groupId: string;
  name: string;
  ownerId: string;
  botIds: string[];
  note?: string;
  orchestratorProvider?: "openai" | "anthropic" | "google";
  orchestratorModel?: string;
  availableChannels?: string[];
}

export interface GroupResponse extends GroupConfig {
  warnings?: string[];
}

export interface CreateGroupInput {
  name: string;
  botIds: string[];
  note?: string;
  orchestratorProvider?: "openai" | "anthropic" | "google";
  orchestratorModel?: string;
}

export type UpdateGroupInput = Partial<CreateGroupInput>;

// -- Debug / Logs --

export interface SkillToolCall {
  name: string;
  input: string;
  result: string;
  isError: boolean;
}

export interface SkillCall {
  skill: string;
  tools: SkillToolCall[];
}

export interface RequestTrace {
  requestId: string;
  parentRequestId?: string;
  botId?: string;
  botName?: string;
  channel?: string;
  chatId?: string;
  sessionId?: string;
  status: "ok" | "error";
  startedAt?: number;
  durationMs: number;
  model?: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  skillCalls?: SkillCall[];
  iterations: number;
  voiceSent?: boolean;
  errorMessage?: string;
  errorStack?: string;
  userMessage?: string;
  reply?: string;
  botCalls?: Array<{
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
  }>;
}

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  ts: number;
  requestId: string;
  parentRequestId?: string;
  botId?: string;
  channel?: string;
  chatId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface TraceWithEntries {
  trace: RequestTrace;
  entries: LogEntry[];
}

// -- D1-based logs --

export interface SessionSummary {
  sessionId: string;
  channel: string;
  chatId: string;
  groupId: string | null;
  botId: string | null;
  messageCount: number;
  latestAt: string;
  latestMessageId?: number;
}

export interface D1Message {
  id: number;
  role: string;
  content: string | null;
  attachments: Array<{ r2Key: string; mediaType: string }> | null;
  botId: string | null;
  toolCalls: string | null;
  requestId: string | null;
  createdAt: string;
}

// -- Sub-agent runs --

export interface SubagentRun {
  runId: string;
  label: string;
  task: string;
  parentSessionId: string;
  childSessionId: string;
  botId: string;
  spawnDepth: number;
  status: "running" | "completed" | "error" | "timeout";
  result?: string;
  error?: string;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: string;
  completedAt?: string;
}

// -- Skills --

export interface SkillInfo {
  name: string;
  description: string;
  adminOnly: boolean;
  available: boolean;
  source: "bundled" | "installed";
  emoji?: string;
  requiresEnv?: string[];
  envConfigured?: Record<string, boolean>;
  installedBotIds?: string[];
}

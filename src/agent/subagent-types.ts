/**
 * Types and constants for sub-agent spawning.
 */

export interface SubagentRun {
  runId: string;
  label: string;
  task: string;
  ownerId: string;
  parentSessionId: string;
  childSessionId: string;
  spawnDepth: number;
  status: "running" | "completed" | "error" | "timeout";
  result?: string;
  error?: string;
  botId: string;
  channel: string;
  chatId: string;
  channelToken: string;
  userId: string;
  userName: string;
  sessionEpoch: number;
  inputTokens?: number;
  outputTokens?: number;
  createdAt: number;
  completedAt?: number;
}

export interface SubagentConfig {
  maxSpawnDepth?: number;          // default 3
  maxChildrenPerSession?: number;  // default 5
  subagentTimeout?: number;        // default 120000 (ms)
}

export const SUBAGENT_DEFAULTS = {
  maxSpawnDepth: 3,
  maxChildrenPerSession: 5,
  subagentTimeout: 120_000,
} as const;

export function resolveSubagentConfig(config?: SubagentConfig): Required<SubagentConfig> {
  return {
    maxSpawnDepth: config?.maxSpawnDepth ?? SUBAGENT_DEFAULTS.maxSpawnDepth,
    maxChildrenPerSession: config?.maxChildrenPerSession ?? SUBAGENT_DEFAULTS.maxChildrenPerSession,
    subagentTimeout: config?.subagentTimeout ?? SUBAGENT_DEFAULTS.subagentTimeout,
  };
}

/** DO storage key prefix for sub-agent runs */
export const SUBAGENT_RUN_PREFIX = "subagent:";
/** DO storage key for session epoch */
export const SESSION_EPOCH_PREFIX = "subagent-epoch:";

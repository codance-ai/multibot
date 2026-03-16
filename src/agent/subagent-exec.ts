/**
 * Sub-agent execution — runs processChat() for a child sub-agent task.
 */

import type { ChatDeps } from "./multibot-chat";
import { processChat } from "./multibot-chat";
import type { SubagentRun } from "./subagent-types";
import { resolveSubagentConfig } from "./subagent-types";
import { putSubagentRun } from "./subagent-storage";
import { withTimeout, RequestTimeoutError } from "./multibot-helpers";
import * as d1 from "../db/d1";
import type { BotConfig, UserKeys } from "../config/schema";
import type { Logger } from "../utils/logger";

/**
 * Build the system prompt suffix that tells the LLM it's a sub-agent.
 */
export function buildSubagentSystemPromptSuffix(run: SubagentRun, maxDepth: number): string {
  return `\n\n---\n\n## Sub-Agent Context

You are executing a focused sub-task as a background agent.

**Task**: ${run.task}
**Label**: ${run.label}
**Run ID**: ${run.runId}
**Depth**: ${run.spawnDepth} / ${maxDepth}

Instructions:
- Focus exclusively on the assigned task
- Be thorough but concise in your response
- Your response will be delivered to the parent agent for synthesis
- Do NOT address the user directly — the parent agent handles user communication
- Include key findings, data points, and identifiers in your response`;
}

/**
 * Execute a sub-agent: run processChat() with the child session, capture result,
 * persist to DO storage + D1, then call onComplete for drain scheduling.
 */
export async function executeSubagent(
  deps: ChatDeps,
  run: SubagentRun,
  botConfig: BotConfig,
  userKeys: UserKeys,
  storage: DurableObjectStorage,
  log: Logger,
  onComplete: (run: SubagentRun) => void,
): Promise<void> {
  const config = resolveSubagentConfig(botConfig.subagent);
  const timeout = config.subagentTimeout;

  try {
    const result = await withTimeout(
      processChat(deps, {
        botConfig,
        userKeys,
        chatId: run.chatId,
        userId: run.userId,
        userName: run.userName,
        userMessage: run.task,
        channel: run.channel,
        channelToken: run.channelToken,
        sessionId: run.childSessionId,
      }, {
        sendProgressToChannel: false,
        sendFinalToChannel: false,
        sendToolHints: false,
        enableMessageTool: false,
        enableTyping: false,
        persistMessages: true, // persist to child session for debugging
      }, log, {
        spawnDepth: run.spawnDepth,
        storage,
        subagentSystemPromptSuffix: buildSubagentSystemPromptSuffix(run, config.maxSpawnDepth),
      }),
      timeout,
    );

    run.status = "completed";
    run.result = result.reply;
    run.inputTokens = result.inputTokens;
    run.outputTokens = result.outputTokens;
  } catch (e) {
    run.status = e instanceof RequestTimeoutError ? "timeout" : "error";
    run.error = e instanceof Error ? e.message : String(e);
  }

  run.completedAt = Date.now();

  // Persist to both DO storage and D1
  await putSubagentRun(storage, run);
  await d1.persistSubagentRun(deps.db, run).catch(e =>
    console.error("[subagent] Failed to persist run to D1:", e)
  );

  onComplete(run);
}

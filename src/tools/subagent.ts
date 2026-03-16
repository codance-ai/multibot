/**
 * spawn_subagent tool — allows a bot to spawn background sub-agents for parallel task execution.
 */

import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import type { SubagentRun } from "../agent/subagent-types";
import { resolveSubagentConfig } from "../agent/subagent-types";
import type { SubagentConfig } from "../agent/subagent-types";
import { countActiveChildren, getSessionEpoch, putSubagentRun } from "../agent/subagent-storage";

export interface SubagentToolParams {
  storage: DurableObjectStorage;
  spawnDepth: number;
  config: SubagentConfig | undefined;
  parentSessionId: string;
  ownerId: string;
  botId: string;
  channel: string;
  chatId: string;
  channelToken: string;
  userId: string;
  userName: string;
  createChildSession: (channel: string, chatId: string, botId: string) => Promise<string>;
  startSubagent: (run: SubagentRun) => void;
}

export function createSubagentTools(params: SubagentToolParams): ToolSet {
  const resolved = resolveSubagentConfig(params.config);

  // Don't include tool at all if at max depth
  if (params.spawnDepth >= resolved.maxSpawnDepth) {
    return {};
  }

  return {
    spawn_subagent: tool({
      description:
        "Spawn a background sub-agent to handle a sub-task independently. " +
        "Results are delivered automatically when complete. " +
        "Use for tasks that can be parallelized (research, analysis, data gathering). " +
        "Do NOT spawn for simple questions you can answer directly.",
      inputSchema: z.object({
        task: z.string().describe("Clear, specific task description for the sub-agent"),
        label: z.string().max(40).describe("Short label for tracking (e.g. 'weather-research')"),
      }),
      execute: async ({ task, label }) => {
        // Check concurrent children limit
        const active = await countActiveChildren(params.storage, params.parentSessionId);
        if (active >= resolved.maxChildrenPerSession) {
          return `Error: max concurrent sub-agents (${resolved.maxChildrenPerSession}) reached. Wait for existing ones to complete.`;
        }

        const runId = crypto.randomUUID();
        const epoch = await getSessionEpoch(params.storage, params.parentSessionId);

        // Create child session with a unique chatId to avoid polluting parent session lookup.
        // getOrCreateSession queries by (channel, chat_id, bot_id) and returns the most recent,
        // so a child with the same identity would hijack the parent's session.
        const childChatId = `subagent:${runId}`;
        const childSessionId = await params.createChildSession(
          params.channel, childChatId, params.botId,
        );

        const run: SubagentRun = {
          runId,
          label,
          task,
          ownerId: params.ownerId,
          parentSessionId: params.parentSessionId,
          childSessionId,
          spawnDepth: params.spawnDepth + 1,
          status: "running",
          botId: params.botId,
          channel: params.channel,
          chatId: params.chatId,
          channelToken: params.channelToken,
          userId: params.userId,
          userName: params.userName,
          sessionEpoch: epoch,
          createdAt: Date.now(),
        };

        // Register in DO storage
        await putSubagentRun(params.storage, run);

        // Fire sub-agent in background
        params.startSubagent(run);

        return JSON.stringify({
          status: "spawned",
          runId,
          label,
          note: "Sub-agent is running in background. Results will be delivered automatically when complete. Do NOT poll or wait.",
        });
      },
    }),
  };
}

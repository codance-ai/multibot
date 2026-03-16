/**
 * Sub-agent drain manager — delivers completed sub-agent results to parent sessions.
 * Uses per-session TurnSerializer for serialization with user message processing.
 */

import { TurnSerializer } from "../group/coordinator-utils";
import { claimCompletedRuns, deleteCompletedRuns, getSessionEpoch, recoverOrphanedRuns } from "./subagent-storage";
import { processChat } from "./multibot-chat";
import type { ChatDeps } from "./multibot-chat";
import * as d1 from "../db/d1";
import * as configDb from "../db/config";
import { createLogger } from "../utils/logger";
import { SUBAGENT_DEFAULTS } from "./subagent-types";

export class SubagentDrainManager {
  private serializers = new Map<string, TurnSerializer>();

  constructor(
    private storage: DurableObjectStorage,
    private buildChatDeps: () => ChatDeps,
    private db: D1Database,
    private waitUntil: (p: Promise<unknown>) => void,
  ) {}

  /** Get or create a TurnSerializer for a session (shared with /chat path). */
  getSerializer(sessionId: string): TurnSerializer {
    let s = this.serializers.get(sessionId);
    if (!s) {
      s = new TurnSerializer();
      this.serializers.set(sessionId, s);
    }
    return s;
  }

  /** Called when a sub-agent completes. Triggers drain via TurnSerializer. */
  scheduleDrain(parentSessionId: string): void {
    this.waitUntil(
      this.executeDrain(parentSessionId).catch(e =>
        console.error("[subagent-drain] Drain failed:", e)
      )
    );
  }

  /** Drain all completed results for a session, deliver via processChat. */
  private async executeDrain(parentSessionId: string): Promise<void> {
    const serializer = this.getSerializer(parentSessionId);
    await serializer.enqueue(async () => {
      const currentEpoch = await getSessionEpoch(this.storage, parentSessionId);
      const completedRuns = await claimCompletedRuns(this.storage, parentSessionId, currentEpoch);

      if (completedRuns.length === 0) return;

      // Persist each sub-agent result to parent session as role='subagent'
      const firstRun = completedRuns[0];
      const log = createLogger({
        botId: firstRun.botId,
        channel: firstRun.channel,
        chatId: firstRun.chatId,
      });

      for (const run of completedRuns) {
        const content = run.status === "completed"
          ? (run.result ?? "")
          : `Error: ${run.error || run.status}`;
        await d1.persistSubagentResult(
          this.db, parentSessionId,
          run.label, run.runId, content, run.botId, log.requestId,
        ).catch(e => console.error("[subagent-drain] Failed to persist result:", e));
      }

      // Reload bot config + user keys
      const botConfig = await configDb.getBot(this.db, firstRun.ownerId, firstRun.botId);
      if (!botConfig) {
        console.error("[subagent-drain] Bot not found:", firstRun.botId);
        return;
      }
      const userKeys = await configDb.getUserKeys(this.db, firstRun.ownerId);

      // Trigger parent processChat. Sub-agent results are already in D1 history
      // as role='subagent' rows, so the LLM will see them in conversation context.
      // We pass a brief trigger message (not the full results) to avoid the LLM
      // seeing the content twice (once from subagent rows, once from userMessage).
      const labels = completedRuns.map(r => r.label).join(", ");
      const triggerMessage = `[Sub-agent tasks completed: ${labels}. See sub-agent results above in conversation history.]`;

      try {
        await processChat(this.buildChatDeps(), {
          botConfig,
          userKeys: userKeys ?? {},
          chatId: firstRun.chatId,
          userId: firstRun.userId,
          userName: firstRun.userName,
          userMessage: triggerMessage,
          channel: firstRun.channel,
          channelToken: firstRun.channelToken,
          sessionId: parentSessionId,
        }, {
          sendProgressToChannel: true,
          sendFinalToChannel: true,
          sendToolHints: true,
          enableMessageTool: false,
          enableTyping: true,
          // persistMessages must be true so the parent's assistant synthesis response
          // is saved to D1. The trigger message is also persisted as role='user' (acceptable).
        }, log, {
          spawnDepth: 0,
          storage: this.storage,
        });
        // Delivery succeeded — now safe to remove from DO storage
        await deleteCompletedRuns(this.storage, completedRuns);
      } catch (e) {
        // Delivery failed — runs stay in DO storage for retry on next drain
        console.error("[subagent-drain] processChat failed, runs will retry:", e);
      }
    });
  }

  /** Scan for orphaned runs on startup/first request. */
  async recoverOrphans(): Promise<void> {
    // Use subagent-specific threshold (timeout + 30s grace), not the request-level PENDING_ORPHAN_MS
    const orphans = await recoverOrphanedRuns(this.storage, SUBAGENT_DEFAULTS.subagentTimeout + 30_000);
    if (orphans.length === 0) return;

    for (const orphan of orphans) {
      await d1.persistSubagentRun(this.db, orphan).catch(e =>
        console.error("[subagent-drain] Failed to persist orphan:", e)
      );
    }

    const sessionIds = new Set(orphans.map(o => o.parentSessionId));
    for (const sid of sessionIds) {
      this.scheduleDrain(sid);
    }
  }
}

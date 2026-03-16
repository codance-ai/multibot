import type { ChatContext } from "../db/d1";
import type { GroupConfig } from "../config/schema";
import type { StoredMessage } from "./loop";

export interface CronGroupPersistDeps {
  db: D1Database;
  ownerId: string;
  botId: string;
  channel: string;
  chatId: string;
  reply: string;
  attachments?: string | null;
  requestId?: string;
  findAllGroupsForBot: (
    db: D1Database,
    ownerId: string,
    botId: string,
  ) => Promise<GroupConfig[]>;
  getOrCreateSession: (db: D1Database, ctx: ChatContext) => Promise<string>;
  persistMessages: (
    db: D1Database,
    sessionId: string,
    messages: StoredMessage[],
  ) => Promise<void>;
}

export interface CronGroupPersistResult {
  groupId: string;
  chatId: string;
}

/**
 * After a cron job sends a reply, check if the target chatId belongs to a group.
 * If so, persist the reply to the group session so it appears in Dashboard logs.
 * Returns matched groups so the caller can dispatch to the orchestrator.
 */
export async function persistCronReplyToGroupSession(
  deps: CronGroupPersistDeps,
): Promise<CronGroupPersistResult[]> {
  if (!deps.reply) return [];

  const groups = await deps.findAllGroupsForBot(
    deps.db,
    deps.ownerId,
    deps.botId,
  );
  if (groups.length === 0) return [];

  const matched: CronGroupPersistResult[] = [];
  for (const group of groups) {
    const groupChatId = group.channel === deps.channel ? group.chatId : undefined;
    if (groupChatId && groupChatId === deps.chatId) {
      const ctx: ChatContext = {
        channel: deps.channel,
        chatId: groupChatId,
        groupId: group.groupId,
      };
      const sessionId = await deps.getOrCreateSession(deps.db, ctx);
      await deps.persistMessages(deps.db, sessionId, [
        { role: "assistant", content: deps.reply, botId: deps.botId, attachments: deps.attachments ?? null, requestId: deps.requestId },
      ]);
      matched.push({ groupId: group.groupId, chatId: groupChatId });
    }
  }
  return matched;
}

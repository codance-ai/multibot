/**
 * D1 data access layer — centralized messages & sessions storage.
 * Replaces per-DO SQLite (this.sql) with a shared D1 database.
 */

import type { StoredMessage } from "../agent/loop";
import type { AttachmentRef } from "../channels/registry";
import type { SubagentRun } from "../agent/subagent-types";

export const MESSAGE_RETENTION_DAYS = 30;
export const REQUEST_TRACE_INDEX_RETENTION_DAYS = 90;

export interface ChatContext {
  channel: string;
  chatId: string;
  groupId?: string;
  botId?: string;
}

export interface MessageRow {
  role: string;
  content: string | null;
  attachments: string | null;
  bot_id: string | null;
  tool_calls: string | null;
  created_at: string;
}

export interface MessageRowFull {
  id: number;
  session_id: string;
  role: string;
  content: string | null;
  attachments: string | null;
  bot_id: string | null;
  tool_calls: string | null;
  request_id: string | null;
  created_at: string;
}

/**
 * Get or create a session for the given chat context.
 * Returns the most recent session ID for this channel+chatId.
 */
export async function getOrCreateSession(
  db: D1Database,
  ctx: ChatContext
): Promise<string> {
  let sql = "SELECT id FROM sessions WHERE channel = ? AND chat_id = ?";
  const bindings: string[] = [ctx.channel, ctx.chatId];

  if (ctx.botId && !ctx.groupId) {
    sql += " AND bot_id = ?";
    bindings.push(ctx.botId);
  }

  sql += " ORDER BY created_at DESC LIMIT 1";
  const row = await db.prepare(sql).bind(...bindings).first<{ id: string }>();
  if (row) return row.id;
  return createNewSession(db, ctx);
}

/**
 * Create a new session. Returns the new session ID.
 */
export async function createNewSession(
  db: D1Database,
  ctx: ChatContext
): Promise<string> {
  const now = new Date();
  const ts = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace("T", "-")
    .slice(0, 15); // YYYYMMDD-HHMMSS
  const rand = Math.random().toString(36).slice(2, 6);
  const sessionId = `${ctx.channel}-${ctx.chatId}-${ts}-${rand}`;
  await db
    .prepare(
      "INSERT INTO sessions (id, channel, chat_id, group_id, bot_id) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(sessionId, ctx.channel, ctx.chatId, ctx.groupId ?? null, ctx.botId ?? null)
    .run();
  return sessionId;
}

/**
 * Persist a batch of StoredMessages from the agent loop.
 * Filters out role="tool" messages (kept in memory for loop logic, not persisted).
 */
export async function persistMessages(
  db: D1Database,
  sessionId: string,
  messages: StoredMessage[]
): Promise<void> {
  const filtered = messages.filter((msg) => msg.role !== "tool");
  const stmt = db.prepare(
    "INSERT INTO messages (session_id, bot_id, role, content, attachments, tool_calls, request_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  const batched = filtered.map((msg) =>
    stmt.bind(
      sessionId,
      msg.botId ?? null,
      msg.role,
      msg.content,
      msg.attachments ?? null,
      msg.toolCalls ?? null,
      msg.requestId ?? null
    )
  );
  if (batched.length > 0) {
    await db.batch(batched);
  }
}

/**
 * Get conversation history (user + assistant messages with content) for building LLM prompt.
 */
export async function getConversationHistory(
  db: D1Database,
  sessionId: string,
  limit: number = 500,
): Promise<MessageRow[]> {
  const sql = "SELECT role, content, attachments, bot_id, tool_calls, created_at FROM messages WHERE session_id = ? AND role IN ('user', 'assistant', 'subagent') AND (content IS NOT NULL OR tool_calls IS NOT NULL) ORDER BY id DESC LIMIT ?";
  const { results } = await db.prepare(sql).bind(sessionId, limit).all<MessageRow>();
  return results.reverse();
}

/**
 * Get recent messages (for orchestrator context in group chat).
 */
export async function getRecentMessages(
  db: D1Database,
  sessionId: string,
  limit: number = 10
): Promise<MessageRow[]> {
  const { results } = await db
    .prepare(
      "SELECT role, content, attachments, bot_id, tool_calls, created_at FROM messages WHERE session_id = ? AND role IN ('user', 'assistant') AND content IS NOT NULL ORDER BY id DESC LIMIT ?"
    )
    .bind(sessionId, limit)
    .all<MessageRow>();
  return results.reverse();
}

/**
 * Persist a single user message.
 */
export async function persistUserMessage(
  db: D1Database,
  sessionId: string,
  content: string,
  requestId?: string,
  attachments?: AttachmentRef[],
): Promise<number> {
  const attachmentsJson = attachments && attachments.length > 0 ? JSON.stringify(attachments) : null;
  const result = await db
    .prepare(
      "INSERT INTO messages (session_id, role, content, attachments, request_id) VALUES (?, 'user', ?, ?, ?)"
    )
    .bind(sessionId, content, attachmentsJson, requestId ?? null)
    .run();
  return result.meta.last_row_id;
}

/**
 * Get last_consolidated value for a session+bot pair.
 */
export async function getSessionLastConsolidated(
  db: D1Database,
  sessionId: string,
  botId: string
): Promise<number> {
  const row = await db
    .prepare("SELECT last_consolidated FROM consolidation_state WHERE session_id = ? AND bot_id = ?")
    .bind(sessionId, botId)
    .first<{ last_consolidated: number }>();
  return row?.last_consolidated ?? 0;
}

/**
 * Get messages for consolidation (after a given message ID).
 * In shared sessions, only returns this bot's assistant messages + user messages.
 */
export async function getMessagesForConsolidation(
  db: D1Database,
  sessionId: string,
  botId: string,
  afterId: number = 0
): Promise<MessageRowFull[]> {
  const { results } = await db
    .prepare(
      "SELECT id, session_id, role, content, attachments, bot_id, tool_calls, request_id, created_at FROM messages WHERE session_id = ? AND id > ? AND (bot_id = ? OR bot_id IS NULL) ORDER BY id ASC"
    )
    .bind(sessionId, afterId, botId)
    .all<MessageRowFull>();
  return results;
}

/**
 * Update consolidation boundary for a session+bot pair (UPSERT).
 */
export async function updateSessionConsolidated(
  db: D1Database,
  sessionId: string,
  botId: string,
  boundary: number
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO consolidation_state (session_id, bot_id, last_consolidated) VALUES (?, ?, ?) ON CONFLICT (session_id, bot_id) DO UPDATE SET last_consolidated = excluded.last_consolidated"
    )
    .bind(sessionId, botId, boundary)
    .run();
}

/**
 * Count total messages for a session+bot (user messages + this bot's assistant messages).
 */
export async function countSessionMessages(
  db: D1Database,
  sessionId: string,
  botId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) as cnt FROM messages WHERE session_id = ? AND (bot_id = ? OR bot_id IS NULL)"
    )
    .bind(sessionId, botId)
    .first<{ cnt: number }>();
  return row?.cnt ?? 0;
}

/**
 * Delete consolidated messages (id <= boundary) for a session.
 *
 * In shared (group) sessions, user messages (bot_id IS NULL) are visible to all bots.
 * We only delete this bot's assistant messages unconditionally.
 * User messages are only deleted when ALL bots in the session have consolidated past them
 * (i.e., the minimum last_consolidated across all bots is >= the user message's id).
 */
export async function deleteConsolidatedMessages(
  db: D1Database,
  sessionId: string,
  botId: string,
  boundary: number,
): Promise<void> {
  // Delete this bot's own assistant messages up to boundary (only if older than retention period)
  await db
    .prepare(
      "DELETE FROM messages WHERE session_id = ? AND id <= ? AND bot_id = ? AND created_at < datetime('now', '-' || ? || ' days')"
    )
    .bind(sessionId, boundary, botId, MESSAGE_RETENTION_DAYS)
    .run();

  // Delete user messages (bot_id IS NULL) only when ALL bots have consolidated past them.
  // MIN(last_consolidated) across all bots for this session gives the safe deletion boundary.
  const row = await db
    .prepare(
      "SELECT MIN(last_consolidated) as min_boundary FROM consolidation_state WHERE session_id = ?"
    )
    .bind(sessionId)
    .first<{ min_boundary: number | null }>();

  const safeBoundary = row?.min_boundary;
  if (safeBoundary && safeBoundary > 0) {
    await db
      .prepare(
        "DELETE FROM messages WHERE session_id = ? AND id <= ? AND bot_id IS NULL AND created_at < datetime('now', '-' || ? || ' days')"
      )
      .bind(sessionId, safeBoundary, MESSAGE_RETENTION_DAYS)
      .run();
  }
}

/**
 * Delete all data for a bot: messages from solo sessions, consolidation state.
 * Group sessions: only delete consolidation_state (preserve conversation context).
 */
export async function deleteBotData(
  db: D1Database,
  botId: string,
): Promise<void> {
  // Find sessions where this bot is the ONLY assistant (solo sessions)
  // A solo session has no assistant messages from other bots
  const { results: soloSessions } = await db
    .prepare(`
      SELECT DISTINCT session_id FROM messages WHERE bot_id = ?
      EXCEPT
      SELECT DISTINCT session_id FROM messages WHERE bot_id IS NOT NULL AND bot_id != ?
    `)
    .bind(botId, botId)
    .all<{ session_id: string }>();

  // Batch all deletions for atomicity:
  // 1. Delete messages from solo sessions
  // 2. Delete consolidation state for this bot
  // 3. Clean up orphaned sessions
  // 4. Clean up orphaned consolidation_state
  const stmts: D1PreparedStatement[] = [];

  if (soloSessions.length > 0) {
    const stmt = db.prepare("DELETE FROM messages WHERE session_id = ?");
    for (const { session_id } of soloSessions) {
      stmts.push(stmt.bind(session_id));
    }
  }

  stmts.push(
    db.prepare("DELETE FROM consolidation_state WHERE bot_id = ?").bind(botId),
    db.prepare("DELETE FROM sessions WHERE id NOT IN (SELECT DISTINCT session_id FROM messages)"),
    db.prepare("DELETE FROM consolidation_state WHERE session_id NOT IN (SELECT id FROM sessions)"),
  );

  await db.batch(stmts);

  // NOTE: Memory data (bot_memory, memory_history_entries) is NOT deleted here.
  // deleteBotData is called during soft-delete; memory must survive for 30-day restoration.
  // Memory is cleaned up by deleteMemoryForBot() during permanent cleanup (cron).
}

/**
 * Ensure a session exists (used by cron jobs with predetermined session IDs).
 */
export async function ensureSessionExists(
  db: D1Database,
  ctx: ChatContext,
  sessionId: string
): Promise<void> {
  const row = await db
    .prepare("SELECT id FROM sessions WHERE id = ?")
    .bind(sessionId)
    .first<{ id: string }>();
  if (!row) {
    await db
      .prepare(
        "INSERT INTO sessions (id, channel, chat_id, group_id, bot_id) VALUES (?, ?, ?, ?, ?)"
      )
      .bind(sessionId, ctx.channel, ctx.chatId, ctx.groupId ?? null, ctx.botId ?? null)
      .run();
  }
}

// -- Reply Hints (cross-bot reply context sharing) --

export interface ReplyHintInput {
  channel: string;
  chatId: string;
  messageDate: number;
  userId: string;
  replyToName: string;
  replyToText?: string;
}

export interface ReplyHintKey {
  channel: string;
  chatId: string;
  messageDate: number;
  userId: string;
}

export interface ReplyHintResult {
  replyToName: string;
  replyToText?: string;
}

export async function insertReplyHint(
  db: D1Database,
  hint: ReplyHintInput,
): Promise<void> {
  await db
    .prepare(
      "INSERT OR IGNORE INTO reply_hints (channel, chat_id, message_date, user_id, reply_to_name, reply_to_text) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(hint.channel, hint.chatId, hint.messageDate, hint.userId, hint.replyToName, hint.replyToText ?? null)
    .run();
}

export async function getReplyHint(
  db: D1Database,
  key: ReplyHintKey,
): Promise<ReplyHintResult | null> {
  const row = await db
    .prepare(
      "SELECT reply_to_name, reply_to_text FROM reply_hints WHERE channel = ? AND chat_id = ? AND message_date = ? AND user_id = ?"
    )
    .bind(key.channel, key.chatId, key.messageDate, key.userId)
    .first<{ reply_to_name: string; reply_to_text: string | null }>();
  if (!row) return null;
  return {
    replyToName: row.reply_to_name,
    replyToText: row.reply_to_text ?? undefined,
  };
}

export async function cleanupReplyHints(db: D1Database): Promise<void> {
  await db
    .prepare("DELETE FROM reply_hints WHERE created_at < datetime('now', '-2 minutes')")
    .run();
}

export async function cleanupRequestTraceIndex(
  db: D1Database,
  retentionDays: number = REQUEST_TRACE_INDEX_RETENTION_DAYS,
): Promise<void> {
  await db
    .prepare(
      "DELETE FROM request_trace_index WHERE log_date < date('now', '-' || ? || ' days')"
    )
    .bind(retentionDays)
    .run();
}

// -- Bot Memory (replaces KV memory:{botId}:MEMORY.md) --

export async function getMemory(db: D1Database, botId: string): Promise<string> {
  const row = await db
    .prepare("SELECT content FROM bot_memory WHERE bot_id = ?")
    .bind(botId)
    .first<{ content: string }>();
  return row?.content ?? "";
}

export async function upsertMemory(db: D1Database, botId: string, content: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO bot_memory (bot_id, content, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT (bot_id) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at"
    )
    .bind(botId, content)
    .run();
}

// -- History Entries (replaces KV memory:{botId}:HISTORY.md) --

export interface HistoryEntry {
  id: number;
  content: string;
  created_at: string;
}

export async function insertHistoryEntry(db: D1Database, botId: string, content: string): Promise<void> {
  await db
    .prepare("INSERT INTO memory_history_entries (bot_id, content) VALUES (?, ?)")
    .bind(botId, content)
    .run();
}

export async function getHistoryEntries(db: D1Database, botId: string, limit: number = 50): Promise<HistoryEntry[]> {
  const { results } = await db
    .prepare(
      "SELECT id, content, created_at FROM memory_history_entries WHERE bot_id = ? ORDER BY created_at DESC LIMIT ?"
    )
    .bind(botId, limit)
    .all<HistoryEntry>();
  return results.reverse(); // chronological order
}

export async function searchHistoryEntries(db: D1Database, botId: string, query: string, limit: number = 50): Promise<HistoryEntry[]> {
  // Escape LIKE wildcards in user input
  const escaped = query.replace(/[\\%_]/g, "\\$&");
  const { results } = await db
    .prepare(
      "SELECT id, content, created_at FROM memory_history_entries WHERE bot_id = ? AND content LIKE ? ESCAPE '\\' ORDER BY created_at DESC LIMIT ?"
    )
    .bind(botId, `%${escaped}%`, limit)
    .all<HistoryEntry>();
  return results;
}

export async function deleteExpiredHistoryEntries(db: D1Database, botId: string, retentionDays: number = 180): Promise<void> {
  await db
    .prepare(
      `DELETE FROM memory_history_entries WHERE bot_id = ? AND created_at < datetime('now', '-' || ? || ' days')`
    )
    .bind(botId, retentionDays)
    .run();
}

export async function deleteMemoryForBot(db: D1Database, botId: string): Promise<void> {
  await db.batch([
    db.prepare("DELETE FROM bot_memory WHERE bot_id = ?").bind(botId),
    db.prepare("DELETE FROM memory_history_entries WHERE bot_id = ?").bind(botId),
  ]);
}

export async function getBotsWithMemory(
  db: D1Database
): Promise<Array<{ bot_id: string; owner_id: string }>> {
  const { results } = await db
    .prepare(
      "SELECT bm.bot_id, b.owner_id FROM bot_memory bm JOIN bots b ON b.bot_id = bm.bot_id WHERE b.deleted_at IS NULL"
    )
    .all<{ bot_id: string; owner_id: string }>();
  return results;
}

// -- Sub-Agent Runs --

/**
 * Persist a sub-agent result as a 'subagent' role message in the parent session.
 */
export async function persistSubagentResult(
  db: D1Database,
  sessionId: string,
  label: string,
  runId: string,
  content: string,
  botId: string,
  requestId?: string,
): Promise<void> {
  await db
    .prepare(
      "INSERT INTO messages (session_id, role, content, bot_id, request_id) VALUES (?, 'subagent', ?, ?, ?)"
    )
    .bind(sessionId, `[Sub-Agent: ${label} | runId: ${runId}]\n${content}`, botId, requestId ?? null)
    .run();
}

/**
 * Persist or update a sub-agent run record in D1 (for dashboard/observability).
 */
export async function persistSubagentRun(
  db: D1Database,
  run: SubagentRun,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO subagent_runs (run_id, owner_id, parent_session_id, child_session_id, bot_id, label, task, status, result, error, spawn_depth, input_tokens, output_tokens, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET status=excluded.status, result=excluded.result, error=excluded.error, input_tokens=excluded.input_tokens, output_tokens=excluded.output_tokens, completed_at=excluded.completed_at`
    )
    .bind(
      run.runId, run.ownerId, run.parentSessionId, run.childSessionId,
      run.botId, run.label, run.task, run.status,
      run.result ?? null, run.error ?? null, run.spawnDepth,
      run.inputTokens ?? null, run.outputTokens ?? null,
      new Date(run.createdAt).toISOString(), run.completedAt ? new Date(run.completedAt).toISOString() : null,
    )
    .run();
}

/**
 * Get all sub-agent runs for a parent session (for dashboard).
 */
export async function getSubagentRunsBySession(
  db: D1Database,
  parentSessionId: string,
): Promise<any[]> {
  const { results } = await db
    .prepare("SELECT * FROM subagent_runs WHERE parent_session_id = ? ORDER BY created_at")
    .bind(parentSessionId)
    .all();
  return results;
}

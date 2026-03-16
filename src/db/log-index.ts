import type { RequestTrace } from "../utils/logger";

const MISSING_TABLE_PATTERN = /no such table: request_trace_index/i;

export interface RequestTraceIndexRow {
  requestId: string;
  parentRequestId: string | null;
  botId: string | null;
  logDate: string;
  r2Key: string;
  status: "ok" | "error";
  createdAt?: string;
}

function isMissingIndexTableError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return MISSING_TABLE_PATTERN.test(msg);
}

export async function upsertRequestTraceIndex(
  db: D1Database,
  trace: RequestTrace,
  r2Key: string,
  logDate: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO request_trace_index
        (request_id, parent_request_id, bot_id, log_date, r2_key, status)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(request_id) DO UPDATE SET
         parent_request_id = excluded.parent_request_id,
         bot_id = excluded.bot_id,
         log_date = excluded.log_date,
         r2_key = excluded.r2_key,
         status = excluded.status,
         created_at = datetime('now')`
    )
    .bind(
      trace.requestId,
      trace.parentRequestId ?? null,
      trace.botId ?? null,
      logDate,
      r2Key,
      trace.status,
    )
    .run();
}

export async function safeUpsertRequestTraceIndex(
  db: D1Database | undefined,
  trace: RequestTrace,
  r2Key: string,
  logDate: string,
): Promise<void> {
  if (!db) return;
  try {
    await upsertRequestTraceIndex(db, trace, r2Key, logDate);
  } catch (error) {
    if (isMissingIndexTableError(error)) return;
    throw error;
  }
}

export async function getTraceIndexByRequestId(
  db: D1Database,
  requestId: string,
  botId?: string | null,
): Promise<RequestTraceIndexRow | null> {
  try {
    let sql =
      "SELECT request_id, parent_request_id, bot_id, log_date, r2_key, status, created_at FROM request_trace_index WHERE request_id = ?";
    const bindings: Array<string | null> = [requestId];
    if (botId) {
      sql += " AND bot_id = ?";
      bindings.push(botId);
    }
    const row = await db.prepare(sql).bind(...bindings).first<{
      request_id: string;
      parent_request_id: string | null;
      bot_id: string | null;
      log_date: string;
      r2_key: string;
      status: "ok" | "error";
      created_at?: string;
    }>();
    if (!row) return null;
    return {
      requestId: row.request_id,
      parentRequestId: row.parent_request_id,
      botId: row.bot_id,
      logDate: row.log_date,
      r2Key: row.r2_key,
      status: row.status,
      createdAt: row.created_at,
    };
  } catch (error) {
    if (isMissingIndexTableError(error)) return null;
    throw error;
  }
}

export async function listTraceIndexesByParentRequestId(
  db: D1Database,
  parentRequestId: string,
  limit: number,
): Promise<RequestTraceIndexRow[]> {
  try {
    const { results } = await db
      .prepare(
        `SELECT request_id, parent_request_id, bot_id, log_date, r2_key, status, created_at
         FROM request_trace_index
         WHERE request_id = ? OR parent_request_id = ?
         ORDER BY created_at ASC
         LIMIT ?`
      )
      .bind(parentRequestId, parentRequestId, limit)
      .all<{
        request_id: string;
        parent_request_id: string | null;
        bot_id: string | null;
        log_date: string;
        r2_key: string;
        status: "ok" | "error";
        created_at?: string;
      }>();
    return results.map((row) => ({
      requestId: row.request_id,
      parentRequestId: row.parent_request_id,
      botId: row.bot_id,
      logDate: row.log_date,
      r2Key: row.r2_key,
      status: row.status,
      createdAt: row.created_at,
    }));
  } catch (error) {
    if (isMissingIndexTableError(error)) return [];
    throw error;
  }
}

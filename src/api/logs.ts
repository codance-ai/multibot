import type { Env } from "../config/schema";
import type { RouteParams } from "./router";
import type { MessageRowFull } from "../db/d1";
import {
  getTraceIndexByRequestId,
  listTraceIndexesByParentRequestId,
} from "../db/log-index";

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDateParts(date: string): { year: number; month: number; day: number } | null {
  const [y, m, d] = date.split("-");
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) {
    return null;
  }
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year ||
    utc.getUTCMonth() !== month - 1 ||
    utc.getUTCDate() !== day
  ) {
    return null;
  }
  return { year, month, day };
}

function parseDate(raw: string | null): string | null {
  const date = raw ?? new Date().toISOString().slice(0, 10);
  if (!DATE_PATTERN.test(date)) return null;
  return parseDateParts(date) ? date : null;
}

function parseTzOffsetMinutes(raw: string | null): number {
  if (raw == null) return 0;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < -840 || v > 840) return 0;
  return v;
}

function toSqlDateTimeUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ");
}

async function findR2KeysBySuffix(
  bucket: R2Bucket,
  prefix: string,
  suffix: string,
  limit: number,
): Promise<string[]> {
  const matches: string[] = [];
  let cursor: string | undefined;

  do {
    const listed = await bucket.list({
      prefix,
      limit: 500,
      ...(cursor ? { cursor } : {}),
    });

    for (const obj of listed.objects) {
      if (obj.key.endsWith(suffix)) {
        matches.push(obj.key);
        if (matches.length >= limit) {
          return matches;
        }
      }
    }

    cursor = listed.truncated ? listed.cursor : undefined;
  } while (cursor);

  return matches;
}

async function fetchTracePayloads(bucket: R2Bucket, keys: string[]): Promise<any[]> {
  return (await Promise.all(
    keys.map(async (key) => {
      const body = await bucket.get(key);
      return body ? JSON.parse(await body.text()) : null;
    })
  )).filter(Boolean);
}

function getUtcRangeForLocalDate(
  date: string,
  tzOffsetMinutes: number,
): { startUtc: string; endUtcExclusive: string } | null {
  const parts = parseDateParts(date);
  if (!parts) return null;
  const localMidnightAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day);
  const startUtcMs = localMidnightAsUtc + tzOffsetMinutes * 60 * 1000;
  const endUtcMs = startUtcMs + 24 * 60 * 60 * 1000;
  return {
    startUtc: toSqlDateTimeUtc(startUtcMs),
    endUtcExclusive: toSqlDateTimeUtc(endUtcMs),
  };
}

/**
 * Query request traces from R2.
 * GET /api/logs?requestId=xxx
 * GET /api/logs?parentRequestId=xxx
 * GET /api/logs?botId=xxx&date=2026-02-24
 * GET /api/logs?status=error&limit=10
 */
export async function handleListLogs(
  request: Request,
  env: Env,
  _params: RouteParams,
): Promise<Response> {
  const bucket = env.LOG_BUCKET;
  if (!bucket) {
    return Response.json({ error: "LOG_BUCKET not configured" }, { status: 500 });
  }

  const url = new URL(request.url);
  const requestId = url.searchParams.get("requestId");
  const parentRequestId = url.searchParams.get("parentRequestId");
  const botId = url.searchParams.get("botId");
  const date = parseDate(url.searchParams.get("date"));
  if (!date) {
    return Response.json({ error: "Invalid date format (expected YYYY-MM-DD)" }, { status: 400 });
  }
  const statusFilter = url.searchParams.get("status");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);

  // Mode 1: by requestId — search across all prefixes by listing with suffix match
  if (requestId) {
    const indexed = await getTraceIndexByRequestId(env.D1_DB, requestId, botId);
    if (indexed) {
      const results = await fetchTracePayloads(bucket, [indexed.r2Key]);
      if (results.length > 0) {
        return Response.json(results);
      }
    }

    const prefix = botId ? `logs/${botId}/` : "logs/";
    const matches = await findR2KeysBySuffix(bucket, prefix, `/${requestId}.json`, limit);

    if (matches.length === 0) {
      return Response.json({ error: "No logs found for requestId", requestId }, { status: 404 });
    }

    const results = await fetchTracePayloads(bucket, matches.slice(0, limit));
    return Response.json(results);
  }

  // Mode 2: by parentRequestId — find orchestrator + all bot traces in a group chat chain
  if (parentRequestId) {
    const indexed = await listTraceIndexesByParentRequestId(env.D1_DB, parentRequestId, limit);
    if (indexed.length > 0) {
      const results = await fetchTracePayloads(bucket, indexed.map((row) => row.r2Key));
      const filtered = results.filter((data) => {
        const trace = data?.trace;
        return trace && (trace.requestId === parentRequestId || trace.parentRequestId === parentRequestId);
      });
      if (filtered.length === indexed.length) {
        return Response.json(filtered);
      }
    }

    const prefixList = await bucket.list({ prefix: "logs/", delimiter: "/" });
    const botPrefixes = prefixList.delimitedPrefixes ?? [];

    const allObjects = (await Promise.all(
      botPrefixes.map(async (bp: string) => {
        const listed = await bucket.list({ prefix: `${bp}${date}/`, limit: 200, include: ["customMetadata"] } as R2ListOptions & { include: string[] });
        return listed.objects;
      })
    )).flat();

    const matchingKeys: string[] = [];
    const unmatchedKeys: string[] = [];
    for (const obj of allObjects) {
      if (matchingKeys.length >= limit) break;
      const metaJson = obj.customMetadata?.t;
      if (metaJson) {
        try {
          const trace = JSON.parse(metaJson);
          if (trace.requestId === parentRequestId || trace.parentRequestId === parentRequestId) {
            matchingKeys.push(obj.key);
          }
        } catch (e) { console.warn("[logs] Malformed trace metadata:", e); }
      } else {
        unmatchedKeys.push(obj.key);
      }
    }

    const keysToFetch = [...matchingKeys, ...unmatchedKeys].slice(0, limit);
    const results = (await Promise.all(
      keysToFetch.map(async (key) => {
        const body = await bucket.get(key);
        if (!body) return null;
        const data = JSON.parse(await body.text());
        const trace = data.trace;
        if (trace.requestId === parentRequestId || trace.parentRequestId === parentRequestId) {
          return data;
        }
        return null;
      })
    )).filter(Boolean);

    if (results.length === 0) {
      return Response.json({ error: "No logs found for parentRequestId", parentRequestId }, { status: 404 });
    }
    return Response.json(results);
  }

  // Mode 3: by botId + date — list traces from customMetadata (zero GET calls for new data)
  if (botId) {
    const prefix = `logs/${botId}/${date}/`;
    const listed = await bucket.list({ prefix, limit: 500, include: ["customMetadata"] } as R2ListOptions & { include: string[] });

    const traces: any[] = [];
    const fallbackKeys: string[] = [];
    for (const obj of listed.objects) {
      if (traces.length >= limit) break;
      const metaJson = obj.customMetadata?.t;
      if (metaJson) {
        try {
          const trace = JSON.parse(metaJson);
          if (!statusFilter || trace.status === statusFilter) {
            traces.push(trace);
          }
        } catch (e) { console.warn("[logs] Malformed trace metadata:", e); }
      } else {
        fallbackKeys.push(obj.key);
      }
    }

    if (traces.length < limit && fallbackKeys.length > 0) {
      const remaining = limit - traces.length;
      const fallbackTraces = (await Promise.all(
        fallbackKeys.slice(0, remaining).map(async (key) => {
          const body = await bucket.get(key);
          if (!body) return null;
          const data = JSON.parse(await body.text());
          const trace = data.trace;
          if (statusFilter && trace.status !== statusFilter) return null;
          return trace;
        })
      )).filter(Boolean);
      traces.push(...fallbackTraces);
    }

    // For orchestrator queries, also fetch child bot traces with matching parentRequestId
    if (botId.startsWith("orchestrator:")) {
      const orchRequestIds = new Set(traces.map((t: any) => t.requestId));
      if (orchRequestIds.size > 0) {
        const allPrefixes = await bucket.list({ prefix: "logs/", delimiter: "/" });
        const botPrefixes = (allPrefixes.delimitedPrefixes ?? [])
          .filter((bp: string) => bp !== `logs/${botId}/`);

        const childObjects = (await Promise.all(
          botPrefixes.map(async (bp: string) => {
            const l = await bucket.list({ prefix: `${bp}${date}/`, limit: 200, include: ["customMetadata"] } as R2ListOptions & { include: string[] });
            return l.objects;
          })
        )).flat();

        for (const obj of childObjects) {
          if (traces.length >= limit) break;
          const metaJson = obj.customMetadata?.t;
          if (!metaJson) continue;
          try {
            const trace = JSON.parse(metaJson);
            if (trace.parentRequestId && orchRequestIds.has(trace.parentRequestId)) {
              if (!statusFilter || trace.status === statusFilter) {
                traces.push(trace);
              }
            }
          } catch (e) { console.warn("[logs] Malformed trace metadata:", e); }
        }
      }
    }

    return Response.json(traces);
  }

  // Mode 4: list today's traces across all bots
  const prefixList = await bucket.list({ prefix: "logs/", delimiter: "/" });
  const botPrefixes = prefixList.delimitedPrefixes ?? [];

  const todayObjects = (await Promise.all(
    botPrefixes.map(async (bp: string) => {
      const listed = await bucket.list({ prefix: `${bp}${date}/`, limit: 200, include: ["customMetadata"] } as R2ListOptions & { include: string[] });
      return listed.objects;
    })
  )).flat();

  const traces: any[] = [];
  const fallbackKeys: string[] = [];
  for (const obj of todayObjects) {
    if (traces.length >= limit) break;
    const metaJson = obj.customMetadata?.t;
    if (metaJson) {
      try {
        const trace = JSON.parse(metaJson);
        if (!statusFilter || trace.status === statusFilter) {
          traces.push(trace);
        }
      } catch (e) { console.warn("[logs] Malformed trace metadata:", e); }
    } else {
      fallbackKeys.push(obj.key);
    }
  }

  if (traces.length < limit && fallbackKeys.length > 0) {
    const remaining = limit - traces.length;
    const fallbackTraces = (await Promise.all(
      fallbackKeys.slice(0, remaining).map(async (key) => {
        const body = await bucket.get(key);
        if (!body) return null;
        const data = JSON.parse(await body.text());
        const trace = data.trace;
        if (statusFilter && trace.status !== statusFilter) return null;
        return trace;
      })
    )).filter(Boolean);
    traces.push(...fallbackTraces);
  }
  return Response.json(traces);
}

/**
 * List sessions from D1, grouped by date.
 * GET /api/logs/sessions?date=2026-02-28&tzOffsetMinutes=480&botId=xxx&limit=50
 */
export async function handleListSessions(
  request: Request,
  env: Env,
  _params: RouteParams,
): Promise<Response> {
  const url = new URL(request.url);
  const date = parseDate(url.searchParams.get("date"));
  if (!date) {
    return Response.json({ error: "Invalid date format (expected YYYY-MM-DD)" }, { status: 400 });
  }
  const tzOffsetMinutes = parseTzOffsetMinutes(url.searchParams.get("tzOffsetMinutes"));
  const range = getUtcRangeForLocalDate(date, tzOffsetMinutes);
  if (!range) {
    return Response.json({ error: "Invalid date format (expected YYYY-MM-DD)" }, { status: 400 });
  }
  const { startUtc, endUtcExclusive } = range;
  const botId = url.searchParams.get("botId");
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 200);

  const selectClause = `
      SELECT s.id as session_id, s.channel, s.chat_id,
             COALESCE(s.group_id, (
               SELECT group_id FROM sessions
               WHERE channel = s.channel AND chat_id = s.chat_id AND group_id IS NOT NULL
               ORDER BY created_at ASC LIMIT 1
             )) as group_id,
             s.bot_id as bot_id,
             COUNT(m.id) as message_count,
             MAX(m.created_at) as latest_at,
             MAX(m.id) as latest_message_id
      FROM sessions s
      JOIN messages m ON m.session_id = s.id`;

  const bindings: (string | number)[] = [];
  let whereClause: string;

  // Exclude sub-agent child sessions (chat_id starts with 'subagent:') from the main session list.
  // They are accessible via the SubagentRunsPanel "open child session" link.
  const subagentFilter = "AND s.chat_id NOT LIKE 'subagent:%'";

  if (botId?.startsWith("orchestrator:")) {
    // Group filter: match sessions by group_id
    const groupId = botId.slice("orchestrator:".length);
    whereClause = `WHERE m.created_at >= ? AND m.created_at < ? ${subagentFilter} AND COALESCE(s.group_id, (
      SELECT group_id FROM sessions WHERE channel = s.channel AND chat_id = s.chat_id AND group_id IS NOT NULL LIMIT 1
    )) = ?`;
    bindings.push(startUtc, endUtcExclusive, groupId, limit);
  } else if (botId) {
    whereClause = `WHERE m.created_at >= ? AND m.created_at < ? ${subagentFilter} AND s.bot_id = ?`;
    bindings.push(startUtc, endUtcExclusive, botId, limit);
  } else {
    whereClause = `WHERE m.created_at >= ? AND m.created_at < ? ${subagentFilter}`;
    bindings.push(startUtc, endUtcExclusive, limit);
  }

  const sql = `${selectClause} ${whereClause} GROUP BY s.id ORDER BY latest_at DESC, latest_message_id DESC LIMIT ?`;

  const { results } = await env.D1_DB
    .prepare(sql)
    .bind(...bindings)
    .all<{
      session_id: string;
      channel: string;
      chat_id: string;
      group_id: string | null;
      bot_id: string | null;
      message_count: number;
      latest_at: string;
      latest_message_id: number;
    }>();

  const sessions = results.map((r) => ({
    sessionId: r.session_id,
    channel: r.channel,
    chatId: r.chat_id,
    groupId: r.group_id,
    botId: r.bot_id,
    messageCount: r.message_count,
    latestAt: r.latest_at,
    latestMessageId: r.latest_message_id,
  }));

  return Response.json(sessions);
}

/**
 * List messages for a session from D1.
 * GET /api/logs/messages?sessionId=xxx&limit=200
 */
export async function handleListMessages(
  request: Request,
  env: Env,
  _params: RouteParams,
): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }
  const limit = Math.min(Number(url.searchParams.get("limit") ?? "200"), 1000);

  const { results } = await env.D1_DB
    .prepare(
      "SELECT * FROM (SELECT id, session_id, role, content, attachments, bot_id, tool_calls, request_id, created_at FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id ASC"
    )
    .bind(sessionId, limit)
    .all<MessageRowFull>();

  const messages = results.map((r) => ({
    id: r.id,
    role: r.role,
    content: r.content,
    attachments: r.attachments ? JSON.parse(r.attachments) : null,
    botId: r.bot_id,
    toolCalls: r.tool_calls,
    requestId: r.request_id,
    createdAt: r.created_at,
  }));

  return Response.json(messages);
}

/**
 * List sub-agent runs for a session.
 * GET /api/logs/subagent-runs?sessionId=xxx
 */
export async function handleListSubagentRuns(
  request: Request,
  env: Env,
  _params: RouteParams,
): Promise<Response> {
  const url = new URL(request.url);
  const sessionId = url.searchParams.get("sessionId");
  if (!sessionId) {
    return Response.json({ error: "sessionId is required" }, { status: 400 });
  }

  const { results } = await env.D1_DB
    .prepare("SELECT * FROM subagent_runs WHERE parent_session_id = ? ORDER BY created_at")
    .bind(sessionId)
    .all();

  const runs = results.map((r: any) => ({
    runId: r.run_id,
    label: r.label,
    task: r.task,
    ownerId: r.owner_id,
    parentSessionId: r.parent_session_id,
    childSessionId: r.child_session_id,
    botId: r.bot_id,
    spawnDepth: r.spawn_depth,
    status: r.status,
    result: r.result,
    error: r.error,
    inputTokens: r.input_tokens,
    outputTokens: r.output_tokens,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  }));

  return Response.json(runs);
}

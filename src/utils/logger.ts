import { safeUpsertRequestTraceIndex } from "../db/log-index";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogContext {
  requestId?: string;
  parentRequestId?: string;
  botId?: string;
  channel?: string;
  chatId?: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface LogEntry {
  level: LogLevel;
  msg: string;
  ts: number;
  [key: string]: unknown;
}

export interface SkillToolCall {
  name: string;       // tool name, e.g. "exec"
  input: string;      // truncated input (≤200 chars)
  result: string;     // truncated result (≤200 chars)
  isError: boolean;   // tool returned [Error] prefix
}

export interface SkillCall {
  skill: string;      // skill name, e.g. "selfie". Empty string for orphan tools
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
  startedAt: number;
  durationMs: number;
  model?: string;
  llmCalls: number;
  inputTokens: number;
  outputTokens: number;
  skillCalls: SkillCall[];
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

const levelToConsole: Record<LogLevel, "debug" | "log" | "warn" | "error"> = {
  debug: "debug",
  info: "log",
  warn: "warn",
  error: "error",
};

export class Logger {
  readonly requestId?: string;
  private ctx: LogContext;
  private buffer: LogEntry[];

  constructor(ctx: LogContext = {}, buffer?: LogEntry[]) {
    this.ctx = ctx;
    this.requestId = ctx.requestId;
    this.buffer = buffer ?? [];
  }

  child(extra: LogContext): Logger {
    return new Logger({ ...this.ctx, ...extra }, this.buffer);
  }

  debug(msg: string, data?: Record<string, unknown>): void {
    this.emit("debug", msg, data);
  }

  info(msg: string, data?: Record<string, unknown>, ts?: number): void {
    this.emit("info", msg, data, ts);
  }

  warn(msg: string, data?: Record<string, unknown>): void {
    this.emit("warn", msg, data);
  }

  error(msg: string, data?: Record<string, unknown>): void {
    this.emit("error", msg, data);
  }

  getEntries(): LogEntry[] {
    return this.buffer;
  }

  async flush(bucket: R2Bucket, trace: RequestTrace, db?: D1Database): Promise<void> {
    const date = new Date().toISOString().slice(0, 10);
    const botId = trace.botId ?? "unknown";
    const key = `logs/${botId}/${date}/${trace.requestId}.json`;
    const body = JSON.stringify({ trace, entries: this.buffer });
    // Store trace summary in customMetadata for fast listing (R2 limit: 2KB)
    // Truncate userMessage/reply to keep metadata within size limit
    const metaTrace = {
      ...trace,
      userMessage: trace.userMessage?.slice(0, 200),
      reply: trace.reply?.slice(0, 200),
      errorStack: undefined,
      botCalls: undefined,
    };
    await bucket.put(key, body, {
      customMetadata: { t: JSON.stringify(metaTrace) },
    });
    try {
      await safeUpsertRequestTraceIndex(db, trace, key, date);
    } catch (error) {
      console.error(
        JSON.stringify({
          msg: "Failed to upsert request trace index",
          requestId: trace.requestId,
          botId: trace.botId,
          error: error instanceof Error ? error.message : String(error),
        })
      );
    }
  }

  private emit(
    level: LogLevel,
    msg: string,
    data?: Record<string, unknown>,
    ts?: number,
  ): void {
    const entry: LogEntry = { level, msg, ...this.ctx, ...data, ts: ts ?? Date.now() };
    console[levelToConsole[level]](JSON.stringify(entry));
    this.buffer.push(entry);
  }
}

export function createLogger(ctx?: LogContext): Logger {
  return new Logger({
    ...ctx,
    requestId: ctx?.requestId ?? crypto.randomUUID(),
  });
}

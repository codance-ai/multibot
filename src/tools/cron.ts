import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { parseCronExpression } from "cron-schedule";
import type { CronJobPayload } from "../cron/types";

export interface CronScheduler {
  scheduleAt(
    when: Date,
    payload: CronJobPayload
  ): Promise<{ id: string }>;
  scheduleEvery(
    seconds: number,
    payload: CronJobPayload
  ): Promise<{ id: string }>;
  scheduleCron(
    expr: string,
    payload: CronJobPayload
  ): Promise<{ id: string }>;
  listSchedules(): Promise<Array<{
    id: string;
    type: string;
    payload: CronJobPayload;
    time?: number;
  }>>;
  cancelSchedule(id: string): Promise<boolean>;
}

export interface CronContext {
  channel: string;
  chatId: string;
  channelToken: string;
  botId: string;
  ownerId: string;
}

// -- Timezone helpers --

export function isValidTimezone(tz: string): boolean {
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    console.warn("[cron] Invalid timezone:", tz);
    return false;
  }
}

/**
 * Get date components in a target timezone.
 */
function datePartsInTz(
  date: Date,
  tz: string
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string): number => {
    const val = parts.find((p) => p.type === type)?.value ?? "0";
    let n = parseInt(val, 10);
    if (type === "hour" && n === 24) n = 0; // midnight edge case
    return n;
  };

  return {
    year: get("year"),
    month: get("month") - 1, // 0-indexed for Date constructor
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
    second: get("second"),
  };
}

/**
 * Convert a real UTC Date to a "fake UTC" Date whose UTC components equal the local time in `tz`.
 * This is used to feed cron-schedule (which operates on Date components) with timezone-local values.
 */
function realUtcToFakeUtc(date: Date, tz: string): Date {
  const p = datePartsInTz(date, tz);
  return new Date(
    Date.UTC(p.year, p.month, p.day, p.hour, p.minute, p.second)
  );
}

/**
 * Convert a "fake UTC" Date (whose UTC components represent local time in `tz`) back to real UTC.
 * Uses iterative offset correction to handle DST boundaries.
 */
function fakeUtcToRealUtc(fakeUtc: Date, tz: string): Date {
  let guess = new Date(fakeUtc.getTime());
  for (let i = 0; i < 2; i++) {
    const guessInTz = realUtcToFakeUtc(guess, tz);
    const offset = guessInTz.getTime() - guess.getTime();
    guess = new Date(fakeUtc.getTime() - offset);
  }
  return guess;
}

/**
 * Calculate the next occurrence of a cron expression in a specific timezone, returned as UTC.
 * Returns null if the expression is invalid.
 */
export function getNextCronDateInTimezone(
  cronExpr: string,
  tz: string
): Date | null {
  try {
    const cron = parseCronExpression(cronExpr);
    const now = new Date();

    // Convert "now" to target timezone (as fake UTC for cron-schedule)
    const nowInTz = realUtcToFakeUtc(now, tz);

    // Get next cron match in timezone-local time
    const nextInTz = cron.getNextDate(nowInTz);

    // Convert back to real UTC
    return fakeUtcToRealUtc(nextInTz, tz);
  } catch (e) {
    console.warn("[cron] Failed to compute next cron date:", cronExpr, tz, e);
    return null;
  }
}

// -- Tool factory --

export function createCronTools(
  scheduler: CronScheduler,
  ctx: CronContext
): ToolSet {
  return {
    cron: tool({
      description:
        "Schedule reminders and recurring tasks. Actions: add (create new), list (show all), remove (delete by ID). " +
        "IMPORTANT: The message should capture the FULL intent including WHERE to deliver (e.g. 'share a moment in the group chat' vs 'send me a reminder'). " +
        "If the user wants the task delivered to a group chat, include that in the message so it can be routed correctly at execution time.",
      inputSchema: z.object({
        action: z
          .enum(["add", "list", "remove"])
          .describe("The action to perform"),
        message: z
          .string()
          .optional()
          .describe("The reminder/task message (required for add)"),
        every_seconds: z
          .number()
          .optional()
          .describe("Interval in seconds for recurring tasks"),
        cron_expr: z
          .string()
          .optional()
          .describe("Cron expression (e.g. '0 9 * * 1-5')"),
        tz: z
          .string()
          .optional()
          .describe(
            "IANA timezone (e.g. 'America/Vancouver'), used with cron_expr"
          ),
        at: z
          .string()
          .optional()
          .describe(
            "ISO datetime for one-time schedule (e.g. '2026-02-22T09:00:00Z')"
          ),
        job_id: z
          .string()
          .optional()
          .describe("Job ID to remove (required for remove)"),
      }),
      execute: async (params) => {
        const { action } = params;

        if (action === "list") {
          try {
            const schedules = await scheduler.listSchedules();
            if (schedules.length === 0) return "No scheduled tasks.";
            return schedules
              .map((s) => {
                const time = s.time
                  ? new Date(s.time * 1000).toISOString()
                  : "N/A";
                const tzInfo = s.payload?.tz ? ` (${s.payload.tz})` : "";
                const cronInfo = s.payload?.cronExpr
                  ? ` [cron: ${s.payload.cronExpr}${tzInfo}]`
                  : "";
                return `- ID: ${s.id} | Type: ${s.type}${cronInfo} | Next: ${time} | Message: ${s.payload?.message ?? "N/A"}`;
              })
              .join("\n");
          } catch (e) {
            throw e instanceof Error ? e : new Error(String(e));
          }
        }

        if (action === "remove") {
          if (!params.job_id)
            return "Error: job_id is required for remove action.";
          try {
            const cancelled = await scheduler.cancelSchedule(params.job_id);
            return cancelled
              ? `Removed scheduled task ${params.job_id}.`
              : `Task ${params.job_id} not found.`;
          } catch (e) {
            throw e instanceof Error ? e : new Error(String(e));
          }
        }

        // action === "add"
        if (!params.message)
          return "Error: message is required for add action.";

        const basePayload: CronJobPayload = {
          message: params.message,
          channel: ctx.channel,
          chatId: ctx.chatId,
          channelToken: ctx.channelToken,
          botId: ctx.botId,
          ownerId: ctx.ownerId,
          deleteAfterRun: false,
        };

        if (params.every_seconds) {
          const result = await scheduler.scheduleEvery(params.every_seconds, {
            ...basePayload,
          });
          return `Scheduled recurring task every ${params.every_seconds}s. Job ID: ${result.id}`;
        }

        if (params.cron_expr) {
          if (params.tz) {
            if (!isValidTimezone(params.tz)) {
              return `Error: Invalid timezone "${params.tz}". Use IANA format (e.g. "America/Vancouver").`;
            }
            const nextDate = getNextCronDateInTimezone(
              params.cron_expr,
              params.tz
            );
            if (!nextDate)
              return `Error: Invalid cron expression "${params.cron_expr}".`;

            const cronSessionId = `tz-cron-${Date.now()}`;
            const result = await scheduler.scheduleAt(nextDate, {
              ...basePayload,
              cronExpr: params.cron_expr,
              tz: params.tz,
              cronSessionId,
            });
            return `Scheduled timezone-aware cron task (${params.cron_expr} ${params.tz}). Next run: ${nextDate.toISOString()}. Job ID: ${result.id}`;
          }

          // No timezone — use SDK's native cron
          try {
            parseCronExpression(params.cron_expr);
          } catch {
            return `Error: Invalid cron expression "${params.cron_expr}".`;
          }
          const result = await scheduler.scheduleCron(
            params.cron_expr,
            basePayload
          );
          return `Scheduled cron task (${params.cron_expr}). Job ID: ${result.id}`;
        }

        if (params.at) {
          const date = new Date(params.at);
          if (isNaN(date.getTime()))
            return `Error: Invalid datetime "${params.at}".`;
          if (date.getTime() <= Date.now())
            return "Error: Scheduled time is in the past.";
          const result = await scheduler.scheduleAt(date, {
            ...basePayload,
            deleteAfterRun: true,
          });
          return `Scheduled one-time task at ${date.toISOString()}. Job ID: ${result.id}`;
        }

        return "Error: Specify one of every_seconds, cron_expr, or at for add action.";
      },
    }),
  };
}

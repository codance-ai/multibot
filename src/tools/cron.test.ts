import { describe, it, expect, vi } from "vitest";
import {
  createCronTools,
  isValidTimezone,
  getNextCronDateInTimezone,
} from "./cron";
import type { CronScheduler, CronContext } from "./cron";
import type { CronJobPayload } from "../cron/types";

function createMockScheduler(
  schedules: Array<{
    id: string;
    type: string;
    payload: CronJobPayload;
    time?: number;
  }> = []
): CronScheduler {
  return {
    scheduleAt: vi.fn(async () => ({ id: "sched-at-1" })),
    scheduleEvery: vi.fn(async () => ({ id: "sched-every-1" })),
    scheduleCron: vi.fn(async () => ({ id: "sched-cron-1" })),
    listSchedules: vi.fn(async () => schedules),
    cancelSchedule: vi.fn(async (id: string) =>
      schedules.some((s) => s.id === id)
    ),
  };
}

const mockCtx: CronContext = {
  channel: "telegram",
  chatId: "12345",
  channelToken: "tok-abc",
  botId: "bot-001",
  ownerId: "owner-001",
};

describe("isValidTimezone", () => {
  it("returns true for valid IANA timezone", () => {
    expect(isValidTimezone("America/Vancouver")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
  });

  it("returns false for invalid timezone", () => {
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("NotATimezone")).toBe(false);
  });
});

describe("getNextCronDateInTimezone", () => {
  it("returns a Date for valid cron + timezone", () => {
    const result = getNextCronDateInTimezone("0 9 * * *", "America/Vancouver");
    expect(result).toBeInstanceOf(Date);
    expect(result!.getTime()).toBeGreaterThan(Date.now());
  });

  it("returns null for invalid cron expression", () => {
    expect(getNextCronDateInTimezone("invalid", "UTC")).toBeNull();
  });

  it("returns null for invalid timezone", () => {
    expect(getNextCronDateInTimezone("0 9 * * *", "Invalid/TZ")).toBeNull();
  });
});

describe("createCronTools", () => {
  describe("add action", () => {
    it("schedules with every_seconds", async () => {
      const scheduler = createMockScheduler();
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({
        action: "add",
        message: "Drink water",
        every_seconds: 1200,
      });
      expect(result).toContain("every 1200s");
      expect(result).toContain("sched-every-1");
      expect(scheduler.scheduleEvery).toHaveBeenCalledWith(
        1200,
        expect.objectContaining({ message: "Drink water", channel: "telegram" })
      );
    });

    it("schedules with cron_expr (no tz)", async () => {
      const scheduler = createMockScheduler();
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({
        action: "add",
        message: "Daily standup",
        cron_expr: "0 9 * * 1-5",
      });
      expect(result).toContain("cron task");
      expect(result).toContain("sched-cron-1");
      expect(scheduler.scheduleCron).toHaveBeenCalledWith(
        "0 9 * * 1-5",
        expect.objectContaining({ message: "Daily standup" })
      );
    });

    it("schedules with cron_expr + tz", async () => {
      const scheduler = createMockScheduler();
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({
        action: "add",
        message: "Morning standup",
        cron_expr: "0 9 * * 1-5",
        tz: "America/Vancouver",
      });
      expect(result).toContain("timezone-aware");
      expect(result).toContain("America/Vancouver");
      expect(scheduler.scheduleAt).toHaveBeenCalledWith(
        expect.any(Date),
        expect.objectContaining({
          message: "Morning standup",
          cronExpr: "0 9 * * 1-5",
          tz: "America/Vancouver",
          cronSessionId: expect.stringContaining("tz-cron-"),
        })
      );
    });

    it("schedules with at (one-time)", async () => {
      const scheduler = createMockScheduler();
      const tools = createCronTools(scheduler, mockCtx);
      const future = new Date(Date.now() + 3600_000).toISOString();
      const result = await (tools.cron as any).execute({
        action: "add",
        message: "Meeting reminder",
        at: future,
      });
      expect(result).toContain("one-time task");
      expect(result).toContain("sched-at-1");
      expect(scheduler.scheduleAt).toHaveBeenCalledWith(
        expect.any(Date),
        expect.objectContaining({
          message: "Meeting reminder",
          deleteAfterRun: true,
        })
      );
    });

    it("returns error when message is missing", async () => {
      const scheduler = createMockScheduler();
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({
        action: "add",
        every_seconds: 60,
      });
      expect(result).toContain("Error");
      expect(result).toContain("message is required");
    });

    it("returns error when no scheduling parameter given", async () => {
      const scheduler = createMockScheduler();
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({
        action: "add",
        message: "Something",
      });
      expect(result).toContain("Error");
      expect(result).toContain("every_seconds, cron_expr, or at");
    });

    it("returns error for invalid timezone", async () => {
      const scheduler = createMockScheduler();
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({
        action: "add",
        message: "Test",
        cron_expr: "0 9 * * *",
        tz: "Mars/Olympus",
      });
      expect(result).toContain("Error");
      expect(result).toContain("Invalid timezone");
    });

    it("returns error for invalid cron expression with tz", async () => {
      const scheduler = createMockScheduler();
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({
        action: "add",
        message: "Test",
        cron_expr: "invalid-cron",
        tz: "UTC",
      });
      expect(result).toContain("Error");
      expect(result).toContain("Invalid cron expression");
    });

    it("returns error for invalid cron expression without tz", async () => {
      const scheduler = createMockScheduler();
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({
        action: "add",
        message: "Test",
        cron_expr: "bad cron",
      });
      expect(result).toContain("Error");
      expect(result).toContain("Invalid cron expression");
    });

    it("returns error when at is in the past", async () => {
      const scheduler = createMockScheduler();
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({
        action: "add",
        message: "Test",
        at: "2020-01-01T00:00:00Z",
      });
      expect(result).toContain("Error");
      expect(result).toContain("past");
    });

    it("returns error for invalid at datetime", async () => {
      const scheduler = createMockScheduler();
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({
        action: "add",
        message: "Test",
        at: "not-a-date",
      });
      expect(result).toContain("Error");
      expect(result).toContain("Invalid datetime");
    });
  });

  describe("list action", () => {
    it("returns empty message when no schedules", async () => {
      const scheduler = createMockScheduler([]);
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({ action: "list" });
      expect(result).toBe("No scheduled tasks.");
    });

    it("throws on listSchedules error", async () => {
      const scheduler = createMockScheduler([]);
      scheduler.listSchedules = () => { throw new Error("no such table: cf_agents_schedules"); };
      const tools = createCronTools(scheduler, mockCtx);
      await expect(
        (tools.cron as any).execute({ action: "list" })
      ).rejects.toThrow("no such table");
    });

    it("lists existing schedules", async () => {
      const scheduler = createMockScheduler([
        {
          id: "s1",
          type: "interval",
          time: Math.floor(Date.now() / 1000) + 600,
          payload: {
            message: "Drink water",
            channel: "telegram",
            chatId: "12345",
            channelToken: "tok",
            botId: "bot-001",
            ownerId: "owner-001",
            deleteAfterRun: false,
          },
        },
        {
          id: "s2",
          type: "scheduled",
          time: Math.floor(Date.now() / 1000) + 3600,
          payload: {
            message: "Standup",
            channel: "telegram",
            chatId: "12345",
            channelToken: "tok",
            botId: "bot-001",
            ownerId: "owner-001",
            deleteAfterRun: false,
            cronExpr: "0 9 * * 1-5",
            tz: "America/Vancouver",
          },
        },
      ]);
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({ action: "list" });
      expect(result).toContain("s1");
      expect(result).toContain("Drink water");
      expect(result).toContain("s2");
      expect(result).toContain("Standup");
      expect(result).toContain("America/Vancouver");
      expect(result).toContain("0 9 * * 1-5");
    });
  });

  describe("remove action", () => {
    it("removes existing schedule", async () => {
      const scheduler = createMockScheduler([
        {
          id: "s1",
          type: "interval",
          payload: {
            message: "Test",
            channel: "telegram",
            chatId: "12345",
            channelToken: "tok",
            botId: "bot-001",
            ownerId: "owner-001",
            deleteAfterRun: false,
          },
        },
      ]);
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({
        action: "remove",
        job_id: "s1",
      });
      expect(result).toContain("Removed");
      expect(result).toContain("s1");
    });

    it("returns not found for unknown job_id", async () => {
      const scheduler = createMockScheduler([]);
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({
        action: "remove",
        job_id: "nonexistent",
      });
      expect(result).toContain("not found");
    });

    it("returns error when job_id is missing", async () => {
      const scheduler = createMockScheduler();
      const tools = createCronTools(scheduler, mockCtx);
      const result = await (tools.cron as any).execute({
        action: "remove",
      });
      expect(result).toContain("Error");
      expect(result).toContain("job_id is required");
    });
  });
});

import { describe, it, expect } from "vitest";
import {
  formatDateTimeInTz,
  formatShortDateTimeInTz,
  getDayNameInTz,
  convertStoredTimestamp,
  convertStoredTimestampFull,
} from "./time";

describe("formatDateTimeInTz", () => {
  it("defaults to UTC when no timezone given", () => {
    const date = new Date("2026-02-21T14:30:00Z");
    expect(formatDateTimeInTz(date)).toBe("2026-02-21 14:30");
  });

  it("converts to specified timezone", () => {
    // UTC 14:30 → Asia/Shanghai (UTC+8) = 22:30
    const date = new Date("2026-02-21T14:30:00Z");
    expect(formatDateTimeInTz(date, "Asia/Shanghai")).toBe("2026-02-21 22:30");
  });

  it("handles date boundary crossing", () => {
    // UTC 23:00 → Asia/Shanghai = next day 07:00
    const date = new Date("2026-02-21T23:00:00Z");
    expect(formatDateTimeInTz(date, "Asia/Shanghai")).toBe("2026-02-22 07:00");
  });

  it("falls back to UTC for invalid timezone", () => {
    const date = new Date("2026-02-21T14:30:00Z");
    expect(formatDateTimeInTz(date, "Invalid/Zone")).toBe("2026-02-21 14:30");
  });
});

describe("formatShortDateTimeInTz", () => {
  it("returns MM-DD HH:MM format in UTC", () => {
    const date = new Date("2026-02-21T14:30:00Z");
    expect(formatShortDateTimeInTz(date)).toBe("02-21 14:30");
  });

  it("converts to specified timezone", () => {
    const date = new Date("2026-02-21T14:30:00Z");
    expect(formatShortDateTimeInTz(date, "Asia/Shanghai")).toBe("02-21 22:30");
  });
});

describe("getDayNameInTz", () => {
  it("returns day name in UTC", () => {
    // 2026-02-21 is a Saturday
    const date = new Date("2026-02-21T14:00:00Z");
    expect(getDayNameInTz(date)).toBe("Saturday");
  });

  it("returns correct day when timezone shifts the date", () => {
    // UTC Saturday 23:00 → Asia/Shanghai Sunday 07:00
    const date = new Date("2026-02-21T23:00:00Z");
    expect(getDayNameInTz(date, "Asia/Shanghai")).toBe("Sunday");
  });
});

describe("convertStoredTimestamp", () => {
  it("converts D1 timestamp without T separator", () => {
    expect(convertStoredTimestamp("2026-02-21 14:00")).toBe("02-21 14:00");
  });

  it("converts D1 timestamp with T separator", () => {
    expect(convertStoredTimestamp("2026-02-21T14:00")).toBe("02-21 14:00");
  });

  it("applies timezone conversion", () => {
    expect(convertStoredTimestamp("2026-02-21 14:00", "Asia/Shanghai")).toBe("02-21 22:00");
  });

  it("handles date boundary in timezone conversion", () => {
    expect(convertStoredTimestamp("2026-02-21 23:00", "Asia/Shanghai")).toBe("02-22 07:00");
  });
});

describe("convertStoredTimestampFull", () => {
  it("converts D1 timestamp to full format", () => {
    expect(convertStoredTimestampFull("2026-02-21 14:00")).toBe("2026-02-21 14:00");
  });

  it("applies timezone conversion", () => {
    expect(convertStoredTimestampFull("2026-02-21 14:00", "Asia/Shanghai")).toBe("2026-02-21 22:00");
  });

  it("handles date boundary in timezone conversion", () => {
    expect(convertStoredTimestampFull("2026-02-21 23:00", "Asia/Shanghai")).toBe("2026-02-22 07:00");
  });
});

/**
 * Timezone-aware date formatting utilities.
 *
 * Uses Intl.DateTimeFormat + formatToParts for all conversions.
 * All functions accept an optional IANA timezone (e.g. "Asia/Shanghai");
 * when omitted, they default to UTC.
 */

function partsInTz(
  date: Date,
  tz: string,
): { year: string; month: string; day: string; hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const get = (type: string): string => {
    let val = parts.find((p) => p.type === type)?.value ?? "00";
    // Some Intl implementations return "24" for midnight instead of "00"
    if (type === "hour" && val === "24") val = "00";
    return val;
  };

  return {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
}

function safeTz(tz?: string): string {
  if (!tz) return "UTC";
  try {
    // Validate the timezone by attempting to use it
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    console.warn("[time] Invalid timezone, falling back to UTC:", tz);
    return "UTC";
  }
}

/** "YYYY-MM-DD HH:MM" — for system prompt & memory consolidation */
export function formatDateTimeInTz(date: Date, tz?: string): string {
  const t = safeTz(tz);
  const { year, month, day, hour, minute } = partsInTz(date, t);
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

/** "MM-DD HH:MM" — for message history prefixes */
export function formatShortDateTimeInTz(date: Date, tz?: string): string {
  const t = safeTz(tz);
  const { month, day, hour, minute } = partsInTz(date, t);
  return `${month}-${day} ${hour}:${minute}`;
}

/** "Wednesday" — day-of-week name */
export function getDayNameInTz(date: Date, tz?: string): string {
  const t = safeTz(tz);
  return new Intl.DateTimeFormat("en-US", {
    timeZone: t,
    weekday: "long",
  }).format(date);
}

/**
 * Parse a D1 UTC timestamp string into a Date.
 * D1 stores timestamps like "2026-02-21 14:00" (no Z suffix).
 */
function parseD1Timestamp(utcStr: string): Date {
  const normalized = utcStr.includes("T") ? utcStr : utcStr.replace(" ", "T");
  return new Date(normalized.endsWith("Z") ? normalized : normalized + "Z");
}

/** Convert a D1 UTC timestamp string to "MM-DD HH:MM" in the given timezone. */
export function convertStoredTimestamp(utcStr: string, tz?: string): string {
  return formatShortDateTimeInTz(parseD1Timestamp(utcStr), tz);
}

/** Convert a D1 UTC timestamp string to "YYYY-MM-DD HH:MM" in the given timezone. */
export function convertStoredTimestampFull(utcStr: string, tz?: string): string {
  return formatDateTimeInTz(parseD1Timestamp(utcStr), tz);
}

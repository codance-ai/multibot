# UC-05: Scheduled Job Management (cron)

## Trigger

The LLM invokes the `cron` tool with an action (`add`, `list`, or `remove`) to manage scheduled reminders and recurring tasks for the current chat.

## Expected Behavior

1. **Action: add** -- Creates a new scheduled job. Requires a `message` parameter. Exactly one scheduling mode must be specified:
   - `at` (ISO datetime string): One-shot schedule. Validates the datetime is parseable and in the future. Sets `deleteAfterRun: true` so the job is cleaned up after execution
   - `every_seconds` (number): Recurring interval schedule. Uses `scheduler.scheduleEvery()`
   - `cron_expr` (cron expression string): Recurring cron schedule. With optional `tz` (IANA timezone):
     - **Without timezone**: Validates expression via `parseCronExpression()`, then uses `scheduler.scheduleCron()` for native SDK-level cron
     - **With timezone**: Validates timezone via `isValidTimezone()`, computes the next occurrence in UTC via `getNextCronDateInTimezone()`, and schedules as a one-shot `scheduleAt()` with `cronExpr`, `tz`, and `cronSessionId` embedded in the payload (the executor re-schedules the next occurrence after each run)

2. **Action: list** -- Returns all scheduled jobs with their ID, type, next run time (ISO format), cron expression + timezone (if applicable), and message

3. **Action: remove** -- Cancels a scheduled job by ID via `scheduler.cancelSchedule()`. Requires `job_id` parameter. Returns success or "not found"

4. **Message design**: The tool description instructs the LLM to capture the **full intent** in the message, including delivery target (e.g., "share a moment in the group chat" vs "send me a reminder"), because the message is used at execution time to determine routing

5. **Context binding**: Each cron job payload includes `channel`, `chatId`, `channelToken`, `botId`, and `ownerId` from the `CronContext`, binding the job to the specific conversation where it was created

## Example

```
LLM calls: cron({
  action: "add",
  message: "Good morning! Time for your daily standup",
  cron_expr: "0 9 * * 1-5",
  tz: "America/Vancouver"
})

→ action is "add", message is provided
→ cron_expr is set, tz is set
→ isValidTimezone("America/Vancouver") → true
→ getNextCronDateInTimezone("0 9 * * 1-5", "America/Vancouver")
  → realUtcToFakeUtc(now, "America/Vancouver") → nowInTz (fake UTC)
  → parseCronExpression("0 9 * * 1-5").getNextDate(nowInTz) → nextInTz
  → fakeUtcToRealUtc(nextInTz, "America/Vancouver") → nextUtc
→ scheduler.scheduleAt(nextUtc, { ...basePayload, cronExpr, tz, cronSessionId })
→ Return "Scheduled timezone-aware cron task (0 9 * * 1-5 America/Vancouver). Next run: 2026-03-12T17:00:00.000Z. Job ID: abc123"
```

```
LLM calls: cron({ action: "add", message: "Check server status", at: "2026-03-11T15:00:00Z" })

→ Parse "2026-03-11T15:00:00Z" → valid, in the future
→ scheduler.scheduleAt(date, { ...basePayload, deleteAfterRun: true })
→ Return "Scheduled one-time task at 2026-03-11T15:00:00.000Z. Job ID: xyz789"
```

## Key Code Path

- Tool factory: `createCronTools()` in `src/tools/cron.ts`
- Timezone validation: `isValidTimezone()` in `src/tools/cron.ts` -- uses `Intl.DateTimeFormat`
- Timezone conversion: `realUtcToFakeUtc()`, `fakeUtcToRealUtc()` in `src/tools/cron.ts` -- converts between real UTC and "fake UTC" dates for cron-schedule library
- Next occurrence: `getNextCronDateInTimezone()` in `src/tools/cron.ts`
- Cron expression parsing: `parseCronExpression()` from `cron-schedule` library
- Scheduler interface: `CronScheduler` in `src/tools/cron.ts` -- `scheduleAt`, `scheduleEvery`, `scheduleCron`, `listSchedules`, `cancelSchedule`
- Scheduler implementations: local (DO Agents SDK alarms) or remote (CronScheduler proxy via service binding)
- Cron job types: `CronJobPayload` in `src/cron/types.ts`

## Edge Cases

- **Invalid cron expression**: Validated by `parseCronExpression()` before scheduling. Returns `"Error: Invalid cron expression"` if parsing throws
- **Invalid timezone**: Validated by `isValidTimezone()` which catches `RangeError` from `Intl.DateTimeFormat`. Returns an error with IANA format hint
- **Past datetime for `at`**: Checked with `date.getTime() <= Date.now()`. Returns `"Error: Scheduled time is in the past."`
- **Missing required parameters**: `message` is required for `add`, `job_id` is required for `remove`. Returns descriptive error messages
- **No scheduling mode specified**: If none of `every_seconds`, `cron_expr`, or `at` is provided for `add`, returns `"Error: Specify one of every_seconds, cron_expr, or at"`
- **DST boundary for timezone cron**: `fakeUtcToRealUtc()` uses iterative offset correction (2 iterations) to handle DST transitions where the offset between real UTC and local time changes
- **Timezone-aware cron re-scheduling**: The initial call only schedules the next occurrence as `scheduleAt()`. After each execution, the cron executor is responsible for computing and scheduling the subsequent occurrence using the stored `cronExpr` and `tz`
- **Channel token for cron payloads**: Uses `botConfig.channels[channel]?.token` (the bot's own token) rather than the request's `channelToken`, which fixes a bug where group chat cron jobs would use the wrong token

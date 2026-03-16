export interface CronJobPayload {
  message: string;
  channel: string;
  chatId: string;
  channelToken: string;
  botId: string;
  ownerId: string;
  deleteAfterRun: boolean;
  /** Stable session ID for tz-cron chained one-shots to maintain the same session */
  cronSessionId?: string;
  /** Schedule ID, stored at creation time for use in onCronJob callback */
  scheduleId?: string;

  // Timezone cron: re-schedule next occurrence in onCronJob
  cronExpr?: string;
  tz?: string;
}

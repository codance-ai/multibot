import type { BotConfig } from "../config/schema";

/**
 * Check if a sender is authorized to interact with a bot.
 * - Normal bots: always authorized (no whitelist check).
 * - Admin bots: sender must be in allowedSenderIds.
 *   Empty allowedSenderIds = reject ALL (safer than allow all).
 */
export function isAdminBotAuthorized(botConfig: BotConfig, userId: string): boolean {
  if (botConfig.botType !== "admin") return true;
  if (botConfig.allowedSenderIds.length === 0) return false;
  return botConfig.allowedSenderIds.includes(userId);
}

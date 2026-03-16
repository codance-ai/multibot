import type { Env, BotConfig } from "../config/schema";
import { BindChannelSchema } from "../config/schema";
import type { RouteParams } from "./router";
import * as configDb from "../db/config";

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Clean up a single channel binding (token mapping + channel-specific teardown).
 * Returns a warning string on failure, or undefined on success.
 */
async function cleanupChannel(
  env: Env,
  botId: string,
  channel: string,
  token: string
): Promise<string | undefined> {
  try {
    await configDb.deleteTokenMapping(env.D1_DB, channel, token);
  } catch (e) {
    return `Failed to delete token mapping for ${channel}: ${e}`;
  }

  try {
    if (channel === "discord") {
      const gatewayId = env.DISCORD_GATEWAY.idFromName(`discord-${botId}`);
      const gateway = env.DISCORD_GATEWAY.get(gatewayId);
      await gateway.shutdown();
    } else if (channel === "telegram") {
      const r = await fetch(
        `https://api.telegram.org/bot${token}/deleteWebhook`
      );
      await r.text();
    }
  } catch (e) {
    return `Failed to cleanup ${channel}: ${e}`;
  }

  return undefined;
}

export async function handleBindChannel(
  request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;
  const { botId, channel } = params;

  // Load bot config from D1
  const botConfig = await configDb.getBot(env.D1_DB, ownerId, botId!);
  if (!botConfig) return errorResponse("Bot not found", 404);

  // Parse body
  let body: unknown;
  try {
    body = await request.json();
  } catch (e) {
    console.warn("[api] Invalid JSON in bind channel:", e);
    return errorResponse("Invalid JSON", 400);
  }

  const parsed = BindChannelSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.message, 400);
  }
  const { token } = parsed.data;

  const warnings: string[] = [];

  // If channel already bound with a different token, clean up old binding
  const oldChannel = botConfig.channels[channel!];
  if (oldChannel && oldChannel.token !== token) {
    const warning = await cleanupChannel(env, botId!, channel!, oldChannel.token);
    if (warning) warnings.push(warning);
  }

  // Write token mapping to D1
  await configDb.upsertTokenMapping(env.D1_DB, channel!, token, {
    ownerId,
    botId: botId!,
  });

  // Channel-specific setup
  const url = new URL(request.url);
  let channelInfo: Record<string, unknown> = {};

  if (channel === "telegram") {
    const webhookUrl = `https://${url.host}/webhook/telegram/${token}`;
    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${token}/setWebhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            url: webhookUrl,
            secret_token: env.WEBHOOK_SECRET,
          }),
        }
      );
      const result = await resp.json();
      channelInfo = { webhookUrl, telegram: result };
    } catch (e) {
      warnings.push(`Failed to set Telegram webhook: ${e}`);
      channelInfo = { webhookUrl };
    }
  } else if (channel === "discord") {
    try {
      const gatewayId = env.DISCORD_GATEWAY.idFromName(`discord-${botId}`);
      const gateway = env.DISCORD_GATEWAY.get(gatewayId);
      await gateway.configure(token, ownerId, { botId });
      channelInfo = { message: `Discord gateway started for bot ${botId}` };
    } catch (e) {
      warnings.push(`Failed to configure Discord gateway: ${e}`);
    }
  } else if (channel === "slack") {
    const webhookUrl = `https://${url.host}/webhook/slack/${token}`;
    channelInfo = {
      webhookUrl,
      message: `Add this URL to your Slack App Event Subscriptions: ${webhookUrl}`,
    };
  }

  // Fetch bot identity for the channel (best-effort)
  if (channel === "telegram") {
    try {
      const meResp = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const meData = await meResp.json() as { ok: boolean; result?: { username?: string } };
      if (meData.ok && meData.result?.username) {
        (channelInfo as any).botUsername = meData.result.username;
      }
    } catch (e) {
      warnings.push(`Failed to fetch bot identity: ${e}`);
    }
  }

  // Update bot config in D1
  const channelBinding: { token: string; webhookUrl?: string; channelUsername?: string; channelUserId?: string } = { token };
  if (channel === "telegram" && (channelInfo as any).botUsername) {
    channelBinding.channelUsername = `@${(channelInfo as any).botUsername}`;
  }
  if (channel === "discord") {
    try {
      const meResp = await fetch("https://discord.com/api/v10/users/@me", {
        headers: { Authorization: `Bot ${token}` },
      });
      const meData = await meResp.json() as { id?: string };
      if (meData.id) channelBinding.channelUserId = meData.id;
    } catch (e) {
      warnings.push(`Failed to fetch Discord bot identity: ${e}`);
    }
  }
  if (channel === "slack") {
    try {
      const meResp = await fetch("https://slack.com/api/auth.test", {
        headers: { Authorization: `Bearer ${token}` },
      });
      const meData = await meResp.json() as { ok?: boolean; user_id?: string };
      if (meData.ok && meData.user_id) channelBinding.channelUserId = meData.user_id;
    } catch (e) {
      warnings.push(`Failed to fetch Slack bot identity: ${e}`);
    }
  }
  botConfig.channels[channel!] = channelBinding;
  await configDb.upsertBot(env.D1_DB, botConfig);

  const result: Record<string, unknown> = { status: "ok", ...channelInfo };
  if (warnings.length > 0) result.warnings = warnings;
  return jsonResponse(result);
}

export async function handleUnbindChannel(
  _request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;
  const { botId, channel } = params;

  // Load bot config from D1
  const botConfig = await configDb.getBot(env.D1_DB, ownerId, botId!);
  if (!botConfig) return errorResponse("Bot not found", 404);

  const channelConfig = botConfig.channels[channel!];
  if (!channelConfig) {
    return errorResponse(`Channel ${channel} is not bound`, 400);
  }

  const warnings: string[] = [];

  // Cleanup channel binding
  const warning = await cleanupChannel(env, botId!, channel!, channelConfig.token);
  if (warning) warnings.push(warning);

  // Remove channel from bot config and save to D1
  delete botConfig.channels[channel!];
  await configDb.upsertBot(env.D1_DB, botConfig);

  const result: { unbound: true; warnings?: string[] } = { unbound: true };
  if (warnings.length > 0) result.warnings = warnings;
  return jsonResponse(result);
}

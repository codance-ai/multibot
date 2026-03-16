import type { Env, BotConfig } from "../config/schema";
import {
  BotConfigSchema,
  CreateBotSchema,
  UpdateBotSchema,
} from "../config/schema";
import type { RouteParams } from "./router";
import * as configDb from "../db/config";
import { deleteBotData } from "../db/d1";
import { destroySprite } from "../tools/sprites-sandbox";

// -- Helpers --

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

// -- Handlers --

export async function handleListBots(
  _request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;
  const bots = await configDb.listBots(env.D1_DB, ownerId);
  return jsonResponse(bots);
}

export async function handleCreateBot(
  request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;

  let body: unknown;
  try {
    body = await request.json();
  } catch (e) {
    console.warn("[api] Invalid JSON in create bot:", e);
    return errorResponse("Invalid JSON", 400);
  }

  const parsed = CreateBotSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.message, 400);
  }

  const botId = crypto.randomUUID();

  // Validate the full config and apply defaults (e.g. botType → "normal")
  const botConfig: BotConfig = BotConfigSchema.parse({
    ...parsed.data,
    botId,
    ownerId,
  });

  // Write bot config to D1
  await configDb.upsertBot(env.D1_DB, botConfig);

  return jsonResponse(botConfig, 201);
}

export async function handleGetBot(
  _request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;
  const { botId } = params;

  const bot = await configDb.getBot(env.D1_DB, ownerId, botId!);
  if (!bot) return errorResponse("Bot not found", 404);

  return jsonResponse(bot);
}

export async function handleUpdateBot(
  request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;
  const { botId } = params;

  const existing = await configDb.getBot(env.D1_DB, ownerId, botId!);
  if (!existing) return errorResponse("Bot not found", 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch (e) {
    console.warn("[api] Invalid JSON in update bot:", e);
    return errorResponse("Invalid JSON", 400);
  }

  const parsed = UpdateBotSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.message, 400);
  }

  // Merge, but botId, ownerId, and botType are immutable
  const updated: BotConfig = {
    ...existing,
    ...parsed.data,
    botId: existing.botId,
    ownerId: existing.ownerId,
    botType: existing.botType,
  };

  await configDb.upsertBot(env.D1_DB, updated);

  return jsonResponse(updated);
}

export async function handleDeleteBot(
  _request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;
  const { botId } = params;

  const botConfig = await configDb.getBot(env.D1_DB, ownerId, botId!);
  if (!botConfig) return errorResponse("Bot not found", 404);

  // Prevent deleting admin bot (#280)
  if (botConfig.botType === "admin") {
    return errorResponse("Cannot delete admin bot", 403);
  }

  const warnings: string[] = [];

  // 1. Channel teardown + bulk delete token mappings
  for (const [channel, cfg] of Object.entries(botConfig.channels)) {
    try {
      if (channel === "discord") {
        const gatewayId = env.DISCORD_GATEWAY.idFromName(`discord-${botId}`);
        const gateway = env.DISCORD_GATEWAY.get(gatewayId);
        await gateway.shutdown();
      } else if (channel === "telegram") {
        const r = await fetch(
          `https://api.telegram.org/bot${cfg.token}/deleteWebhook`
        );
        await r.text();
      }
    } catch (e) {
      warnings.push(`Failed to cleanup ${channel}: ${e}`);
    }
  }
  try {
    await configDb.deleteTokenMappingsForBot(env.D1_DB, ownerId, botId!);
  } catch (e) {
    warnings.push(`Failed to delete token mappings: ${e}`);
  }

  // 2. Cascade delete D1 message data + installed skills
  try {
    await deleteBotData(env.D1_DB, botId!);
  } catch (e) {
    warnings.push(`Failed to clean up D1 data: ${e}`);
  }
  try {
    await env.D1_DB
      .prepare("DELETE FROM skills WHERE bot_id = ?")
      .bind(botId!)
      .run();
  } catch (e) {
    warnings.push(`Failed to clean up skills: ${e}`);
  }

  // 3. Destroy Sprites sandbox (best-effort)
  if (env.SPRITES_TOKEN) {
    try {
      await destroySprite({
        token: env.SPRITES_TOKEN,
        spriteName: `multibot-${botId}`,
      });
    } catch (e) {
      console.warn(`[bots] Failed to destroy sprite for bot ${botId}:`, e);
      warnings.push(`Failed to destroy sprite: ${e}`);
    }
  }

  // 4. Soft-delete bot in D1
  try {
    await configDb.softDeleteBot(env.D1_DB, ownerId, botId!);
  } catch (e) {
    warnings.push(`Failed to soft-delete bot record: ${e}`);
  }

  const result: { deleted: true; warnings?: string[] } = { deleted: true };
  if (warnings.length > 0) result.warnings = warnings;
  return jsonResponse(result);
}

export async function handleRestoreBot(
  _request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;
  const { botId } = params;

  // Check if bot already exists (not deleted)
  const existing = await configDb.getBot(env.D1_DB, ownerId, botId!);
  if (existing) return errorResponse("Bot is not deleted", 409);

  // Restore from soft-delete (scoped to ownerId for tenant isolation)
  const restored = await configDb.restoreBot(env.D1_DB, ownerId, botId!);
  if (!restored) return errorResponse("No restorable bot found (may have expired)", 404);

  // Re-create token mappings for channel bindings (check for conflicts)
  const tokenConflicts: string[] = [];
  for (const [channel, cfg] of Object.entries(restored.channels)) {
    const existingMapping = await configDb.getTokenMapping(env.D1_DB, channel, cfg.token);
    if (existingMapping && existingMapping.botId !== botId) {
      tokenConflicts.push(`${channel} token already used by another bot`);
      continue;
    }
    try {
      await configDb.upsertTokenMapping(env.D1_DB, channel, cfg.token, {
        ownerId,
        botId: botId!,
      });
    } catch (e) {
      tokenConflicts.push(`Failed to restore ${channel} token mapping: ${e}`);
    }
  }

  if (tokenConflicts.length > 0) {
    return jsonResponse({ ...restored, warnings: tokenConflicts });
  }
  return jsonResponse(restored);
}

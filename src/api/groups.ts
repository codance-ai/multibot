import type { Env, GroupConfig, BotConfig } from "../config/schema";
import {
  GroupConfigSchema,
  CreateGroupSchema,
  UpdateGroupSchema,
} from "../config/schema";
import type { RouteParams } from "./router";
import * as configDb from "../db/config";

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

/**
 * Load BotConfigs for a list of botIds from D1. Skips missing entries.
 */
async function loadBotConfigs(env: Env, ownerId: string, botIds: string[]): Promise<BotConfig[]> {
  const results = await Promise.all(
    botIds.map((botId) => configDb.getBot(env.D1_DB, ownerId, botId))
  );
  return results.filter((b): b is BotConfig => b !== null);
}

/**
 * Collect unique channel names from member bots' channel bindings.
 */
function getAvailableChannels(botConfigs: BotConfig[]): string[] {
  const channels = new Set<string>();
  for (const bot of botConfigs) {
    for (const ch of Object.keys(bot.channels)) {
      channels.add(ch);
    }
  }
  return [...channels].sort();
}

/**
 * Check Telegram Privacy Mode for bots that have a telegram channel binding.
 * Returns warnings if no bot has Privacy Mode disabled.
 */
async function checkPrivacyMode(botConfigs: BotConfig[]): Promise<string[]> {
  const warnings: string[] = [];
  const telegramBots = botConfigs.filter(b => b.channels.telegram);
  if (telegramBots.length === 0) return warnings;

  let hasGroupReader = false;
  for (const bot of telegramBots) {
    try {
      const resp = await fetch(
        `https://api.telegram.org/bot${bot.channels.telegram.token}/getMe`
      );
      const data = await resp.json() as { ok: boolean; result?: { can_read_all_group_messages?: boolean } };
      if (data.ok && data.result?.can_read_all_group_messages) {
        hasGroupReader = true;
        break;
      }
    } catch (e) {
      console.warn("[groups] Telegram privacy check failed for bot:", bot.name, e);
      // Non-fatal — skip this bot's check
    }
  }

  if (!hasGroupReader) {
    warnings.push(
      "No bot has Privacy Mode disabled for Telegram. " +
      "At least one bot needs /setprivacy OFF via BotFather to receive group messages."
    );
  }
  return warnings;
}

// -- Group CRUD --

export async function handleListGroups(
  _request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;
  const groupList = await configDb.listGroups(env.D1_DB, ownerId);

  const groups = await Promise.all(
    groupList.map(async (group) => {
      const botConfigs = await loadBotConfigs(env, ownerId, group.botIds);
      return { ...group, availableChannels: getAvailableChannels(botConfigs) };
    })
  );

  return jsonResponse(groups);
}

export async function handleCreateGroup(
  request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;

  let body: unknown;
  try {
    body = await request.json();
  } catch (e) {
    console.warn("[api] Invalid JSON in create group:", e);
    return errorResponse("Invalid JSON", 400);
  }

  const parsed = CreateGroupSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.message, 400);
  }

  // Prevent adding admin bot to groups (#280)
  for (const botId of parsed.data.botIds) {
    const bot = await configDb.getBot(env.D1_DB, ownerId, botId);
    if (!bot) {
      return errorResponse(`Bot "${botId}" not found`, 404);
    }
    if (bot.botType === "admin") {
      return errorResponse(`Cannot add admin bot "${botId}" to a group`, 400);
    }
  }

  const groupId = crypto.randomUUID();
  const groupConfig: GroupConfig = {
    ...parsed.data,
    groupId,
    ownerId,
  };

  GroupConfigSchema.parse(groupConfig);

  await configDb.upsertGroup(env.D1_DB, groupConfig);

  // Check privacy mode for telegram bots
  const botConfigs = await loadBotConfigs(env, ownerId, groupConfig.botIds);
  const warnings = await checkPrivacyMode(botConfigs);
  const availableChannels = getAvailableChannels(botConfigs);

  return jsonResponse({ ...groupConfig, availableChannels, ...(warnings.length > 0 && { warnings }) }, 201);
}

export async function handleGetGroup(
  _request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;
  const { groupId } = params;

  const group = await configDb.getGroup(env.D1_DB, ownerId, groupId!);
  if (!group) return errorResponse("Group not found", 404);

  const botConfigs = await loadBotConfigs(env, ownerId, group.botIds);

  const warnings = await checkPrivacyMode(botConfigs);
  return jsonResponse({ ...group, availableChannels: getAvailableChannels(botConfigs), ...(warnings.length > 0 && { warnings }) });
}

export async function handleUpdateGroup(
  request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;
  const { groupId } = params;

  const existing = await configDb.getGroup(env.D1_DB, ownerId, groupId!);
  if (!existing) return errorResponse("Group not found", 404);

  let body: unknown;
  try {
    body = await request.json();
  } catch (e) {
    console.warn("[api] Invalid JSON in update group:", e);
    return errorResponse("Invalid JSON", 400);
  }

  const parsed = UpdateGroupSchema.safeParse(body);
  if (!parsed.success) {
    return errorResponse(parsed.error.message, 400);
  }

  // Prevent adding admin bot to groups (#280)
  if (parsed.data.botIds) {
    for (const botId of parsed.data.botIds) {
      const bot = await configDb.getBot(env.D1_DB, ownerId, botId);
      if (!bot) {
        return errorResponse(`Bot "${botId}" not found`, 404);
      }
      if (bot.botType === "admin") {
        return errorResponse(`Cannot add admin bot "${botId}" to a group`, 400);
      }
    }
  }

  const updated: GroupConfig = {
    ...existing,
    ...parsed.data,
    groupId: existing.groupId,
    ownerId: existing.ownerId,
  };

  await configDb.upsertGroup(env.D1_DB, updated);

  // Check privacy mode for telegram bots
  const botConfigs = await loadBotConfigs(env, ownerId, updated.botIds);
  const warnings = await checkPrivacyMode(botConfigs);
  const availableChannels = getAvailableChannels(botConfigs);

  return jsonResponse({ ...updated, availableChannels, ...(warnings.length > 0 && { warnings }) });
}

export async function handleDeleteGroup(
  _request: Request,
  env: Env,
  params: RouteParams
): Promise<Response> {
  const ownerId = params.ownerId;
  const { groupId } = params;

  const group = await configDb.getGroup(env.D1_DB, ownerId, groupId!);
  if (!group) return errorResponse("Group not found", 404);

  await configDb.deleteGroup(env.D1_DB, ownerId, groupId!);

  return jsonResponse({ deleted: true });
}

/**
 * Config data access layer — typed CRUD for config tables migrated from KV to D1.
 * Tables: bots, user_keys, groups, channel_tokens, skills.
 */

import type {
  BotConfig,
  UserKeys,
  GroupConfig,
  TokenMapping,
} from "../config/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function safeJsonParse<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try { return JSON.parse(raw) as T; } catch (e) { console.warn("[config] JSON parse failed, using fallback:", e); return fallback; }
}

// ---------------------------------------------------------------------------
// Row → type mappers
// ---------------------------------------------------------------------------

function rowToBotConfig(row: any): BotConfig {
  return {
    botId: row.bot_id,
    name: row.name,
    ownerId: row.owner_id,
    provider: row.provider,
    model: row.model,
    soul: row.soul ?? "",
    agents: row.agents ?? "",
    user: row.user ?? "",
    tools: row.tools ?? "",
    identity: row.identity ?? "",
    baseUrl: row.base_url ?? undefined,
    avatarUrl: row.avatar_url ?? undefined,
    channels: safeJsonParse(row.channels, {}),
    enabledSkills: safeJsonParse(row.enabled_skills, []),
    maxIterations: row.max_iterations ?? 10,
    memoryWindow: row.memory_window ?? 50,
    contextWindow: row.context_window ?? 128000,
    timezone: row.timezone ?? undefined,
    imageProvider: row.image_provider ?? undefined,
    imageModel: row.image_model ?? undefined,
    mcpServers: safeJsonParse(row.mcp_servers, {}),
    subagent: safeJsonParse(row.subagent, undefined),
    botType: (row.bot_type as "normal" | "admin") ?? "normal",
    allowedSenderIds: safeJsonParse(row.allowed_sender_ids, []),
    sttEnabled: !!row.stt_enabled,
    voiceMode: (row.voice_mode as "off" | "always" | "mirror") ?? "off",
    ttsProvider: (row.tts_provider as "elevenlabs" | "fish") ?? "fish",
    ttsVoice: row.tts_voice ?? "",
    ttsModel: row.tts_model ?? "s2-pro",
  };
}

function rowToGroupConfig(row: any): GroupConfig {
  return {
    groupId: row.group_id,
    name: row.name,
    ownerId: row.owner_id,
    botIds: safeJsonParse(row.bot_ids, []),
    note: row.note ?? "",
    orchestratorProvider: row.orchestrator_provider ?? "anthropic",
    orchestratorModel: row.orchestrator_model ?? "claude-sonnet-4-6",
    channel: row.channel ?? undefined,
    chatId: row.chat_id ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Bots
// ---------------------------------------------------------------------------

export async function getBot(
  db: D1Database,
  ownerId: string,
  botId: string
): Promise<BotConfig | null> {
  const row = await db
    .prepare(
      'SELECT * FROM bots WHERE bot_id = ? AND owner_id = ? AND deleted_at IS NULL'
    )
    .bind(botId, ownerId)
    .first();
  return row ? rowToBotConfig(row) : null;
}

export async function listBots(
  db: D1Database,
  ownerId: string
): Promise<BotConfig[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM bots WHERE owner_id = ? AND deleted_at IS NULL ORDER BY CASE WHEN bot_type = 'admin' THEN 0 ELSE 1 END, created_at ASC"
    )
    .bind(ownerId)
    .all();
  return results.map(rowToBotConfig);
}

export async function upsertBot(
  db: D1Database,
  config: BotConfig
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO bots (
        bot_id, owner_id, name, provider, model,
        soul, agents, "user", tools, identity,
        base_url, avatar_url, channels, enabled_skills,
        max_iterations, memory_window, context_window, timezone,
        image_provider, image_model, mcp_servers, subagent,
        bot_type, allowed_sender_ids,
        stt_enabled, voice_mode, tts_provider, tts_voice, tts_model
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(bot_id) DO UPDATE SET
        name = excluded.name,
        provider = excluded.provider,
        model = excluded.model,
        soul = excluded.soul,
        agents = excluded.agents,
        "user" = excluded."user",
        tools = excluded.tools,
        identity = excluded.identity,
        base_url = excluded.base_url,
        avatar_url = excluded.avatar_url,
        channels = excluded.channels,
        enabled_skills = excluded.enabled_skills,
        max_iterations = excluded.max_iterations,
        memory_window = excluded.memory_window,
        context_window = excluded.context_window,
        timezone = excluded.timezone,
        image_provider = excluded.image_provider,
        image_model = excluded.image_model,
        mcp_servers = excluded.mcp_servers,
        subagent = excluded.subagent,
        bot_type = excluded.bot_type,
        allowed_sender_ids = excluded.allowed_sender_ids,
        stt_enabled = excluded.stt_enabled,
        voice_mode = excluded.voice_mode,
        tts_provider = excluded.tts_provider,
        tts_voice = excluded.tts_voice,
        tts_model = excluded.tts_model,
        updated_at = datetime('now')`
    )
    .bind(
      config.botId,
      config.ownerId,
      config.name,
      config.provider,
      config.model,
      config.soul ?? "",
      config.agents ?? "",
      config.user ?? "",
      config.tools ?? "",
      config.identity ?? "",
      config.baseUrl ?? null,
      config.avatarUrl ?? null,
      JSON.stringify(config.channels ?? {}),
      JSON.stringify(config.enabledSkills ?? []),
      config.maxIterations ?? 10,
      config.memoryWindow ?? 50,
      config.contextWindow ?? 128000,
      config.timezone ?? null,
      config.imageProvider ?? null,
      config.imageModel ?? null,
      JSON.stringify(config.mcpServers ?? {}),
      config.subagent ? JSON.stringify(config.subagent) : null,
      config.botType ?? "normal",
      JSON.stringify(config.allowedSenderIds ?? []),
      config.sttEnabled ? 1 : 0,
      config.voiceMode ?? "off",
      config.ttsProvider ?? "fish",
      config.ttsVoice ?? "",
      config.ttsModel ?? "s2-pro"
    )
    .run();
}

export async function softDeleteBot(
  db: D1Database,
  ownerId: string,
  botId: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE bots SET deleted_at = datetime('now') WHERE bot_id = ? AND owner_id = ?"
    )
    .bind(botId, ownerId)
    .run();
}

export async function restoreBot(
  db: D1Database,
  ownerId: string,
  botId: string
): Promise<BotConfig | null> {
  const row = await db
    .prepare(
      "UPDATE bots SET deleted_at = NULL WHERE bot_id = ? AND owner_id = ? AND deleted_at IS NOT NULL RETURNING *"
    )
    .bind(botId, ownerId)
    .first();
  return row ? rowToBotConfig(row) : null;
}

export async function deleteBotPermanently(
  db: D1Database,
  ownerId: string,
  botId: string
): Promise<void> {
  await db
    .prepare("DELETE FROM bots WHERE bot_id = ? AND owner_id = ?")
    .bind(botId, ownerId)
    .run();
}

export async function getAdminBot(
  db: D1Database,
  ownerId: string,
): Promise<BotConfig | null> {
  const row = await db
    .prepare("SELECT * FROM bots WHERE owner_id = ? AND bot_type = 'admin' AND deleted_at IS NULL")
    .bind(ownerId)
    .first();
  return row ? rowToBotConfig(row) : null;
}

// ---------------------------------------------------------------------------
// User Keys
// ---------------------------------------------------------------------------

export async function getUserKeys(
  db: D1Database,
  ownerId: string
): Promise<UserKeys | null> {
  const row = await db
    .prepare("SELECT * FROM user_keys WHERE owner_id = ?")
    .bind(ownerId)
    .first<any>();
  if (!row) return null;
  return {
    openai: row.openai ?? undefined,
    anthropic: row.anthropic ?? undefined,
    google: row.google ?? undefined,
    deepseek: row.deepseek ?? undefined,
    moonshot: row.moonshot ?? undefined,
    brave: row.brave ?? undefined,
    xai: row.xai ?? undefined,
    elevenlabs: row.elevenlabs ?? undefined,
    fish: row.fish ?? undefined,
  };
}

export async function upsertUserKeys(
  db: D1Database,
  ownerId: string,
  keys: UserKeys
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO user_keys (owner_id, openai, anthropic, google, deepseek, moonshot, brave, xai, elevenlabs, fish)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         openai = excluded.openai,
         anthropic = excluded.anthropic,
         google = excluded.google,
         deepseek = excluded.deepseek,
         moonshot = excluded.moonshot,
         brave = excluded.brave,
         xai = excluded.xai,
         elevenlabs = excluded.elevenlabs,
         fish = excluded.fish,
         updated_at = datetime('now')`
    )
    .bind(
      ownerId,
      keys.openai ?? null,
      keys.anthropic ?? null,
      keys.google ?? null,
      keys.deepseek ?? null,
      keys.moonshot ?? null,
      keys.brave ?? null,
      keys.xai ?? null,
      keys.elevenlabs ?? null,
      keys.fish ?? null
    )
    .run();
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export async function getGroup(
  db: D1Database,
  ownerId: string,
  groupId: string
): Promise<GroupConfig | null> {
  const row = await db
    .prepare(
      "SELECT * FROM groups WHERE group_id = ? AND owner_id = ?"
    )
    .bind(groupId, ownerId)
    .first();
  return row ? rowToGroupConfig(row) : null;
}

export async function listGroups(
  db: D1Database,
  ownerId: string
): Promise<GroupConfig[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM groups WHERE owner_id = ? ORDER BY created_at ASC"
    )
    .bind(ownerId)
    .all();
  return results.map(rowToGroupConfig);
}

// Note: channel/chatId are managed separately via updateGroupChat (set when a
// group first receives a message on a channel). upsertGroup intentionally omits
// them so Dashboard edits don't clear the runtime-populated values.
export async function upsertGroup(
  db: D1Database,
  config: GroupConfig
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO groups (group_id, owner_id, name, bot_ids, note, orchestrator_provider, orchestrator_model)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(group_id) DO UPDATE SET
         name = excluded.name,
         bot_ids = excluded.bot_ids,
         note = excluded.note,
         orchestrator_provider = excluded.orchestrator_provider,
         orchestrator_model = excluded.orchestrator_model,
         updated_at = datetime('now')`
    )
    .bind(
      config.groupId,
      config.ownerId,
      config.name,
      JSON.stringify(config.botIds),
      config.note ?? "",
      config.orchestratorProvider ?? "anthropic",
      config.orchestratorModel ?? "claude-sonnet-4-6"
    )
    .run();
}

export async function deleteGroup(
  db: D1Database,
  ownerId: string,
  groupId: string
): Promise<void> {
  await db
    .prepare("DELETE FROM groups WHERE group_id = ? AND owner_id = ?")
    .bind(groupId, ownerId)
    .run();
}

export async function findGroupForBot(
  db: D1Database,
  ownerId: string,
  botId: string
): Promise<GroupConfig | null> {
  const row = await db
    .prepare(
      `SELECT * FROM groups
       WHERE owner_id = ?
         AND group_id IN (
           SELECT g.group_id FROM groups g, json_each(g.bot_ids) j
           WHERE g.owner_id = ? AND j.value = ?
         )
       LIMIT 1`
    )
    .bind(ownerId, ownerId, botId)
    .first();
  return row ? rowToGroupConfig(row) : null;
}

export async function findAllGroupsForBot(
  db: D1Database,
  ownerId: string,
  botId: string
): Promise<GroupConfig[]> {
  const { results } = await db
    .prepare(
      `SELECT * FROM groups
       WHERE owner_id = ?
         AND group_id IN (
           SELECT g.group_id FROM groups g, json_each(g.bot_ids) j
           WHERE g.owner_id = ? AND j.value = ?
         )
       ORDER BY created_at ASC`
    )
    .bind(ownerId, ownerId, botId)
    .all();
  return results.map(rowToGroupConfig);
}

export async function updateGroupChat(
  db: D1Database,
  ownerId: string,
  groupId: string,
  channel: string,
  chatId: string
): Promise<void> {
  await db
    .prepare(
      "UPDATE groups SET channel = ?, chat_id = ?, updated_at = datetime('now') WHERE group_id = ? AND owner_id = ?"
    )
    .bind(channel, chatId, groupId, ownerId)
    .run();
}

// ---------------------------------------------------------------------------
// Token Mappings
// ---------------------------------------------------------------------------

export async function getTokenMapping(
  db: D1Database,
  channel: string,
  token: string
): Promise<TokenMapping | null> {
  const row = await db
    .prepare(
      "SELECT owner_id, bot_id FROM channel_tokens WHERE channel = ? AND token = ?"
    )
    .bind(channel, token)
    .first<{ owner_id: string; bot_id: string }>();
  if (!row) return null;
  return { ownerId: row.owner_id, botId: row.bot_id };
}

export async function upsertTokenMapping(
  db: D1Database,
  channel: string,
  token: string,
  mapping: TokenMapping
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO channel_tokens (channel, token, owner_id, bot_id)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(channel, token) DO UPDATE SET
         owner_id = excluded.owner_id,
         bot_id = excluded.bot_id`
    )
    .bind(channel, token, mapping.ownerId, mapping.botId)
    .run();
}

export async function deleteTokenMapping(
  db: D1Database,
  channel: string,
  token: string
): Promise<void> {
  await db
    .prepare("DELETE FROM channel_tokens WHERE channel = ? AND token = ?")
    .bind(channel, token)
    .run();
}

/**
 * Update only the channel identity fields (channelUsername/channelUserId) for a bot's channel binding.
 * Uses a single SQL UPDATE with json_set to avoid read-modify-write race conditions.
 */
export async function updateChannelIdentity(
  db: D1Database,
  ownerId: string,
  botId: string,
  channel: string,
  identity: { channelUsername?: string; channelUserId?: string },
): Promise<void> {
  // Build json_set chain to patch only the specified identity fields atomically
  let sql = "UPDATE bots SET channels = json_set(channels";
  const bindings: (string | null)[] = [];

  if (identity.channelUsername !== undefined) {
    sql += ", '$.' || ? || '.channelUsername', ?";
    bindings.push(channel, identity.channelUsername);
  }
  if (identity.channelUserId !== undefined) {
    sql += ", '$.' || ? || '.channelUserId', ?";
    bindings.push(channel, identity.channelUserId);
  }

  if (bindings.length === 0) return;

  sql += "), updated_at = datetime('now') WHERE bot_id = ? AND owner_id = ? AND json_extract(channels, '$.' || ?) IS NOT NULL";
  bindings.push(botId, ownerId, channel);

  const result = await db.prepare(sql).bind(...bindings).run();
  if (result.meta.changes === 0) {
    console.warn(`[config] updateChannelIdentity: no rows updated for bot=${botId} channel=${channel} — binding may not exist`);
  }
}

export async function deleteTokenMappingsForBot(
  db: D1Database,
  ownerId: string,
  botId: string
): Promise<void> {
  await db
    .prepare("DELETE FROM channel_tokens WHERE bot_id = ? AND owner_id = ?")
    .bind(botId, ownerId)
    .run();
}

// ---------------------------------------------------------------------------
// Skill Secrets
// ---------------------------------------------------------------------------

/** Get all skill secrets for an owner, keyed by skill name. */
export async function getSkillSecrets(
  db: D1Database,
  ownerId: string,
): Promise<Record<string, Record<string, string>>> {
  const { results } = await db
    .prepare("SELECT skill_name, env_vars FROM skill_secrets WHERE owner_id = ?")
    .bind(ownerId)
    .all<{ skill_name: string; env_vars: string }>();

  const secrets: Record<string, Record<string, string>> = {};
  for (const row of results) {
    try {
      secrets[row.skill_name] = JSON.parse(row.env_vars);
    } catch (e) { console.warn("[config] Malformed skill secret JSON:", row.skill_name, e); }
  }
  return secrets;
}

/** Upsert env vars for a specific skill. */
export async function upsertSkillSecret(
  db: D1Database,
  ownerId: string,
  skillName: string,
  envVars: Record<string, string>,
): Promise<void> {
  const serialized = JSON.stringify(envVars);
  await db
    .prepare(
      `INSERT INTO skill_secrets (owner_id, skill_name, env_vars, updated_at)
       VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(owner_id, skill_name) DO UPDATE SET
         env_vars = excluded.env_vars, updated_at = datetime('now')`
    )
    .bind(ownerId, skillName, serialized)
    .run();
}

/** Delete secrets for a specific skill. */
export async function deleteSkillSecret(
  db: D1Database,
  ownerId: string,
  skillName: string,
): Promise<void> {
  await db
    .prepare("DELETE FROM skill_secrets WHERE owner_id = ? AND skill_name = ?")
    .bind(ownerId, skillName)
    .run();
}

/** Get skill secrets for a bot based on enabledSkills.
 *  enabledSkills controls both bundled and installed skills uniformly.
 *  Returns both flat (for exec env injection) and perSkill (for system prompt XML). */
export async function getSkillSecretsForBot(
  db: D1Database,
  ownerId: string,
  enabledSkills: string[],
): Promise<{ flat: Record<string, string>; perSkill: Record<string, Record<string, string>> }> {
  if (enabledSkills.length === 0) return { flat: {}, perSkill: {} };

  const all = await getSkillSecrets(db, ownerId);
  const perSkill: Record<string, Record<string, string>> = {};
  const flat: Record<string, string> = {};
  for (const name of enabledSkills) {
    const vars = all[name];
    if (vars) {
      perSkill[name] = vars;
      for (const [key, val] of Object.entries(vars)) {
        if (key in flat && flat[key] !== val) {
          console.warn(`[config] Skill secret key "${key}" from skill "${name}" overwrites existing value from another skill`);
        }
        flat[key] = val;
      }
    }
  }
  return { flat, perSkill };
}


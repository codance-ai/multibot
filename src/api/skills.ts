import type { Env } from "../config/schema";
import type { RouteParams } from "./router";
import { listAllSkills } from "../skills/loader";
import { BUILTIN_SKILLS } from "../skills/builtin";
import * as configDb from "../db/config";

function jsonResponse(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function errorResponse(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export async function handleListSkills(
  _request: Request,
  env: Env,
  params: RouteParams,
): Promise<Response> {
  // Dashboard lists all skills globally (no botId filter — shows all installed skills across bots)
  const skills = await listAllSkills(env.D1_DB);

  // Load owner's configured secrets to check status
  const secrets = await configDb.getSkillSecrets(env.D1_DB, params.ownerId);

  // Load installed skill → bot_id mapping for dashboard bot-form
  let installedBotMap: Record<string, string[]> = {};
  try {
    const { results } = await env.D1_DB
      .prepare("SELECT name, bot_id FROM skills")
      .all<{ name: string; bot_id: string }>();
    for (const row of results) {
      if (!installedBotMap[row.name]) installedBotMap[row.name] = [];
      installedBotMap[row.name].push(row.bot_id);
    }
  } catch (e) {
    console.warn("[api] Failed to query installed skill bot mapping:", e);
  }

  const result = skills.map((s) => {
    // Merge declared requiresEnv with actually-configured secret keys
    const declaredEnv = s.requiresEnv ?? [];
    const secretKeys = secrets[s.name] ? Object.keys(secrets[s.name]) : [];
    const allEnvKeys = [...new Set([...declaredEnv, ...secretKeys])];

    return {
      name: s.name,
      description: s.description,
      adminOnly: s.adminOnly ?? false,
      available: s.available,
      source: s.source,
      ...(s.emoji && { emoji: s.emoji }),
      ...(s.source === "installed" && installedBotMap[s.name] && {
        installedBotIds: installedBotMap[s.name],
      }),
      ...(allEnvKeys.length > 0 && {
        requiresEnv: allEnvKeys,
        envConfigured: Object.fromEntries(
          allEnvKeys.map(key => [
            key,
            !!(secrets[s.name] && secrets[s.name][key]),
          ])
        ),
      }),
    };
  });

  return jsonResponse(result);
}

export async function handleDeleteSkill(
  _request: Request,
  env: Env,
  params: RouteParams,
): Promise<Response> {
  const skillName = decodeURIComponent(params.skillName);
  const botId = params.botId;

  if (skillName in BUILTIN_SKILLS) {
    return errorResponse("Cannot delete builtin skill", 400);
  }

  // Find affected bots before deleting (to clean up enabledSkills)
  let affectedBotIds: string[] = [];
  try {
    const query = botId
      ? env.D1_DB.prepare("SELECT bot_id FROM skills WHERE bot_id = ? AND name = ?").bind(botId, skillName)
      : env.D1_DB.prepare("SELECT bot_id FROM skills WHERE name = ?").bind(skillName);
    const { results } = await query.all<{ bot_id: string }>();
    affectedBotIds = results.map((r) => r.bot_id);
  } catch (e) {
    console.warn("[api] Failed to query affected bots for skill deletion:", e);
  }

  // Delete with bot_id if provided, otherwise delete all instances of this skill
  const result = botId
    ? await env.D1_DB
        .prepare("DELETE FROM skills WHERE bot_id = ? AND name = ?")
        .bind(botId, skillName)
        .run()
    : await env.D1_DB
        .prepare("DELETE FROM skills WHERE name = ?")
        .bind(skillName)
        .run();

  if (result.meta.changes === 0) {
    return errorResponse("Skill not found", 404);
  }

  // Remove from enabledSkills for affected bots (best-effort)
  for (const affectedBotId of affectedBotIds) {
    try {
      const bot = await configDb.getBot(env.D1_DB, params.ownerId, affectedBotId);
      if (bot && bot.enabledSkills.includes(skillName)) {
        bot.enabledSkills = bot.enabledSkills.filter((s) => s !== skillName);
        await configDb.upsertBot(env.D1_DB, bot);
      }
    } catch (e) {
      console.warn(`[api] Failed to clean enabledSkills for bot ${affectedBotId}:`, e);
    }
  }

  return jsonResponse({ deleted: true });
}

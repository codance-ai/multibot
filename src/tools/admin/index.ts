/**
 * Admin management tools — only available to the admin bot.
 * Provides CRUD for bots, groups, channels, API keys, skills, and sessions.
 */

import type { ToolSet } from "ai";
import type { Env } from "../../config/schema";
import type { AdminToolDeps } from "./utils";
import { createBotTools } from "./bots";
import { createChannelTools } from "./channels";
import { createGroupTools } from "./groups";
import { createKeysAndSkillTools } from "./keys-skills";
import { createObservabilityTools } from "./observability";
import { createBatchTools } from "./batch";

export function createAdminTools(env: Env, ownerId: string): ToolSet {
  const deps: AdminToolDeps = {
    db: env.D1_DB,
    env,
    ownerId,
    baseUrl: env.BASE_URL || "",
  };

  return {
    ...createBotTools(deps),
    ...createChannelTools(deps),
    ...createGroupTools(deps),
    ...createKeysAndSkillTools(deps),
    ...createObservabilityTools(deps),
    ...createBatchTools(deps),
  };
}

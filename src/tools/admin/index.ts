/**
 * Admin management tools — only available to the admin bot.
 * Provides CRUD for bots, groups, channels, API keys, skills, sessions, and sandbox access.
 */

import type { ToolSet } from "ai";
import type { Env } from "../../config/schema";
import type { SandboxClient } from "../sandbox-types";
import type { AdminToolDeps } from "./utils";
import { createBotTools } from "./bots";
import { createChannelTools } from "./channels";
import { createGroupTools } from "./groups";
import { createKeysAndSkillTools } from "./keys-skills";
import { createObservabilityTools } from "./observability";
import { createBatchTools } from "./batch";
import { createSandboxAdminTools } from "./sandbox";

export function createAdminTools(
  env: Env,
  ownerId: string,
  getSandboxClient?: (botId: string) => SandboxClient,
): ToolSet {
  const deps: AdminToolDeps = {
    db: env.D1_DB,
    env,
    ownerId,
    baseUrl: env.BASE_URL || "",
    getSandboxClient,
  };

  return {
    ...createBotTools(deps),
    ...createChannelTools(deps),
    ...createGroupTools(deps),
    ...createKeysAndSkillTools(deps),
    ...createObservabilityTools(deps),
    ...createBatchTools(deps),
    ...createSandboxAdminTools(deps),
  };
}

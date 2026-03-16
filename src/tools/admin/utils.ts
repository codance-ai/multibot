/**
 * Shared utilities and constants for admin tools.
 */

import type { Env, BotConfig } from "../../config/schema";
import { listAllSkills } from "../../skills/loader";

/** Shared dependencies passed to each admin tool sub-module. */
export interface AdminToolDeps {
  db: D1Database;
  env: Env;
  ownerId: string;
  baseUrl: string;
}

/** Validate skill names against bundled + installed skills. Returns error message or null. */
export async function validateSkillNames(
  db: D1Database,
  names: string[],
): Promise<string | null> {
  if (names.length === 0) return null;
  const allSkills = await listAllSkills(db);
  const validNames = new Set(allSkills.map((s) => s.name));
  const invalid = names.filter((n) => !validNames.has(n));
  if (invalid.length === 0) return null;
  return `Unknown skill(s): ${invalid.join(", ")}. Available: ${[...validNames].sort().join(", ")}`;
}

export const UPDATE_BOT_CLEAR_FIELDS = [
  "soul",
  "agents",
  "identity",
  "enabledSkills",
  "allowedSenderIds",
  "baseUrl",
  "avatarUrl",
  "timezone",
  "imageProvider",
  "imageModel",
] as const;

export const BATCH_UPDATE_BOT_CLEAR_FIELDS = [
  "enabledSkills",
  "timezone",
  "imageProvider",
  "imageModel",
] as const;

export type UpdateBotClearField = (typeof UPDATE_BOT_CLEAR_FIELDS)[number];
export type BatchUpdateBotClearField = (typeof BATCH_UPDATE_BOT_CLEAR_FIELDS)[number];

export function sanitizeUpdatesWithClearFields<TField extends string>(
  updates: Record<string, unknown>,
  clearFieldsInput: TField[] | undefined,
  options: {
    clearableFields: readonly TField[];
    nullableClearFields: readonly string[];
    ignoreEmptyStringFields: readonly string[];
    ignoreEmptyArrayFields: readonly string[];
  },
): {
  updates: Record<string, unknown>;
  clearFields: Set<TField>;
  error?: string;
} {
  const allowedClearFields = new Set(options.clearableFields);
  const clearFields = new Set<TField>(clearFieldsInput ?? []);

  for (const field of clearFields) {
    if (!allowedClearFields.has(field)) {
      return {
        updates: {},
        clearFields: new Set<TField>(),
        error: `Invalid clear field: ${field}`,
      };
    }
  }

  const sanitized: Record<string, unknown> = {};
  const ignoreEmptyString = new Set(options.ignoreEmptyStringFields);
  const ignoreEmptyArray = new Set(options.ignoreEmptyArrayFields);
  const nullableClear = new Set(options.nullableClearFields);

  for (const [key, value] of Object.entries(updates)) {
    if (value === undefined) continue;

    if (clearFields.has(key as TField)) {
      return {
        updates: {},
        clearFields: new Set<TField>(),
        error: `Conflicting update for "${key}": cannot set value and clear it in the same call.`,
      };
    }

    if (value === null && nullableClear.has(key) && allowedClearFields.has(key as TField)) {
      clearFields.add(key as TField);
      continue;
    }

    if (value === "" && ignoreEmptyString.has(key)) continue;
    if (Array.isArray(value) && value.length === 0 && ignoreEmptyArray.has(key)) continue;

    sanitized[key] = value;
  }

  return { updates: sanitized, clearFields };
}

export function applyUpdateBotClearField(bot: BotConfig, field: UpdateBotClearField): void {
  switch (field) {
    case "soul":
    case "agents":
    case "identity":
      bot[field] = "";
      return;
    case "enabledSkills":
    case "allowedSenderIds":
      bot[field] = [];
      return;
    case "baseUrl":
    case "avatarUrl":
    case "timezone":
    case "imageProvider":
    case "imageModel":
      bot[field] = undefined;
      return;
  }
}

export function applyBatchUpdateBotClearField(
  bot: BotConfig,
  field: BatchUpdateBotClearField,
): void {
  switch (field) {
    case "enabledSkills":
      bot.enabledSkills = [];
      return;
    case "timezone":
      bot.timezone = undefined;
      return;
    case "imageProvider":
      bot.imageProvider = undefined;
      return;
    case "imageModel":
      bot.imageModel = undefined;
      return;
  }
}

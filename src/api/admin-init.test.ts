import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../db/config");
import * as configDb from "../db/config";
import { ensureAdminBot } from "./admin-init";
import { BUNDLED_SKILL_META } from "../skills/builtin";

describe("ensureAdminBot", () => {
  const mockDb = {} as D1Database;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing if admin bot already exists", async () => {
    vi.mocked(configDb.getAdminBot).mockResolvedValueOnce({
      botId: "admin-1",
    } as any);
    await ensureAdminBot(mockDb, "owner@test.com");
    expect(configDb.upsertBot).not.toHaveBeenCalled();
  });

  it("creates admin bot if none exists", async () => {
    vi.mocked(configDb.getAdminBot).mockResolvedValueOnce(null);
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    await ensureAdminBot(mockDb, "owner@test.com");
    expect(configDb.upsertBot).toHaveBeenCalledOnce();
    const bot = vi.mocked(configDb.upsertBot).mock.calls[0][1];
    expect(bot.botType).toBe("admin");
    expect(bot.name).toBe("Admin");
    expect(bot.ownerId).toBe("owner@test.com");
    expect(bot.provider).toBe("anthropic");
    expect(bot.model).toBe("claude-sonnet-4-6");
    expect(bot.enabledSkills).toEqual(BUNDLED_SKILL_META.map(m => m.name));
    expect(bot.maxIterations).toBe(25);
    expect(bot.botId).toBeDefined();
    expect(bot.allowedSenderIds).toEqual([]);
  });

  it("creates admin bot with unique botId", async () => {
    vi.mocked(configDb.getAdminBot).mockResolvedValue(null);
    vi.mocked(configDb.upsertBot).mockResolvedValue(undefined);
    await ensureAdminBot(mockDb, "owner@test.com");
    await ensureAdminBot(mockDb, "owner@test.com");
    const bot1 = vi.mocked(configDb.upsertBot).mock.calls[0][1];
    const bot2 = vi.mocked(configDb.upsertBot).mock.calls[1][1];
    expect(bot1.botId).not.toBe(bot2.botId);
  });
});

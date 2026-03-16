import { describe, it, expect } from "vitest";
import { isAdminBotAuthorized } from "./admin-auth";
import type { BotConfig } from "../config/schema";

function makeBotConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    botId: "bot-1",
    name: "Test Bot",
    ownerId: "owner-1",
    soul: "",
    agents: "",
    user: "",
    tools: "",
    identity: "",
    provider: "openai",
    model: "gpt-4o",
    channels: {},
    enabledSkills: [],
    maxIterations: 10,
    memoryWindow: 50,
    contextWindow: 128000,
    mcpServers: {},
    botType: "normal",
    allowedSenderIds: [],
    ...overrides,
  };
}

describe("isAdminBotAuthorized", () => {
  it("allows any sender for normal bots", () => {
    const config = makeBotConfig({ botType: "normal" });
    expect(isAdminBotAuthorized(config, "any-user")).toBe(true);
  });

  it("allows any sender for normal bots even with empty allowedSenderIds", () => {
    const config = makeBotConfig({ botType: "normal", allowedSenderIds: [] });
    expect(isAdminBotAuthorized(config, "any-user")).toBe(true);
  });

  it("rejects all senders when admin bot has empty allowedSenderIds", () => {
    const config = makeBotConfig({ botType: "admin", allowedSenderIds: [] });
    expect(isAdminBotAuthorized(config, "user-123")).toBe(false);
  });

  it("allows sender in admin bot allowedSenderIds", () => {
    const config = makeBotConfig({
      botType: "admin",
      allowedSenderIds: ["user-123", "user-456"],
    });
    expect(isAdminBotAuthorized(config, "user-123")).toBe(true);
  });

  it("rejects sender not in admin bot allowedSenderIds", () => {
    const config = makeBotConfig({
      botType: "admin",
      allowedSenderIds: ["user-123"],
    });
    expect(isAdminBotAuthorized(config, "user-999")).toBe(false);
  });

  it("handles single-entry allowedSenderIds correctly", () => {
    const config = makeBotConfig({
      botType: "admin",
      allowedSenderIds: ["only-allowed"],
    });
    expect(isAdminBotAuthorized(config, "only-allowed")).toBe(true);
    expect(isAdminBotAuthorized(config, "someone-else")).toBe(false);
  });
});

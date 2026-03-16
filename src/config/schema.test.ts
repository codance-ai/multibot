import { describe, it, expect } from "vitest";
import { BotConfigSchema, CreateBotSchema } from "./schema";

describe("BotConfigSchema", () => {
  const validBot = {
    botId: "test-id",
    name: "Test",
    ownerId: "owner@test.com",
    provider: "openai" as const,
    model: "gpt-4o",
  };

  it("defaults botType to normal", () => {
    const result = BotConfigSchema.parse(validBot);
    expect(result.botType).toBe("normal");
  });

  it("accepts admin botType", () => {
    const result = BotConfigSchema.parse({ ...validBot, botType: "admin" });
    expect(result.botType).toBe("admin");
  });

  it("rejects invalid botType", () => {
    expect(() => BotConfigSchema.parse({ ...validBot, botType: "superadmin" })).toThrow();
  });

  it("defaults allowedSenderIds to empty array", () => {
    const result = BotConfigSchema.parse(validBot);
    expect(result.allowedSenderIds).toEqual([]);
  });

  it("accepts allowedSenderIds array", () => {
    const result = BotConfigSchema.parse({ ...validBot, allowedSenderIds: ["123", "456"] });
    expect(result.allowedSenderIds).toEqual(["123", "456"]);
  });

  it("defaults voice config fields", () => {
    const result = BotConfigSchema.parse(validBot);
    expect(result.sttEnabled).toBe(false);
    expect(result.voiceMode).toBe("off");
    expect(result.ttsProvider).toBe("fish");
    expect(result.ttsVoice).toBe("");
    expect(result.ttsModel).toBe("s2-pro");
  });

  it("accepts custom voice config", () => {
    const result = BotConfigSchema.parse({
      ...validBot,
      sttEnabled: true,
      voiceMode: "mirror",
      ttsProvider: "fish",
      ttsVoice: "nova",
      ttsModel: "tts-1-hd",
    });
    expect(result.sttEnabled).toBe(true);
    expect(result.voiceMode).toBe("mirror");
    expect(result.ttsProvider).toBe("fish");
    expect(result.ttsVoice).toBe("nova");
    expect(result.ttsModel).toBe("tts-1-hd");
  });

  it("rejects invalid voiceMode", () => {
    expect(() => BotConfigSchema.parse({ ...validBot, voiceMode: "auto" })).toThrow();
  });
});

describe("BotConfig channel schema", () => {
  it("accepts channelUsername in channel binding", () => {
    const config = BotConfigSchema.parse({
      botId: "b1", name: "TestBot", ownerId: "o1",
      provider: "openai", model: "gpt-5-mini",
      channels: {
        telegram: { token: "tok123", channelUsername: "@testbot" },
        discord: { token: "tok456", channelUserId: "123456789" },
        slack: { token: "tok789", channelUserId: "U12345" },
      },
    });
    expect(config.channels.telegram.channelUsername).toBe("@testbot");
    expect(config.channels.discord.channelUserId).toBe("123456789");
    expect(config.channels.slack.channelUserId).toBe("U12345");
  });

  it("works without channelUsername (backward compat)", () => {
    const config = BotConfigSchema.parse({
      botId: "b1", name: "TestBot", ownerId: "o1",
      provider: "openai", model: "gpt-5-mini",
      channels: { telegram: { token: "tok123" } },
    });
    expect(config.channels.telegram.channelUsername).toBeUndefined();
    expect(config.channels.telegram.channelUserId).toBeUndefined();
  });
});

describe("CreateBotSchema", () => {
  it("omits botType (system-set, not user-set)", () => {
    const shape = CreateBotSchema.shape;
    expect("botType" in shape).toBe(false);
  });

  it("omits botId and ownerId", () => {
    const shape = CreateBotSchema.shape;
    expect("botId" in shape).toBe(false);
    expect("ownerId" in shape).toBe(false);
  });
});

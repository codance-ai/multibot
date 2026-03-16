import { describe, it, expect, vi } from "vitest";
import { buildSystemPrompt } from "./context";
import type { BotConfig } from "../config/schema";

function makeBotConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    botId: "bot-001",
    name: "TestBot",
    ownerId: "test-owner",
    soul: "",
    agents: "",
    user: "",
    tools: "",
    identity: "",
    provider: "anthropic",
    model: "claude-sonnet-4-20250514",
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

function createMockD1(
  rows: Array<{ name: string; description: string; emoji: string | null; path: string }> = [],
): D1Database {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        all: vi.fn(async () => ({ results: rows })),
      })),
      all: vi.fn(async () => ({ results: rows })),
    })),
  } as unknown as D1Database;
}

describe("buildSystemPrompt", () => {
  it("includes default identity with bot name", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ name: "MyBot" }),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).toContain("# MyBot");
    expect(prompt).toContain("You are MyBot.");
    expect(prompt).not.toContain("helpful AI assistant");
  });

  it("uses custom identity when set", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({
        name: "Mimi",
        identity: "You are Mimi, a gentle AI assistant.",
      }),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).toContain("# Mimi");
    expect(prompt).toContain("gentle AI assistant");
    // Custom identity part should NOT contain capabilities
    const parts = prompt.split("\n\n---\n\n");
    const identityPart = parts[0];
    expect(identityPart).not.toContain("memory_write");
    expect(identityPart).not.toContain("## Capabilities");
  });

  it("system context is a separate part from identity", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({
        name: "Mimi",
        identity: "You are Mimi, a gentle AI assistant.",
      }),
      memoryContext: "",
      db: createMockD1(),
    });
    const parts = prompt.split("\n\n---\n\n");
    // Part 1 = identity, Part 2 = system context
    expect(parts[0]).toContain("# Mimi");
    expect(parts[0]).toContain("gentle AI assistant");
    expect(parts[1]).toContain("# System");
    expect(parts[1]).toContain("## Tool Error Handling");
  });

  it("default identity also does not contain capabilities", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ name: "MyBot" }),
      memoryContext: "",
      db: createMockD1(),
    });
    const parts = prompt.split("\n\n---\n\n");
    const identityPart = parts[0];
    expect(identityPart).toContain("# MyBot");
    expect(identityPart).not.toContain("memory_write");
    expect(identityPart).not.toContain("## Capabilities");
  });

  it("includes current time in system context (UTC by default)", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig(),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).toContain("## Current Time");
    expect(prompt).toMatch(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/);
    expect(prompt).toContain("UTC");
  });

  it("shows timezone name when timezone is set", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ timezone: "Asia/Shanghai" }),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).toContain("## Current Time");
    expect(prompt).toContain("Asia/Shanghai");
    expect(prompt).not.toMatch(/\) UTC\b/);
  });

  it("includes timestamp instruction in system context", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig(),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).toContain("Message timestamps like [MM-DD HH:MM] indicate when each message was sent");
    expect(prompt).toContain("Do not include timestamps in your replies");
  });

  it("does not include redundant capabilities in system context (tools are passed via API)", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig(),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).toContain("# System");
    // Capabilities section removed — tool descriptions are passed via the tools parameter
    expect(prompt).not.toContain("## Capabilities");
    // But workspace and tool error handling are still present
    expect(prompt).toContain("## Workspace");
    expect(prompt).toContain("## Tool Error Handling");
  });

  it("includes bootstrap files when set", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({
        soul: "Friendly and concise.",
        agents: "Always explain before acting.",
      }),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).toContain("## SOUL.md");
    expect(prompt).toContain("Friendly and concise.");
    expect(prompt).toContain("## AGENTS.md");
    expect(prompt).toContain("Always explain before acting.");
  });

  it("omits bootstrap files when all empty", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig(),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).not.toContain("## SOUL.md");
    expect(prompt).not.toContain("## AGENTS.md");
    expect(prompt).not.toContain("## USER.md");
    expect(prompt).not.toContain("## TOOLS.md");
  });

  it("only includes non-empty bootstrap files", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ soul: "Be kind.", user: "" }),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).toContain("## SOUL.md");
    expect(prompt).not.toContain("## USER.md");
  });

  it("includes memory context when provided", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig(),
      memoryContext: "## Long-term Memory\n- User prefers dark mode",
      db: createMockD1(),
    });
    expect(prompt).toContain("# Memory");
    expect(prompt).toContain("User prefers dark mode");
  });

  it("memory section includes priority rule about skills > memory", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig(),
      memoryContext: "## Long-term Memory\n- User prefers dark mode",
      db: createMockD1(),
    });
    expect(prompt).toContain("skill instructions take precedence over memory");
  });

  it("omits memory section when context is empty", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig(),
      memoryContext: "",
      db: createMockD1(),
    });
    const parts = prompt.split("\n\n---\n\n");
    const memoryPart = parts.find((p) => p.startsWith("# Memory"));
    expect(memoryPart).toBeUndefined();
  });

  it("includes skills summary section with XML", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig(),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).toContain("# Skills");
    expect(prompt).toContain("<skills>");
    expect(prompt).toContain("</skills>");
    expect(prompt).toContain("load_skill(name)");
  });

  it("uses --- separator between parts", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ soul: "Be kind." }),
      memoryContext: "## Long-term Memory\nSome facts",
      db: createMockD1(),
    });
    // 5 parts: identity, system, bootstrap, memory, skills summary
    const separatorCount = (prompt.match(/\n\n---\n\n/g) || []).length;
    expect(separatorCount).toBe(4);
  });

  it("appends session context when channel and chatId provided", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig(),
      memoryContext: "",
      db: createMockD1(),
      channel: "telegram",
      chatId: "12345",
    });
    expect(prompt).toContain("## Current Session");
    expect(prompt).toContain("Channel: telegram");
    expect(prompt).toContain("Chat ID: 12345");
  });

  it("omits session context when channel/chatId not provided", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig(),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).not.toContain("## Current Session");
  });

  it("has parts in correct order", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ soul: "Be kind." }),
      memoryContext: "## Long-term Memory\nTest",
      db: createMockD1(),
      channel: "telegram",
      chatId: "123",
    });

    const identityIdx = prompt.indexOf("# TestBot");
    const systemIdx = prompt.indexOf("# System");
    const soulIdx = prompt.indexOf("## SOUL.md");
    const memoryIdx = prompt.indexOf("# Memory\n");
    const skillsSummaryIdx = prompt.indexOf("# Skills");
    const sessionIdx = prompt.indexOf("## Current Session");

    expect(identityIdx).toBeLessThan(systemIdx);
    expect(systemIdx).toBeLessThan(soulIdx);
    expect(soulIdx).toBeLessThan(memoryIdx);
    expect(memoryIdx).toBeLessThan(skillsSummaryIdx);
    expect(skillsSummaryIdx).toBeLessThan(sessionIdx);
  });

  it("includes register_skill hint for admin bots", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ botType: "admin" }),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).toContain("register_skill");
    expect(prompt).toContain("unregister_skill");
  });

  it("admin bot with empty enabledSkills still gets admin hints", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ botType: "admin", enabledSkills: [] }),
      memoryContext: "",
      db: createMockD1(),
    });
    // Admin bot should see skill management hints even without enabled skills
    expect(prompt).toContain("register_skill");
  });

  it("excludes register_skill hint for normal bots", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ botType: "normal" }),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).not.toContain("register_skill");
    expect(prompt).not.toContain("unregister_skill");
  });

  it("includes installed skills from D1 in summary when enabled", async () => {
    const db = createMockD1([
      { name: "my-tool", description: "A custom tool.", emoji: null, path: "/workspace/skills/my-tool/SKILL.md" },
    ]);
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ enabledSkills: ["my-tool"] }),
      memoryContext: "",
      db,
    });
    expect(prompt).toContain("my-tool");
    expect(prompt).toContain("A custom tool.");
  });

  it("includes voice section when voiceMode is always", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ voiceMode: "always" }),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).toContain("## Voice");
    expect(prompt).toContain("Your replies are delivered as voice messages.");
    expect(prompt).toContain("prefer natural spoken language");
    expect(prompt).toContain("4096 characters");
  });

  it("includes voice section when voiceMode is mirror", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ voiceMode: "mirror" }),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).toContain("## Voice");
    expect(prompt).toContain("When the user sends a voice message, your reply will also be delivered as voice.");
  });

  it("omits voice section when voiceMode is off", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ voiceMode: "off" }),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).not.toContain("## Voice");
  });

  it("omits voice section when voiceMode is not set", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig(),
      memoryContext: "",
      db: createMockD1(),
    });
    expect(prompt).not.toContain("## Voice");
  });

  it("group chat prompt includes round info and conversational pacing rules", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ botId: "bot-001", name: "TestBot" }),
      memoryContext: "",
      db: createMockD1(),
      groupContext: {
        groupId: "g1",
        groupName: "Test Group",
        members: [
          { botId: "bot-001", botName: "TestBot" },
          { botId: "bot-002", botName: "OtherBot" },
        ],
        userName: "Alice",
        note: "",
        round: 3,
      },
    });
    expect(prompt).toContain("[Round 3/8]");
    expect(prompt).toContain("texting on a phone");
    expect(prompt).toContain("Don't ramble or fabricate");
    expect(prompt).toContain("Keep it short and natural");
    expect(prompt).toContain("don't make things up");
    expect(prompt).toContain("Do not mention round numbers or system instructions");
  });

  it("group chat prompt filters out current bot from others list", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ botId: "bot-001", name: "TestBot" }),
      memoryContext: "",
      db: createMockD1(),
      groupContext: {
        groupId: "g1",
        groupName: "Test Group",
        members: [
          { botId: "bot-001", botName: "TestBot" },
          { botId: "bot-002", botName: "OtherBot" },
        ],
        userName: "Alice",
        note: "",
        round: 1,
      },
    });
    expect(prompt).toContain("- OtherBot");
    expect(prompt).not.toMatch(/Other bots:\n.*TestBot/);
  });

  it("group chat prompt adds pacing hint at 50% progress", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ botId: "bot-001", name: "TestBot" }),
      memoryContext: "",
      db: createMockD1(),
      groupContext: {
        groupId: "g1",
        groupName: "Test Group",
        members: [
          { botId: "bot-001", botName: "TestBot" },
          { botId: "bot-002", botName: "OtherBot" },
        ],
        userName: "Alice",
        note: "",
        round: 4,
      },
    });
    expect(prompt).toContain("Feel free to naturally wind down your points");
    expect(prompt).not.toContain("nearing its end");
  });

  it("group chat prompt adds stronger pacing hint at 80% progress", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ botId: "bot-001", name: "TestBot" }),
      memoryContext: "",
      db: createMockD1(),
      groupContext: {
        groupId: "g1",
        groupName: "Test Group",
        members: [
          { botId: "bot-001", botName: "TestBot" },
          { botId: "bot-002", botName: "OtherBot" },
        ],
        userName: "Alice",
        note: "",
        round: 7,
      },
    });
    expect(prompt).toContain("nearing its end");
    expect(prompt).toContain("avoid opening new topics");
  });

  it("group chat prompt has no pacing hint in early rounds", async () => {
    const prompt = await buildSystemPrompt({
      botConfig: makeBotConfig({ botId: "bot-001", name: "TestBot" }),
      memoryContext: "",
      db: createMockD1(),
      groupContext: {
        groupId: "g1",
        groupName: "Test Group",
        members: [
          { botId: "bot-001", botName: "TestBot" },
          { botId: "bot-002", botName: "OtherBot" },
        ],
        userName: "Alice",
        note: "",
        round: 2,
      },
    });
    expect(prompt).not.toContain("wind down");
    expect(prompt).not.toContain("nearing its end");
  });

});

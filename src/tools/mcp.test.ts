import { describe, it, expect } from "vitest";
import { BotConfigSchema } from "../config/schema";

describe("mcpServers config", () => {
  const baseBotConfig = {
    botId: "bot1",
    name: "Test Bot",
    ownerId: "owner1",
    soul: "",
    agents: "",
    user: "",
    tools: "",
    identity: "",
    provider: "openai" as const,
    model: "gpt-4o",
  };

  it("defaults mcpServers to empty object", () => {
    const config = BotConfigSchema.parse(baseBotConfig);
    expect(config.mcpServers).toEqual({});
  });

  it("accepts mcpServers with url and headers", () => {
    const config = BotConfigSchema.parse({
      ...baseBotConfig,
      mcpServers: {
        weather: {
          url: "https://weather.example.com/mcp",
          headers: { Authorization: "Bearer token123" },
        },
      },
    });
    expect(config.mcpServers.weather).toEqual({
      url: "https://weather.example.com/mcp",
      headers: { Authorization: "Bearer token123" },
    });
  });

  it("defaults headers to empty object when omitted", () => {
    const config = BotConfigSchema.parse({
      ...baseBotConfig,
      mcpServers: {
        tools: { url: "https://tools.example.com/mcp" },
      },
    });
    expect(config.mcpServers.tools.headers).toEqual({});
  });

  it("accepts multiple MCP servers", () => {
    const config = BotConfigSchema.parse({
      ...baseBotConfig,
      mcpServers: {
        weather: { url: "https://weather.example.com/mcp" },
        search: { url: "https://search.example.com/mcp", headers: { "X-Api-Key": "key" } },
      },
    });
    expect(Object.keys(config.mcpServers)).toHaveLength(2);
  });

  it("rejects mcpServers entry without url", () => {
    expect(() =>
      BotConfigSchema.parse({
        ...baseBotConfig,
        mcpServers: { bad: { headers: {} } },
      })
    ).toThrow();
  });
});

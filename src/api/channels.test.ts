import { describe, it, expect, vi, beforeEach } from "vitest";
import { handleBindChannel, handleUnbindChannel } from "./channels";
import type { Env, BotConfig } from "../config/schema";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// -- Mock configDb module --

vi.mock("../db/config", () => ({
  getBot: vi.fn(),
  upsertBot: vi.fn(),
  deleteTokenMapping: vi.fn(),
  upsertTokenMapping: vi.fn(),
}));

import * as configDb from "../db/config";

beforeEach(() => {
  vi.clearAllMocks();
});

// -- Mock Discord Gateway DO --

function createMockDiscordGateway() {
  const configureFn = vi.fn(async () => {});
  const shutdownFn = vi.fn(async () => {});
  const stub = { configure: configureFn, shutdown: shutdownFn } as any;
  const ns = {
    idFromName: vi.fn(() => "mock-do-id"),
    get: vi.fn(() => stub),
  } as unknown as Env["DISCORD_GATEWAY"];
  return { ns, configureFn, shutdownFn };
}

// -- Helpers --

const OWNER_ID = "test-owner";

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DISCORD_GATEWAY: createMockDiscordGateway().ns,
    WEBHOOK_SECRET: "test-secret",
    D1_DB: {} as D1Database,
    ...overrides,
  } as Env;
}

function makeBotConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  return {
    botId: "bot-1",
    ownerId: OWNER_ID,
    name: "TestBot",
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

function jsonRequest(method: string, body?: unknown): Request {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }
  return new Request("https://example.com/api/bots/bot-1/channels/slack", init);
}

// -- handleBindChannel --

describe("handleBindChannel", () => {
  it("returns 404 when bot does not exist", async () => {
    vi.mocked(configDb.getBot).mockResolvedValueOnce(null);
    const env = makeEnv();
    const res = await handleBindChannel(
      jsonRequest("POST", { token: "tok" }),
      env,
      { ownerId: OWNER_ID, botId: "nope", channel: "slack" }
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 for invalid JSON", async () => {
    vi.mocked(configDb.getBot).mockResolvedValueOnce(makeBotConfig());
    const env = makeEnv();
    const req = new Request("https://example.com/api/bots/bot-1/channels/slack", {
      method: "POST",
      body: "not json",
    });
    const res = await handleBindChannel(req, env, { ownerId: OWNER_ID, botId: "bot-1", channel: "slack" });
    expect(res.status).toBe(400);
  });

  it("returns 400 for missing token", async () => {
    vi.mocked(configDb.getBot).mockResolvedValueOnce(makeBotConfig());
    const env = makeEnv();
    const res = await handleBindChannel(
      jsonRequest("POST", {}),
      env,
      { ownerId: OWNER_ID, botId: "bot-1", channel: "slack" }
    );
    expect(res.status).toBe(400);
  });

  it("binds a Slack channel", async () => {
    const bot = makeBotConfig();
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    vi.mocked(configDb.upsertTokenMapping).mockResolvedValueOnce(undefined);
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    const env = makeEnv();

    const res = await handleBindChannel(
      jsonRequest("POST", { token: "xoxb-slack" }),
      env,
      { ownerId: OWNER_ID, botId: "bot-1", channel: "slack" }
    );
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.status).toBe("ok");
    expect(data.webhookUrl).toContain("/webhook/slack/xoxb-slack");

    // Token mapping written to D1
    expect(configDb.upsertTokenMapping).toHaveBeenCalledWith(
      env.D1_DB, "slack", "xoxb-slack",
      { ownerId: OWNER_ID, botId: "bot-1" }
    );

    // Bot config updated in D1
    expect(configDb.upsertBot).toHaveBeenCalledOnce();
    const updatedBot = vi.mocked(configDb.upsertBot).mock.calls[0][1];
    expect(updatedBot.channels.slack?.token).toBe("xoxb-slack");
  });

  it("binds a Telegram channel and calls setWebhook", async () => {
    vi.mocked(configDb.getBot).mockResolvedValueOnce(makeBotConfig());
    vi.mocked(configDb.upsertTokenMapping).mockResolvedValueOnce(undefined);
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    const env = makeEnv();
    // setWebhook response
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: true }),
    });
    // getMe response (bot identity fetch)
    mockFetch.mockResolvedValueOnce({
      json: async () => ({ ok: true, result: { username: "my_bot" } }),
    });

    const res = await handleBindChannel(
      jsonRequest("POST", { token: "123:ABC" }),
      env,
      { ownerId: OWNER_ID, botId: "bot-1", channel: "telegram" }
    );
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.webhookUrl).toContain("/webhook/telegram/123:ABC");
    expect(data.telegram).toEqual({ ok: true });

    // setWebhook + getMe called
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [url] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bot123:ABC/setWebhook");
    const [getMeUrl] = mockFetch.mock.calls[1];
    expect(getMeUrl).toBe("https://api.telegram.org/bot123:ABC/getMe");

    // channelUsername saved
    const updatedBot = vi.mocked(configDb.upsertBot).mock.calls[0][1];
    expect(updatedBot.channels.telegram?.channelUsername).toBe("@my_bot");
  });

  it("binds a Discord channel and calls gateway.configure", async () => {
    const { ns: discordNs, configureFn } = createMockDiscordGateway();
    vi.mocked(configDb.getBot).mockResolvedValueOnce(makeBotConfig());
    vi.mocked(configDb.upsertTokenMapping).mockResolvedValueOnce(undefined);
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    const env = makeEnv({ DISCORD_GATEWAY: discordNs });

    const res = await handleBindChannel(
      jsonRequest("POST", { token: "dc-tok" }),
      env,
      { ownerId: OWNER_ID, botId: "bot-1", channel: "discord" }
    );
    expect(res.status).toBe(200);
    expect(configureFn).toHaveBeenCalledWith("dc-tok", OWNER_ID, { botId: "bot-1" });
  });

  it("cleans up old token when rebinding a channel", async () => {
    const bot = makeBotConfig({
      channels: { slack: { token: "old-tok" } },
    });
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    vi.mocked(configDb.deleteTokenMapping).mockResolvedValueOnce(undefined);
    vi.mocked(configDb.upsertTokenMapping).mockResolvedValueOnce(undefined);
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    const env = makeEnv();

    const res = await handleBindChannel(
      jsonRequest("POST", { token: "new-tok" }),
      env,
      { ownerId: OWNER_ID, botId: "bot-1", channel: "slack" }
    );
    expect(res.status).toBe(200);

    // Old token mapping deleted via D1
    expect(configDb.deleteTokenMapping).toHaveBeenCalledWith(env.D1_DB, "slack", "old-tok");

    // New token mapping written via D1
    expect(configDb.upsertTokenMapping).toHaveBeenCalledWith(
      env.D1_DB, "slack", "new-tok",
      { ownerId: OWNER_ID, botId: "bot-1" }
    );
  });

  it("overwrites existing token mapping when binding a bot channel", async () => {
    vi.mocked(configDb.getBot).mockResolvedValueOnce(makeBotConfig());
    vi.mocked(configDb.upsertTokenMapping).mockResolvedValueOnce(undefined);
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    const env = makeEnv();

    const res = await handleBindChannel(
      jsonRequest("POST", { token: "shared-tok" }),
      env,
      { ownerId: OWNER_ID, botId: "bot-1", channel: "slack" }
    );
    expect(res.status).toBe(200);

    // Token mapping should be upserted (ON CONFLICT handles overwrite)
    expect(configDb.upsertTokenMapping).toHaveBeenCalledWith(
      env.D1_DB, "slack", "shared-tok",
      { ownerId: OWNER_ID, botId: "bot-1" }
    );
  });
});

// -- handleUnbindChannel --

describe("handleUnbindChannel", () => {
  it("returns 404 when bot does not exist", async () => {
    vi.mocked(configDb.getBot).mockResolvedValueOnce(null);
    const env = makeEnv();
    const res = await handleUnbindChannel(
      jsonRequest("DELETE"),
      env,
      { ownerId: OWNER_ID, botId: "nope", channel: "slack" }
    );
    expect(res.status).toBe(404);
  });

  it("returns 400 when channel is not bound", async () => {
    vi.mocked(configDb.getBot).mockResolvedValueOnce(makeBotConfig());
    const env = makeEnv();
    const res = await handleUnbindChannel(
      jsonRequest("DELETE"),
      env,
      { ownerId: OWNER_ID, botId: "bot-1", channel: "slack" }
    );
    expect(res.status).toBe(400);
  });

  it("unbinds a Slack channel", async () => {
    const bot = makeBotConfig({ channels: { slack: { token: "sl-tok" } } });
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    vi.mocked(configDb.deleteTokenMapping).mockResolvedValueOnce(undefined);
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    const env = makeEnv();

    const res = await handleUnbindChannel(
      jsonRequest("DELETE"),
      env,
      { ownerId: OWNER_ID, botId: "bot-1", channel: "slack" }
    );
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.unbound).toBe(true);

    // Token mapping deleted via D1
    expect(configDb.deleteTokenMapping).toHaveBeenCalledWith(env.D1_DB, "slack", "sl-tok");

    // Channel removed from bot config via D1
    expect(configDb.upsertBot).toHaveBeenCalledOnce();
    const updatedBot = vi.mocked(configDb.upsertBot).mock.calls[0][1];
    expect(updatedBot.channels.slack).toBeUndefined();
  });

  it("deletes token mapping when unbinding bot channel", async () => {
    const bot = makeBotConfig({ channels: { slack: { token: "shared-tok" } } });
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    vi.mocked(configDb.deleteTokenMapping).mockResolvedValueOnce(undefined);
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    const env = makeEnv();

    const res = await handleUnbindChannel(
      jsonRequest("DELETE"),
      env,
      { ownerId: OWNER_ID, botId: "bot-1", channel: "slack" }
    );
    expect(res.status).toBe(200);

    // Token mapping deleted via D1
    expect(configDb.deleteTokenMapping).toHaveBeenCalledWith(env.D1_DB, "slack", "shared-tok");
  });

  it("calls Discord gateway.shutdown() on unbind", async () => {
    const { ns: discordNs, shutdownFn } = createMockDiscordGateway();
    const bot = makeBotConfig({ channels: { discord: { token: "dc-tok" } } });
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    vi.mocked(configDb.deleteTokenMapping).mockResolvedValueOnce(undefined);
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    const env = makeEnv({ DISCORD_GATEWAY: discordNs });

    const res = await handleUnbindChannel(
      jsonRequest("DELETE"),
      env,
      { ownerId: OWNER_ID, botId: "bot-1", channel: "discord" }
    );
    expect(res.status).toBe(200);
    expect(shutdownFn).toHaveBeenCalledOnce();
  });

  it("calls Telegram deleteWebhook on unbind", async () => {
    const bot = makeBotConfig({ channels: { telegram: { token: "tg-tok" } } });
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    vi.mocked(configDb.deleteTokenMapping).mockResolvedValueOnce(undefined);
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);
    const env = makeEnv();
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    const res = await handleUnbindChannel(
      jsonRequest("DELETE"),
      env,
      { ownerId: OWNER_ID, botId: "bot-1", channel: "telegram" }
    );
    expect(res.status).toBe(200);
    expect(mockFetch).toHaveBeenCalledWith(
      "https://api.telegram.org/bottg-tok/deleteWebhook"
    );
  });

  it("returns warnings when cleanup fails", async () => {
    const bot = makeBotConfig({ channels: { discord: { token: "dc-tok" } } });
    vi.mocked(configDb.getBot).mockResolvedValueOnce(bot);
    vi.mocked(configDb.deleteTokenMapping).mockResolvedValueOnce(undefined);
    vi.mocked(configDb.upsertBot).mockResolvedValueOnce(undefined);

    // Make Discord gateway throw
    const badNs = {
      idFromName: vi.fn(() => "id"),
      get: vi.fn(() => ({
        shutdown: vi.fn(async () => { throw new Error("DO down"); }),
      })),
    } as unknown as Env["DISCORD_GATEWAY"];
    const env = makeEnv({ DISCORD_GATEWAY: badNs });

    const res = await handleUnbindChannel(
      jsonRequest("DELETE"),
      env,
      { ownerId: OWNER_ID, botId: "bot-1", channel: "discord" }
    );
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.unbound).toBe(true);
    expect(data.warnings).toBeDefined();
    expect(data.warnings[0]).toContain("discord");
  });
});

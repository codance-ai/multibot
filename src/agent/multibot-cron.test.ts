import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../utils/logger";
import { executeCronJob, type CronDeps } from "./multibot-cron";
import type { CronJobPayload } from "../cron/types";

const mocked = vi.hoisted(() => ({
  createModel: vi.fn(() => ({})),
  runAgentLoop: vi.fn(),
  resolveAndNormalizeReply: vi.fn(),
  getSkillSecretsForBot: vi.fn(),
  persistCronReplyToGroupSession: vi.fn(),
  ensureSessionExists: vi.fn(),
  persistUserMessage: vi.fn(),
  persistMessages: vi.fn(),
}));

vi.mock("../providers/gateway", () => ({
  createModel: mocked.createModel,
}));

vi.mock("./loop", () => ({
  runAgentLoop: mocked.runAgentLoop,
}));

vi.mock("./multibot-image", () => ({
  resolveAndNormalizeReply: mocked.resolveAndNormalizeReply,
}));

vi.mock("../db/config", () => ({
  getSkillSecretsForBot: mocked.getSkillSecretsForBot,
  findAllGroupsForBot: vi.fn(),
}));

vi.mock("./cron-group-persist", () => ({
  persistCronReplyToGroupSession: mocked.persistCronReplyToGroupSession,
}));

vi.mock("../db/d1", () => ({
  ensureSessionExists: mocked.ensureSessionExists,
  persistUserMessage: mocked.persistUserMessage,
  persistMessages: mocked.persistMessages,
  getOrCreateSession: vi.fn(),
}));

function makePayload(): CronJobPayload {
  return {
    message: "Post the scheduled update",
    channel: "telegram",
    chatId: "chat-1",
    channelToken: "payload-token",
    botId: "bot-1",
    ownerId: "owner-1",
    deleteAfterRun: false,
    scheduleId: "schedule-1",
  };
}

function makeDeps(
  voiceMode: "off" | "always" | "mirror",
  overrides: Partial<CronDeps> = {},
): CronDeps {
  const botConfig = {
    ownerId: "owner-1",
    botId: "bot-1",
    name: "Scheduler",
    soul: "Helpful",
    maxIterations: 3,
    contextWindow: 4000,
    voiceMode,
    ttsProvider: "fish",
    ttsVoice: "voice-1",
    ttsModel: "s2-pro",
    channels: {
      telegram: {
        token: "resolved-token",
      },
    },
    enabledSkills: [],
  } as any;

  return {
    env: {
      D1_DB: {} as D1Database,
      LOG_BUCKET: {} as R2Bucket,
      BASE_URL: "https://example.test",
      WEBHOOK_SECRET: "secret",
    } as any,
    db: {} as D1Database,
    loadBotConfigAndKeys: vi.fn().mockResolvedValue({
      botConfig,
      userKeys: { fish: "fish-key" },
    }),
    getSchedules: vi.fn().mockReturnValue([]),
    cancelSchedule: vi.fn().mockResolvedValue(false),
    schedule: vi.fn().mockResolvedValue({ id: "next-schedule" }),
    buildAgentTools: vi.fn().mockResolvedValue({
      tools: {},
      sandboxClient: {} as any,
      botConfig,
    }),
    buildPromptAndHistory: vi.fn().mockResolvedValue({
      systemPrompt: "System prompt",
      conversationHistory: [],
    }),
    getSandboxClient: vi.fn(),
    buildLocalCronScheduler: vi.fn(),
    buildRemoteCronScheduler: vi.fn(),
    ensureMcpConnected: vi.fn().mockResolvedValue(undefined),
    getMcpTools: vi.fn().mockReturnValue({}),
    sendChannelMessage: vi.fn().mockResolvedValue(undefined),
    sendChannelAudio: vi.fn().mockResolvedValue({ captionSent: true }),
    startTypingLoop: vi.fn(),
    dispatchGroupOrchestrator: vi.fn(),
    ...overrides,
  };
}

describe("executeCronJob voice delivery", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mocked.createModel.mockReturnValue({});
    mocked.getSkillSecretsForBot.mockResolvedValue({ flat: {}, perSkill: {} });
    mocked.persistCronReplyToGroupSession.mockResolvedValue([]);
    mocked.ensureSessionExists.mockResolvedValue(undefined);
    mocked.persistUserMessage.mockResolvedValue(undefined);
    mocked.persistMessages.mockResolvedValue(undefined);
    mocked.runAgentLoop.mockResolvedValue({
      reply: "Raw scheduled reply",
      toolResults: [],
      newMessages: [],
      model: "test-model",
      iterations: 1,
      inputTokens: 10,
      outputTokens: 6,
      skillCalls: [],
    });
    mocked.resolveAndNormalizeReply.mockResolvedValue({
      normalizedText: "Scheduled hello",
      attachments: [],
      media: [],
    });
  });

  it("sends audio for cron replies when voiceMode is always", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new ArrayBuffer(8),
    }));
    const deps = makeDeps("always");
    const log = createLogger({ botId: "bot-1", channel: "telegram", chatId: "chat-1" });
    const flushSpy = vi.spyOn(log, "flush").mockResolvedValue(undefined);

    await executeCronJob(deps, makePayload(), log);

    expect(deps.sendChannelAudio).toHaveBeenCalledOnce();
    expect(deps.sendChannelAudio).toHaveBeenCalledWith(
      "telegram",
      "resolved-token",
      "chat-1",
      expect.any(ArrayBuffer),
      expect.objectContaining({ caption: "Scheduled hello" }),
    );
    expect(deps.sendChannelMessage).not.toHaveBeenCalled();
    expect(flushSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ voiceSent: true, reply: "Scheduled hello" }),
      expect.anything(),
    );
  });

  it("does not send audio for cron replies when voiceMode is mirror", async () => {
    const deps = makeDeps("mirror");
    const log = createLogger({ botId: "bot-1", channel: "telegram", chatId: "chat-1" });
    const flushSpy = vi.spyOn(log, "flush").mockResolvedValue(undefined);

    await executeCronJob(deps, makePayload(), log);

    expect(deps.sendChannelAudio).not.toHaveBeenCalled();
    expect(deps.sendChannelMessage).toHaveBeenCalledOnce();
    expect(deps.sendChannelMessage).toHaveBeenCalledWith(
      "telegram",
      "resolved-token",
      "chat-1",
      "Scheduled hello",
      {},
    );
    expect(flushSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ voiceSent: false, reply: "Scheduled hello" }),
      expect.anything(),
    );
  });
});

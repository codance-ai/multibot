import { describe, it, expect, vi } from "vitest";
import { persistCronReplyToGroupSession } from "./cron-group-persist";

describe("persistCronReplyToGroupSession", () => {
  const makeDb = () => ({}) as D1Database;

  it("persists reply to group session when chatId matches a group", async () => {
    const findAllGroupsForBot = vi.fn().mockResolvedValue([
      { groupId: "g1", name: "Team", botIds: ["bot-a", "bot-b"], channel: "telegram", chatId: "-100123" },
    ]);
    const getOrCreateSession = vi.fn().mockResolvedValue("group-session-1");
    const persistMessages = vi.fn().mockResolvedValue(undefined);

    const result = await persistCronReplyToGroupSession({
      db: makeDb(),
      ownerId: "owner1",
      botId: "bot-a",
      channel: "telegram",
      chatId: "-100123",
      reply: "Good morning!",
      requestId: "req-123",
      findAllGroupsForBot,
      getOrCreateSession,
      persistMessages,
    });

    expect(getOrCreateSession).toHaveBeenCalledWith(expect.anything(), {
      channel: "telegram",
      chatId: "-100123",
      groupId: "g1",
    });
    expect(persistMessages).toHaveBeenCalledWith(
      expect.anything(),
      "group-session-1",
      [{ role: "assistant", content: "Good morning!", botId: "bot-a", attachments: null, requestId: "req-123" }],
    );
    expect(result).toEqual([{ groupId: "g1", chatId: "-100123" }]);
  });

  it("does NOT persist when chatId does not match any group", async () => {
    const findAllGroupsForBot = vi.fn().mockResolvedValue([
      { groupId: "g1", name: "Team", botIds: ["bot-a"], channel: "telegram", chatId: "-100999" },
    ]);
    const persistMessages = vi.fn();

    const result = await persistCronReplyToGroupSession({
      db: makeDb(),
      ownerId: "owner1",
      botId: "bot-a",
      channel: "telegram",
      chatId: "799958020",
      reply: "Hello",
      findAllGroupsForBot,
      getOrCreateSession: vi.fn(),
      persistMessages,
    });

    expect(persistMessages).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("does NOT persist when bot has no groups", async () => {
    const findAllGroupsForBot = vi.fn().mockResolvedValue([]);
    const persistMessages = vi.fn();

    const result = await persistCronReplyToGroupSession({
      db: makeDb(),
      ownerId: "owner1",
      botId: "bot-a",
      channel: "telegram",
      chatId: "-100123",
      reply: "Hello",
      findAllGroupsForBot,
      getOrCreateSession: vi.fn(),
      persistMessages,
    });

    expect(persistMessages).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });

  it("persists only to matching group when bot has multiple groups", async () => {
    const findAllGroupsForBot = vi.fn().mockResolvedValue([
      { groupId: "g1", name: "Team A", botIds: ["bot-a"], channel: "telegram", chatId: "-100123" },
      { groupId: "g2", name: "Team B", botIds: ["bot-a"], channel: "telegram", chatId: "-100456" },
    ]);
    const getOrCreateSession = vi.fn().mockResolvedValue("gs-1");
    const persistMessages = vi.fn().mockResolvedValue(undefined);

    const result = await persistCronReplyToGroupSession({
      db: makeDb(),
      ownerId: "owner1",
      botId: "bot-a",
      channel: "telegram",
      chatId: "-100123",
      reply: "Hi",
      findAllGroupsForBot,
      getOrCreateSession,
      persistMessages,
    });

    expect(persistMessages).toHaveBeenCalledTimes(1);
    expect(getOrCreateSession).toHaveBeenCalledWith(expect.anything(), {
      channel: "telegram",
      chatId: "-100123",
      groupId: "g1",
    });
    expect(result).toEqual([{ groupId: "g1", chatId: "-100123" }]);
  });

  it("persists attachments to group session", async () => {
    const attachmentsJson = '[{"r2Key":"media/bot-a/123.png","mediaType":"image/png"}]';
    const persistedMessages: Array<{ role: string; content: string | null; botId?: string; attachments?: string | null; requestId?: string }> = [];
    const findAllGroupsForBot = vi.fn().mockResolvedValue([
      { groupId: "g1", name: "Team", botIds: ["bot-a"], channel: "telegram", chatId: "-100123" },
    ]);
    const getOrCreateSession = vi.fn().mockResolvedValue("group-session-1");

    const result = await persistCronReplyToGroupSession({
      db: makeDb(),
      ownerId: "owner1",
      botId: "bot-a",
      channel: "telegram",
      chatId: "-100123",
      reply: "Here is the image",
      attachments: attachmentsJson,
      findAllGroupsForBot,
      getOrCreateSession,
      persistMessages: async (_db: D1Database, _sid: string, msgs) => { persistedMessages.push(...msgs); },
    });

    expect(persistedMessages).toHaveLength(1);
    expect(persistedMessages[0].attachments).toBe(attachmentsJson);
    expect(result).toEqual([{ groupId: "g1", chatId: "-100123" }]);
  });

  it("skips persist when reply is empty", async () => {
    const findAllGroupsForBot = vi.fn().mockResolvedValue([
      { groupId: "g1", name: "Team", botIds: ["bot-a"], channel: "telegram", chatId: "-100123" },
    ]);
    const persistMessages = vi.fn();

    const result = await persistCronReplyToGroupSession({
      db: makeDb(),
      ownerId: "owner1",
      botId: "bot-a",
      channel: "telegram",
      chatId: "-100123",
      reply: "",
      findAllGroupsForBot,
      getOrCreateSession: vi.fn(),
      persistMessages,
    });

    expect(persistMessages).not.toHaveBeenCalled();
    expect(result).toEqual([]);
  });
});

import { describe, it, expect, vi } from "vitest";
import { createGroupMessageTools } from "./group-message";
import type { GroupMessageContext, GroupMessagePersister } from "./group-message";
import type { ChannelSender } from "./message";
import type { GroupConfig } from "../config/schema";

const execOpts = { toolCallId: "tc-1", messages: [] as never[], abortSignal: new AbortController().signal };

function makeGroup(overrides: Partial<GroupConfig> = {}): GroupConfig {
  return {
    groupId: "g1",
    name: "Work Team",
    ownerId: "owner1",
    botIds: ["bot-a", "bot-b"],
    note: "User",
    orchestratorProvider: "anthropic",
    orchestratorModel: "claude-sonnet-4-6",
    channel: "telegram",
    chatId: "-100123",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<GroupMessageContext> = {}): GroupMessageContext {
  return {
    channel: "telegram",
    channelToken: "tok-abc",
    botId: "bot-a",
    botName: "TestBot",
    groups: [makeGroup()],
    ...overrides,
  };
}

describe("createGroupMessageTools", () => {
  it("sends message to single group (auto-select)", async () => {
    const sender = vi.fn<ChannelSender>().mockResolvedValue(undefined);
    const persister = vi.fn<GroupMessagePersister>().mockResolvedValue(undefined);
    const ctx = makeCtx();
    const tools = createGroupMessageTools(sender, persister, ctx);

    const result = await tools.send_to_group.execute!(
      { message: "Hello group!" },
      execOpts,
    );

    expect(result).toBe('Message sent to group "Work Team".');
    expect(sender).toHaveBeenCalledWith("telegram", "tok-abc", "-100123", "Hello group!");
    expect(persister).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "g1" }),
      "telegram", "-100123", "bot-a", "Hello group!",
    );
  });

  it("sends message to named group when multiple groups exist", async () => {
    const sender = vi.fn<ChannelSender>().mockResolvedValue(undefined);
    const persister = vi.fn<GroupMessagePersister>().mockResolvedValue(undefined);
    const g1 = makeGroup({ groupId: "g1", name: "Work Team" });
    const g2 = makeGroup({ groupId: "g2", name: "Family", botIds: ["bot-a", "bot-c"], chatId: "-100456" });
    const ctx = makeCtx({
      groups: [g1, g2],
    });
    const tools = createGroupMessageTools(sender, persister, ctx);

    const result = await tools.send_to_group.execute!(
      { message: "Hi family!", group_name: "Family" },
      execOpts,
    );

    expect(result).toBe('Message sent to group "Family".');
  });

  it("matches group name case-insensitively", async () => {
    const sender = vi.fn<ChannelSender>().mockResolvedValue(undefined);
    const persister = vi.fn<GroupMessagePersister>().mockResolvedValue(undefined);
    const ctx = makeCtx();
    const tools = createGroupMessageTools(sender, persister, ctx);

    const result = await tools.send_to_group.execute!(
      { message: "test", group_name: "work team" },
      execOpts,
    );

    expect(result).toBe('Message sent to group "Work Team".');
  });

  it("returns error when multiple groups and no group_name specified", async () => {
    const sender = vi.fn<ChannelSender>().mockResolvedValue(undefined);
    const persister = vi.fn<GroupMessagePersister>().mockResolvedValue(undefined);
    const g1 = makeGroup({ groupId: "g1", name: "Work Team" });
    const g2 = makeGroup({ groupId: "g2", name: "Family" });
    const ctx = makeCtx({ groups: [g1, g2] });
    const tools = createGroupMessageTools(sender, persister, ctx);

    const result = await tools.send_to_group.execute!(
      { message: "test" },
      execOpts,
    );

    expect(result).toContain("multiple groups");
    expect(sender).not.toHaveBeenCalled();
    expect(persister).not.toHaveBeenCalled();
  });

  it("returns error when group_name not found", async () => {
    const sender = vi.fn<ChannelSender>().mockResolvedValue(undefined);
    const persister = vi.fn<GroupMessagePersister>().mockResolvedValue(undefined);
    const ctx = makeCtx();
    const tools = createGroupMessageTools(sender, persister, ctx);

    const result = await tools.send_to_group.execute!(
      { message: "test", group_name: "Nonexistent" },
      execOpts,
    );

    expect(result).toContain('Group "Nonexistent" not found');
    expect(sender).not.toHaveBeenCalled();
  });

  it("returns error when bot has no groups", async () => {
    const sender = vi.fn<ChannelSender>().mockResolvedValue(undefined);
    const persister = vi.fn<GroupMessagePersister>().mockResolvedValue(undefined);
    const ctx = makeCtx({ groups: [] });
    const tools = createGroupMessageTools(sender, persister, ctx);

    const result = await tools.send_to_group.execute!(
      { message: "test" },
      execOpts,
    );

    expect(result).toContain("don't belong to any groups");
    expect(sender).not.toHaveBeenCalled();
  });

  it("returns error when channel does not match group", async () => {
    const sender = vi.fn<ChannelSender>().mockResolvedValue(undefined);
    const persister = vi.fn<GroupMessagePersister>().mockResolvedValue(undefined);
    const ctx = makeCtx({
      groups: [makeGroup({ channel: "discord", chatId: "-100123" })],
    });
    const tools = createGroupMessageTools(sender, persister, ctx);

    const result = await tools.send_to_group.execute!(
      { message: "test" },
      execOpts,
    );

    expect(result).toContain("No chat found");
    expect(result).toContain("at least one message");
    expect(sender).not.toHaveBeenCalled();
  });

  it("returns error when channel matches but chatId is undefined", async () => {
    const sender = vi.fn<ChannelSender>().mockResolvedValue(undefined);
    const persister = vi.fn<GroupMessagePersister>().mockResolvedValue(undefined);
    const ctx = makeCtx({
      groups: [makeGroup({ channel: "telegram", chatId: undefined })],
    });
    const tools = createGroupMessageTools(sender, persister, ctx);

    const result = await tools.send_to_group.execute!(
      { message: "test" },
      execOpts,
    );

    expect(result).toContain("No chat found");
    expect(sender).not.toHaveBeenCalled();
  });

  it("calls orchestrator dispatcher after send and persist", async () => {
    const sender = vi.fn<ChannelSender>().mockResolvedValue(undefined);
    const persister = vi.fn<GroupMessagePersister>().mockResolvedValue(undefined);
    const dispatcher = vi.fn();
    const ctx = makeCtx({ botName: "Mimi", dispatchToOrchestrator: dispatcher });
    const tools = createGroupMessageTools(sender, persister, ctx);

    await tools.send_to_group.execute!(
      { message: "Hello group!" },
      execOpts,
    );

    expect(dispatcher).toHaveBeenCalledWith(
      expect.objectContaining({ groupId: "g1" }),
      "telegram", "-100123", "bot-a", "Mimi", "Hello group!",
    );
    expect(sender).toHaveBeenCalled();
    expect(persister).toHaveBeenCalled();
  });

  it("works without dispatcher (optional)", async () => {
    const sender = vi.fn<ChannelSender>().mockResolvedValue(undefined);
    const persister = vi.fn<GroupMessagePersister>().mockResolvedValue(undefined);
    const ctx = makeCtx(); // no dispatcher
    const tools = createGroupMessageTools(sender, persister, ctx);

    const result = await tools.send_to_group.execute!(
      { message: "Hello!" },
      execOpts,
    );

    expect(result).toBe('Message sent to group "Work Team".');
  });

  it("does not call dispatcher on error paths", async () => {
    const sender = vi.fn<ChannelSender>().mockResolvedValue(undefined);
    const persister = vi.fn<GroupMessagePersister>().mockResolvedValue(undefined);
    const dispatcher = vi.fn();
    const ctx = makeCtx({ groups: [], dispatchToOrchestrator: dispatcher });
    const tools = createGroupMessageTools(sender, persister, ctx);

    await tools.send_to_group.execute!(
      { message: "test" },
      execOpts,
    );

    expect(dispatcher).not.toHaveBeenCalled();
  });

  it("includes group names in tool description", () => {
    const g1 = makeGroup({ name: "Work Team" });
    const g2 = makeGroup({ name: "Family" });
    const ctx = makeCtx({ groups: [g1, g2] });
    const sender = vi.fn<ChannelSender>().mockResolvedValue(undefined);
    const persister = vi.fn<GroupMessagePersister>().mockResolvedValue(undefined);
    const tools = createGroupMessageTools(sender, persister, ctx);

    const desc = (tools.send_to_group as { description?: string }).description ?? "";
    expect(desc).toContain('"Work Team"');
    expect(desc).toContain('"Family"');
  });
});

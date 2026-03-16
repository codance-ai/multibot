import { describe, it, expect, vi } from "vitest";
import { createSubagentTools } from "./subagent";

function createMockStorage(): DurableObjectStorage {
  const store = new Map<string, any>();
  return {
    get: async (key: string) => store.get(key),
    put: async (key: string, value: any) => { store.set(key, structuredClone(value)); },
    delete: async (keyOrKeys: string | string[]) => {
      if (Array.isArray(keyOrKeys)) {
        let count = 0;
        for (const k of keyOrKeys) { if (store.delete(k)) count++; }
        return count;
      }
      return store.delete(keyOrKeys);
    },
    list: async (opts?: { prefix?: string }) => {
      const result = new Map<string, any>();
      for (const [key, value] of store) {
        if (!opts?.prefix || key.startsWith(opts.prefix)) {
          result.set(key, structuredClone(value));
        }
      }
      return result;
    },
  } as any as DurableObjectStorage;
}

function makeParams(overrides: Record<string, any> = {}) {
  return {
    storage: createMockStorage(),
    db: {} as D1Database,
    spawnDepth: 0,
    config: undefined,
    parentSessionId: "session-1",
    ownerId: "owner-1",
    botId: "bot-1",
    channel: "telegram",
    chatId: "chat-1",
    channelToken: "tok-1",
    userId: "user-1",
    userName: "User",
    createChildSession: vi.fn(async () => "child-session-1"),
    startSubagent: vi.fn(),
    ...overrides,
  };
}

describe("createSubagentTools", () => {
  it("returns spawn_subagent tool at depth 0", () => {
    const tools = createSubagentTools(makeParams());
    expect(tools.spawn_subagent).toBeDefined();
  });

  it("returns empty tool set at max depth", () => {
    const tools = createSubagentTools(makeParams({ spawnDepth: 3 }));
    expect(tools.spawn_subagent).toBeUndefined();
    expect(Object.keys(tools)).toHaveLength(0);
  });

  it("returns empty tool set when depth equals custom max", () => {
    const tools = createSubagentTools(makeParams({
      spawnDepth: 2,
      config: { maxSpawnDepth: 2 },
    }));
    expect(Object.keys(tools)).toHaveLength(0);
  });

  it("returns tool when depth is below custom max", () => {
    const tools = createSubagentTools(makeParams({
      spawnDepth: 1,
      config: { maxSpawnDepth: 5 },
    }));
    expect(tools.spawn_subagent).toBeDefined();
  });
});

describe("spawn_subagent execution", () => {
  it("spawns a sub-agent successfully", async () => {
    const params = makeParams();
    const tools = createSubagentTools(params);
    const result = await (tools.spawn_subagent as any).execute({
      task: "Research topic X",
      label: "research",
    });

    const parsed = JSON.parse(result);
    expect(parsed.status).toBe("spawned");
    expect(parsed.runId).toBeTruthy();
    expect(parsed.label).toBe("research");

    // Child session uses a unique chatId to avoid polluting parent session lookup
    expect(params.createChildSession).toHaveBeenCalledWith("telegram", expect.stringContaining("subagent:"), "bot-1");
    expect(params.startSubagent).toHaveBeenCalledTimes(1);

    const run = params.startSubagent.mock.calls[0][0];
    expect(run.task).toBe("Research topic X");
    expect(run.label).toBe("research");
    expect(run.spawnDepth).toBe(1);
    expect(run.status).toBe("running");
  });

  it("rejects when max concurrent children reached", async () => {
    const params = makeParams({ config: { maxChildrenPerSession: 2 } });

    // Pre-populate 2 running sub-agents
    const { putSubagentRun } = await import("../agent/subagent-storage");
    await putSubagentRun(params.storage, {
      runId: "existing-1", label: "a", task: "t", ownerId: "o", parentSessionId: "session-1",
      childSessionId: "c1", spawnDepth: 1, status: "running", botId: "bot-1",
      channel: "telegram", chatId: "chat-1", channelToken: "tok", userId: "u",
      userName: "U", sessionEpoch: 0, createdAt: Date.now(),
    });
    await putSubagentRun(params.storage, {
      runId: "existing-2", label: "b", task: "t", ownerId: "o", parentSessionId: "session-1",
      childSessionId: "c2", spawnDepth: 1, status: "running", botId: "bot-1",
      channel: "telegram", chatId: "chat-1", channelToken: "tok", userId: "u",
      userName: "U", sessionEpoch: 0, createdAt: Date.now(),
    });

    const tools = createSubagentTools(params);
    const result = await (tools.spawn_subagent as any).execute({
      task: "Another task",
      label: "c",
    });

    expect(result).toContain("Error");
    expect(result).toContain("max concurrent");
    expect(params.startSubagent).not.toHaveBeenCalled();
  });
});

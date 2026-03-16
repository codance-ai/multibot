import { describe, it, expect } from "vitest";
import type { SubagentRun } from "./subagent-types";
import {
  getSubagentRun,
  putSubagentRun,
  deleteSubagentRun,
  listRunsByParentSession,
  countActiveChildren,
  claimCompletedRuns,
  deleteCompletedRuns,
  getSessionEpoch,
  bumpSessionEpoch,
  recoverOrphanedRuns,
} from "./subagent-storage";

/** Simple Map-based mock for DurableObjectStorage */
function createMockStorage(): DurableObjectStorage {
  const store = new Map<string, any>();
  return {
    get: async (key: string) => store.get(key),
    put: async (key: string, value: any) => { store.set(key, structuredClone(value)); },
    delete: async (keyOrKeys: string | string[]) => {
      if (Array.isArray(keyOrKeys)) {
        let count = 0;
        for (const k of keyOrKeys) {
          if (store.delete(k)) count++;
        }
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

function makeRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
  return {
    runId: "run-1",
    label: "test",
    task: "do something",
    ownerId: "owner-1",
    parentSessionId: "session-1",
    childSessionId: "child-1",
    spawnDepth: 1,
    status: "running",
    botId: "bot-1",
    channel: "telegram",
    chatId: "chat-1",
    channelToken: "tok-1",
    userId: "user-1",
    userName: "User",
    sessionEpoch: 0,
    createdAt: Date.now(),
    ...overrides,
  };
}

describe("subagent-storage", () => {
  describe("CRUD", () => {
    it("put and get a run", async () => {
      const storage = createMockStorage();
      const run = makeRun();
      await putSubagentRun(storage, run);
      const got = await getSubagentRun(storage, "run-1");
      expect(got).toEqual(run);
    });

    it("returns undefined for missing run", async () => {
      const storage = createMockStorage();
      expect(await getSubagentRun(storage, "nope")).toBeUndefined();
    });

    it("deletes a run", async () => {
      const storage = createMockStorage();
      await putSubagentRun(storage, makeRun());
      await deleteSubagentRun(storage, "run-1");
      expect(await getSubagentRun(storage, "run-1")).toBeUndefined();
    });
  });

  describe("listRunsByParentSession", () => {
    it("filters by parentSessionId", async () => {
      const storage = createMockStorage();
      await putSubagentRun(storage, makeRun({ runId: "r1", parentSessionId: "s1" }));
      await putSubagentRun(storage, makeRun({ runId: "r2", parentSessionId: "s2" }));
      await putSubagentRun(storage, makeRun({ runId: "r3", parentSessionId: "s1" }));

      const runs = await listRunsByParentSession(storage, "s1");
      expect(runs).toHaveLength(2);
      expect(runs.map(r => r.runId).sort()).toEqual(["r1", "r3"]);
    });
  });

  describe("countActiveChildren", () => {
    it("counts only running status", async () => {
      const storage = createMockStorage();
      await putSubagentRun(storage, makeRun({ runId: "r1", status: "running" }));
      await putSubagentRun(storage, makeRun({ runId: "r2", status: "completed" }));
      await putSubagentRun(storage, makeRun({ runId: "r3", status: "running" }));

      expect(await countActiveChildren(storage, "session-1")).toBe(2);
    });
  });

  describe("claimCompletedRuns", () => {
    it("claims completed runs but keeps them in storage until deleteCompletedRuns", async () => {
      const storage = createMockStorage();
      await putSubagentRun(storage, makeRun({ runId: "r1", status: "completed", sessionEpoch: 0 }));
      await putSubagentRun(storage, makeRun({ runId: "r2", status: "running", sessionEpoch: 0 }));
      await putSubagentRun(storage, makeRun({ runId: "r3", status: "error", sessionEpoch: 0 }));

      const claimed = await claimCompletedRuns(storage, "session-1", 0);
      expect(claimed).toHaveLength(2);
      expect(claimed.map(r => r.runId).sort()).toEqual(["r1", "r3"]);

      // Running run still present
      expect(await getSubagentRun(storage, "r2")).toBeDefined();
      // Claimed runs still in storage (not deleted yet)
      expect(await getSubagentRun(storage, "r1")).toBeDefined();
      expect(await getSubagentRun(storage, "r3")).toBeDefined();

      // Now delete after successful delivery
      await deleteCompletedRuns(storage, claimed);
      expect(await getSubagentRun(storage, "r1")).toBeUndefined();
      expect(await getSubagentRun(storage, "r3")).toBeUndefined();
    });

    it("drops stale epoch runs", async () => {
      const storage = createMockStorage();
      await putSubagentRun(storage, makeRun({ runId: "r1", status: "completed", sessionEpoch: 0 }));
      await putSubagentRun(storage, makeRun({ runId: "r2", status: "completed", sessionEpoch: 1 }));

      const claimed = await claimCompletedRuns(storage, "session-1", 1);
      expect(claimed).toHaveLength(1);
      expect(claimed[0].runId).toBe("r2");

      // Stale epoch run should also be deleted from storage
      expect(await getSubagentRun(storage, "r1")).toBeUndefined();
    });
  });

  describe("session epoch", () => {
    it("defaults to 0", async () => {
      const storage = createMockStorage();
      expect(await getSessionEpoch(storage, "s1")).toBe(0);
    });

    it("bumps epoch", async () => {
      const storage = createMockStorage();
      const next = await bumpSessionEpoch(storage, "s1");
      expect(next).toBe(1);
      expect(await getSessionEpoch(storage, "s1")).toBe(1);

      const next2 = await bumpSessionEpoch(storage, "s1");
      expect(next2).toBe(2);
    });
  });

  describe("recoverOrphanedRuns", () => {
    it("marks stale running runs as errors", async () => {
      const storage = createMockStorage();
      const old = makeRun({ runId: "r1", createdAt: Date.now() - 300_000 });
      const recent = makeRun({ runId: "r2", createdAt: Date.now() - 10_000 });
      const done = makeRun({ runId: "r3", status: "completed", createdAt: Date.now() - 300_000 });

      await putSubagentRun(storage, old);
      await putSubagentRun(storage, recent);
      await putSubagentRun(storage, done);

      const orphans = await recoverOrphanedRuns(storage, 200_000);
      expect(orphans).toHaveLength(1);
      expect(orphans[0].runId).toBe("r1");
      expect(orphans[0].status).toBe("error");
      expect(orphans[0].error).toContain("Orphaned");

      // Recent running run untouched
      const r2 = await getSubagentRun(storage, "r2");
      expect(r2?.status).toBe("running");

      // Completed run untouched
      const r3 = await getSubagentRun(storage, "r3");
      expect(r3?.status).toBe("completed");
    });
  });
});

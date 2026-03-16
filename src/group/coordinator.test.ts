import { describe, it, expect } from "vitest";
import { TurnSerializer, EpochTracker, tryFastDispatch, fallbackDispatch, applyContinueGuard, pickNextParentRequestId } from "./coordinator-utils";

describe("TurnSerializer", () => {
  it("serializes concurrent calls", async () => {
    const serializer = new TurnSerializer();
    const order: number[] = [];

    const task1 = serializer.enqueue(async () => {
      await new Promise((r) => setTimeout(r, 50));
      order.push(1);
    });
    const task2 = serializer.enqueue(async () => {
      order.push(2);
    });

    await Promise.all([task1, task2]);
    expect(order).toEqual([1, 2]);
  });

  it("continues after a failed task", async () => {
    const serializer = new TurnSerializer();
    const order: number[] = [];

    const task1 = serializer
      .enqueue(async () => {
        throw new Error("fail");
      })
      .catch(() => {
        order.push(-1);
      });

    const task2 = serializer.enqueue(async () => {
      order.push(2);
    });

    await Promise.all([task1, task2]);
    expect(order).toEqual([-1, 2]);
  });
});

describe("EpochTracker", () => {
  it("increments epoch on bump", () => {
    const tracker = new EpochTracker();
    expect(tracker.current()).toBe(0);
    tracker.bump();
    expect(tracker.current()).toBe(1);
    tracker.bump();
    expect(tracker.current()).toBe(2);
  });

  it("isStale returns true when epoch has changed", () => {
    const tracker = new EpochTracker();
    tracker.bump();
    const snapshot = tracker.current();
    expect(tracker.isStale(snapshot)).toBe(false);
    tracker.bump();
    expect(tracker.isStale(snapshot)).toBe(true);
  });
});

describe("tryFastDispatch", () => {
  const bots = [
    { name: "Alice", botId: "a1" },
    { name: "Bob", botId: "b1" },
    { name: "Charlie", botId: "c1" },
  ];

  it("dispatches mentioned bots directly", () => {
    expect(tryFastDispatch(bots, ["Alice"])).toEqual([["Alice"]]);
  });

  it("dispatches multiple mentioned bots in one wave", () => {
    expect(tryFastDispatch(bots, ["Alice", "Bob"])).toEqual([["Alice", "Bob"]]);
  });

  it("dispatches single bot group without mentions", () => {
    const singleBot = [{ name: "Alice", botId: "a1" }];
    expect(tryFastDispatch(singleBot, [])).toEqual([["Alice"]]);
  });

  it("returns null for multiple bots without mentions (needs LLM)", () => {
    expect(tryFastDispatch(bots, [])).toBeNull();
  });

  it("excludes sender bot from available bots", () => {
    // With sender excluded, 2 bots remain — still ambiguous
    expect(tryFastDispatch(bots, [], "a1")).toBeNull();
  });

  it("dispatches single remaining bot after sender exclusion", () => {
    const twoBots = [
      { name: "Alice", botId: "a1" },
      { name: "Bob", botId: "b1" },
    ];
    expect(tryFastDispatch(twoBots, [], "a1")).toEqual([["Bob"]]);
  });

  it("excludes sender from mentioned dispatch", () => {
    expect(tryFastDispatch(bots, ["Alice", "Bob"], "a1")).toEqual([["Bob"]]);
  });

  it("returns null when no bots available after sender exclusion", () => {
    const singleBot = [{ name: "Alice", botId: "a1" }];
    expect(tryFastDispatch(singleBot, [], "a1")).toBeNull();
  });

  it("filters out mentioned names not in available bots", () => {
    expect(tryFastDispatch(bots, ["NonExistent"])).toBeNull();
  });
});

describe("fallbackDispatch", () => {
  const bots = [
    { name: "Alice", botId: "a1" },
    { name: "Bob", botId: "b1" },
    { name: "Charlie", botId: "c1" },
  ];

  it("returns mentioned bots in wave 1 when LLM fails", () => {
    const result = fallbackDispatch(bots, ["Alice"], undefined);
    expect(result).toEqual([["Alice"]]);
  });

  it("returns all bots in single wave when no mentions and LLM fails", () => {
    const result = fallbackDispatch(bots, [], undefined);
    expect(result).toEqual([["Alice", "Bob", "Charlie"]]);
  });

  it("returns all bots when LLM returns empty respondents", () => {
    const result = fallbackDispatch(bots, [], []);
    expect(result).toEqual([["Alice", "Bob", "Charlie"]]);
  });

  it("passes through valid LLM result", () => {
    const llmResult = [["Alice"], ["Bob"]];
    const result = fallbackDispatch(bots, [], llmResult);
    expect(result).toEqual([["Alice"], ["Bob"]]);
  });

  it("excludes sender bot", () => {
    const result = fallbackDispatch(bots, [], undefined, "a1");
    expect(result).toEqual([["Bob", "Charlie"]]);
  });

  it("falls back when LLM returns only invalid names", () => {
    const result = fallbackDispatch(bots, [], [["NonExistent"]]);
    expect(result).toEqual([["Alice", "Bob", "Charlie"]]);
  });

  it("filters invalid names from LLM result but keeps valid ones", () => {
    const result = fallbackDispatch(bots, [], [["Alice", "NonExistent"], ["Bob"]]);
    expect(result).toEqual([["Alice"], ["Bob"]]);
  });
});

describe("applyContinueGuard", () => {
  const botNames = new Set(["Alice", "Bob", "Charlie"]);

  it("passes through when LLM says continue with valid respondents", () => {
    const result = applyContinueGuard({
      shouldContinue: true,
      respondents: ["Alice"],
    }, botNames);
    expect(result).toEqual({ shouldContinue: true, respondents: ["Alice"] });
  });

  it("passes through when LLM says stop with empty respondents", () => {
    const result = applyContinueGuard({
      shouldContinue: false,
      respondents: [],
    }, botNames);
    expect(result).toEqual({ shouldContinue: false, respondents: [] });
  });

  it("clears respondents when shouldContinue=false", () => {
    const result = applyContinueGuard({
      shouldContinue: false,
      respondents: ["Alice"],
    }, botNames);
    expect(result).toEqual({ shouldContinue: false, respondents: [] });
  });

  it("filters invalid bot names from respondents", () => {
    const result = applyContinueGuard({
      shouldContinue: true,
      respondents: ["Alice", "NonExistent"],
    }, botNames);
    expect(result).toEqual({ shouldContinue: true, respondents: ["Alice"] });
  });

  it("stops when shouldContinue=true but no valid respondents", () => {
    const result = applyContinueGuard({
      shouldContinue: true,
      respondents: ["NonExistent"],
    }, botNames);
    expect(result).toEqual({ shouldContinue: false, respondents: [] });
  });

  it("stops when shouldContinue=true but respondents is empty", () => {
    const result = applyContinueGuard({
      shouldContinue: true,
      respondents: [],
    }, botNames);
    expect(result).toEqual({ shouldContinue: false, respondents: [] });
  });

  it("resolves case-insensitive respondent names", () => {
    const result = applyContinueGuard({
      shouldContinue: true,
      respondents: ["alice"],
    }, botNames);
    expect(result).toEqual({ shouldContinue: true, respondents: ["Alice"] });
  });

  it("limits respondents to one in follow-up rounds", () => {
    const result = applyContinueGuard({
      shouldContinue: true,
      respondents: ["Alice", "Bob"],
    }, botNames);
    expect(result).toEqual({ shouldContinue: true, respondents: ["Alice"] });
  });

  it("deduplicates case variants resolving to same name", () => {
    const result = applyContinueGuard({
      shouldContinue: true,
      respondents: ["Alice", "alice", "ALICE"],
    }, botNames);
    expect(result).toEqual({ shouldContinue: true, respondents: ["Alice"] });
  });
});

describe("pickNextParentRequestId", () => {
  it("returns the requestId when exactly one bot replied", () => {
    expect(pickNextParentRequestId(["req-abc"])).toBe("req-abc");
  });

  it("returns undefined when no bots replied", () => {
    expect(pickNextParentRequestId([])).toBeUndefined();
  });

  it("returns undefined when multiple bots replied", () => {
    expect(pickNextParentRequestId(["req-a", "req-b"])).toBeUndefined();
  });

  it("returns undefined for 3+ replies", () => {
    expect(pickNextParentRequestId(["r1", "r2", "r3"])).toBeUndefined();
  });
});

describe("per-bot reply limit filtering", () => {
  it("filters out bots that exceeded MAX_BOT_REPLIES_PER_TURN", () => {
    const botReplyCount = new Map([["bot-a", 2], ["bot-b", 1]]);
    const botConfigs = [
      { name: "Alice", botId: "bot-a" },
      { name: "Bob", botId: "bot-b" },
    ];
    const MAX_BOT_REPLIES_PER_TURN = 2;
    const respondents = ["Alice", "Bob"].filter(name => {
      const bot = botConfigs.find(b => b.name === name);
      if (!bot) return false;
      return (botReplyCount.get(bot.botId) ?? 0) < MAX_BOT_REPLIES_PER_TURN;
    });
    expect(respondents).toEqual(["Bob"]);
  });

  it("allows bots under the limit", () => {
    const botReplyCount = new Map([["bot-a", 1], ["bot-b", 0]]);
    const botConfigs = [
      { name: "Alice", botId: "bot-a" },
      { name: "Bob", botId: "bot-b" },
    ];
    const MAX_BOT_REPLIES_PER_TURN = 2;
    const respondents = ["Alice", "Bob"].filter(name => {
      const bot = botConfigs.find(b => b.name === name);
      if (!bot) return false;
      return (botReplyCount.get(bot.botId) ?? 0) < MAX_BOT_REPLIES_PER_TURN;
    });
    expect(respondents).toEqual(["Alice", "Bob"]);
  });

  it("returns empty when all bots hit the limit", () => {
    const botReplyCount = new Map([["bot-a", 2]]);
    const botConfigs = [{ name: "Alice", botId: "bot-a" }];
    const MAX_BOT_REPLIES_PER_TURN = 2;
    const respondents = ["Alice"].filter(name => {
      const bot = botConfigs.find(b => b.name === name);
      if (!bot) return false;
      return (botReplyCount.get(bot.botId) ?? 0) < MAX_BOT_REPLIES_PER_TURN;
    });
    expect(respondents).toEqual([]);
  });
});

import { describe, it, expect } from "vitest";

import { buildContinuePrompt, buildAttachmentFallbackPrompt, buildOrchestratorPrompt, MAX_ROUNDS, resolveExplicitMentions, truncateHeadTail, CONTINUE_LATEST_TRUNCATE, CONTINUE_EARLIER_TRUNCATE } from "./handler";

describe("resolveExplicitMentions", () => {
  const botConfigs = [
    { name: "Alice", channels: { telegram: { token: "t1", channelUsername: "@alice_bot" } } },
    { name: "Bob", channels: { telegram: { token: "t2", channelUsername: "@bob_bot" } } },
    { name: "Charlie", channels: { discord: { token: "t3", channelUserId: "123456" } } },
    { name: "Dave", channels: { slack: { token: "t4", channelUserId: "U99999" } } },
  ] as any[];

  it("resolves Telegram @username to bot name", () => {
    expect(resolveExplicitMentions(["@alice_bot"], botConfigs, "telegram")).toEqual(["Alice"]);
  });

  it("resolves Discord userId to bot name", () => {
    expect(resolveExplicitMentions(["123456"], botConfigs, "discord")).toEqual(["Charlie"]);
  });

  it("resolves Slack userId to bot name", () => {
    expect(resolveExplicitMentions(["U99999"], botConfigs, "slack")).toEqual(["Dave"]);
  });

  it("ignores unknown mentions", () => {
    expect(resolveExplicitMentions(["@unknown_bot"], botConfigs, "telegram")).toEqual([]);
  });

  it("is case-insensitive for Telegram usernames", () => {
    expect(resolveExplicitMentions(["@Alice_Bot"], botConfigs, "telegram")).toEqual(["Alice"]);
  });

  it("returns empty for empty mentions", () => {
    expect(resolveExplicitMentions([], botConfigs, "telegram")).toEqual([]);
  });
});

describe("buildOrchestratorPrompt", () => {
  const bots = [
    { name: "Alice", persona: "friendly helper", channelId: "@alice_bot" },
    { name: "Bob", persona: "serious analyst", channelId: "@bob_bot" },
  ];

  it("includes channel identifiers in member list", () => {
    const prompt = buildOrchestratorPrompt("TestGroup", bots, []);
    expect(prompt).toContain("Alice (@alice_bot)");
    expect(prompt).toContain("Bob (@bob_bot)");
  });

  it("does not contain hardcoded reply-target-must-respond rule", () => {
    const prompt = buildOrchestratorPrompt("TestGroup", bots, ["Alice"]);
    expect(prompt).not.toContain("put X in wave 1 as the primary respondent");
    expect(prompt).not.toContain("only if the message topic naturally involves them");
  });

  it("contains reply-is-context guidance", () => {
    const prompt = buildOrchestratorPrompt("TestGroup", bots, []);
    expect(prompt).toContain("NOT a dispatch directive");
  });

  it("still marks mentioned members as MUST respond", () => {
    const prompt = buildOrchestratorPrompt("TestGroup", bots, ["Alice"]);
    expect(prompt).toContain("MUST respond");
    expect(prompt).toContain("Alice");
  });

  it("includes member sender identity in prompt", () => {
    const prompt = buildOrchestratorPrompt("TestGroup", bots, [], undefined, "Mimi", "member");
    expect(prompt).toContain("Mimi");
    expect(prompt).toContain("group member");
    expect(prompt).toContain("excluded from round 1");
  });

  it("includes external sender identity in prompt", () => {
    const prompt = buildOrchestratorPrompt("TestGroup", bots, [], undefined, "firedRice", "external");
    expect(prompt).toContain("firedRice");
    expect(prompt).not.toContain("group member");
  });

  it("defaults to generic sender when no sender params", () => {
    const prompt = buildOrchestratorPrompt("TestGroup", bots, []);
    expect(prompt).not.toContain("group member");
    expect(prompt).toContain("user's message");
  });

  it("uses sender-neutral mention rule", () => {
    const prompt = buildOrchestratorPrompt("TestGroup", bots, ["Alice"], undefined, "firedRice", "external");
    expect(prompt).toContain("The message mentioned");
    expect(prompt).not.toContain("The user mentioned");
  });

  it("works without channelId", () => {
    const botsNoChannel = [
      { name: "Alice", persona: "friendly" },
      { name: "Bob", persona: "serious" },
    ];
    const prompt = buildOrchestratorPrompt("TestGroup", botsNoChannel, []);
    expect(prompt).toContain("- Alice: friendly");
    expect(prompt).not.toContain("(undefined)");
  });
});

describe("buildAttachmentFallbackPrompt", () => {
  it("returns file description with sender name", () => {
    expect(buildAttachmentFallbackPrompt("Mimi", 1)).toBe("[Mimi sent 1 file]");
  });

  it("pluralizes for multiple files", () => {
    expect(buildAttachmentFallbackPrompt("firedRice", 3)).toBe("[firedRice sent 3 files]");
  });
});

describe("pure-image orchestrator prompt", () => {
  it("generates image description with sender name when userMessage is empty", () => {
    const userMessage = "";
    const images = [{ r2Key: "logs/test/img.jpg", mediaType: "image/jpeg" }];

    const orchestratorPrompt = userMessage.trim().length > 0
      ? userMessage
      : images?.length
        ? buildAttachmentFallbackPrompt("Mimi", images.length)
        : userMessage;

    expect(orchestratorPrompt).toBe("[Mimi sent 1 file]");
  });

  it("pluralizes for multiple images", () => {
    const userMessage = "";
    const images = [
      { r2Key: "logs/test/img1.jpg", mediaType: "image/jpeg" },
      { r2Key: "logs/test/img2.jpg", mediaType: "image/jpeg" },
    ];

    const orchestratorPrompt = userMessage.trim().length > 0
      ? userMessage
      : images?.length
        ? buildAttachmentFallbackPrompt("firedRice", images.length)
        : userMessage;

    expect(orchestratorPrompt).toBe("[firedRice sent 2 files]");
  });

  it("uses original userMessage when non-empty", () => {
    const userMessage = "Check this out";
    const images = [{ r2Key: "logs/test/img.jpg", mediaType: "image/jpeg" }];

    const orchestratorPrompt = userMessage.trim().length > 0
      ? userMessage
      : images?.length
        ? buildAttachmentFallbackPrompt("firedRice", images.length)
        : userMessage;

    expect(orchestratorPrompt).toBe("Check this out");
  });

  it("falls back to empty string when no images and no text", () => {
    const userMessage = "";
    const images = undefined as { r2Key: string; mediaType: string }[] | undefined;

    const imgCount = images?.length ?? 0;
    const orchestratorPrompt = userMessage.trim().length > 0
      ? userMessage
      : imgCount > 0
        ? buildAttachmentFallbackPrompt("firedRice", imgCount)
        : userMessage;

    expect(orchestratorPrompt).toBe("");
  });
});

describe("buildContinuePrompt", () => {
  const bots = [
    { name: "Alice", persona: "friendly" },
    { name: "Bob", persona: "serious" },
  ];

  it("separates earlier rounds from latest round", () => {
    const replies = [
      { round: 1, botName: "Alice", reply: "Here is my selfie!", mediaCount: 1 },
      { round: 1, botName: "Bob", reply: "My selfie too!", mediaCount: 1 },
      { round: 2, botName: "Alice", reply: "Nice photo Bob!" },
    ];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 3, "send selfies");
    expect(prompt).toContain("Earlier rounds (context");
    expect(prompt).toContain("Round 1:");
    expect(prompt).toContain("[Alice (attached 1 file)]: Here is my selfie!");
    expect(prompt).toContain("[Bob (attached 1 file)]: My selfie too!");
    expect(prompt).toContain("Latest round (round 2):");
    expect(prompt).toContain("[Alice]: Nice photo Bob!");
    expect(prompt).toContain("send selfies");
  });

  it("handles single round — no earlier rounds section", () => {
    const replies = [
      { round: 1, botName: "Alice", reply: "Hello!" },
    ];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 2, "hi");
    expect(prompt).not.toContain("Earlier rounds (context");
    expect(prompt).toContain("Latest round (round 1):");
    expect(prompt).toContain("[Alice]: Hello!");
  });

  it("includes evaluation instructions with reasoning", () => {
    const replies = [
      { round: 1, botName: "Alice", reply: "Sure!" },
    ];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 2, "ok");
    expect(prompt).toContain("reasoning");
    expect(prompt).toContain("shouldContinue");
    expect(prompt).toContain("respondents");
    expect(prompt).toContain("Stop heuristics");
    expect(prompt).toContain("at most ONE respondent");
  });

  it("uses sender name in original message context", () => {
    const replies = [{ round: 1, botName: "Alice", reply: "Nice!" }];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 2, "hello", "firedRice", "external");
    expect(prompt).toContain("Original message from firedRice");
    expect(prompt).not.toContain("Original user message");
  });

  it("scopes follow-up question rule to external sender", () => {
    const replies = [{ round: 1, botName: "Alice", reply: "What city?" }];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 2, "I had great food", "firedRice", "external");
    expect(prompt).toContain("external");
    expect(prompt).toContain("will reply naturally");
  });

  it("allows dispatching member sender for follow-up questions", () => {
    const replies = [{ round: 1, botName: "Alice", reply: "What city?" }];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 2, "I had great food", "Mimi", "member");
    expect(prompt).toContain("Mimi");
    expect(prompt).toContain("already dispatched in a PREVIOUS round");
  });

  it("includes positive continue rule for member sender", () => {
    const replies = [{ round: 1, botName: "Alice", reply: "What city?" }];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 2, "I had great food", "Mimi", "member");
    expect(prompt).toContain("has not yet responded in this interaction");
    expect(prompt).toContain("continue with [Mimi] as respondent");
  });

  it("includes fulfillment rule requiring same member delivery", () => {
    const replies = [{ round: 1, botName: "Alice", reply: "I'll send it" }];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 2, "send photos");
    expect(prompt).toContain("SAME member must deliver");
    expect(prompt).toContain("does not count");
  });

  it("includes continue triggers for disagreement and correction", () => {
    const replies = [{ round: 1, botName: "Alice", reply: "Sure!" }];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 2, "ok");
    expect(prompt).toContain("disagree");
    expect(prompt).toContain("correction");
  });

  it("clarifies that deferred-promise heuristic does not suppress addressed member reaction", () => {
    const replies = [{ round: 1, botName: "Alice", reply: "I'll bring you coffee" }];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 2, "anyone want coffee?");
    expect(prompt).toContain("PROMISER");
    expect(prompt).toContain("NOT the addressed member");
  });

  it("includes materiality condition for member sender continuation", () => {
    const replies = [{ round: 1, botName: "Alice", reply: "Try the new café!" }];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 2, "any recommendations?", "Mimi", "member");
    expect(prompt).toContain("materially responds to what Mimi said");
  });

  it("exports MAX_ROUNDS constant", () => {
    expect(MAX_ROUNDS).toBe(8);
  });

  it("truncates earlier round replies to CONTINUE_EARLIER_TRUNCATE", () => {
    const longReply = "x".repeat(500);
    const replies = [
      { round: 1, botName: "Alice", reply: longReply },
      { round: 2, botName: "Bob", reply: "short" },
    ];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 3, "test");
    // Earlier round reply (round 1) should be truncated with head+tail
    expect(prompt).not.toContain(longReply);
    const half = Math.floor(CONTINUE_EARLIER_TRUNCATE / 2);
    expect(prompt).toContain("x".repeat(half) + "…" + "x".repeat(half));
  });

  it("truncates latest round replies to CONTINUE_LATEST_TRUNCATE", () => {
    const longReply = "a".repeat(1500);
    const replies = [
      { round: 1, botName: "Alice", reply: longReply },
    ];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 2, "test");
    // Latest round reply should be truncated with head+tail
    expect(prompt).not.toContain(longReply);
    const half = Math.floor(CONTINUE_LATEST_TRUNCATE / 2);
    expect(prompt).toContain("a".repeat(half) + "…" + "a".repeat(half));
  });

  it("does not truncate short replies", () => {
    const replies = [
      { round: 1, botName: "Alice", reply: "Hello!" },
      { round: 2, botName: "Bob", reply: "Hi there!" },
    ];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 3, "test");
    expect(prompt).toContain("Hello!");
    expect(prompt).toContain("Hi there!");
  });
});

describe("buildContinuePrompt — deferred obligations", () => {
  const bots = [
    { name: "Alice", persona: "helpful" },
    { name: "Bob", persona: "funny" },
  ];

  it("includes deferred obligation rule in Do NOT continue section", () => {
    const replies = [{ round: 1, botName: "Alice", reply: "I'll check later" }];
    const prompt = buildContinuePrompt("TestGroup", bots, replies, 2, "test");
    expect(prompt).toContain("Deferred or future promises");
    expect(prompt).toContain("obligation to DELIVER is resolved");
  });
});

describe("truncateHeadTail", () => {
  it("returns text unchanged when within limit", () => {
    expect(truncateHeadTail("hello", 10)).toBe("hello");
  });

  it("returns text unchanged when exactly at limit", () => {
    expect(truncateHeadTail("hello", 5)).toBe("hello");
  });

  it("truncates with head+tail preservation", () => {
    const text = "abcdefghij"; // 10 chars
    const result = truncateHeadTail(text, 6); // half = 3
    expect(result).toBe("abc…hij");
  });

  it("handles empty string", () => {
    expect(truncateHeadTail("", 10)).toBe("");
  });
});

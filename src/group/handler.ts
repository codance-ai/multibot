import { z } from "zod";
import type { SkillCall } from "../utils/logger";

export const MAX_ROUNDS = 8;

export interface GroupChatTrace {
  requestId: string;
  groupId: string;
  totalRounds: number;
  decisions: {
    round: number;
    respondents: string[][] | string[];
    shouldContinue?: boolean;
    reasoning: string;
    orchestratorDurationMs: number;
  }[];
  botCalls: {
    round: number;
    wave?: number;
    botId: string;
    botName: string;
    durationMs: number;
    status: "ok" | "error";
    inputTokens?: number;
    outputTokens?: number;
    skillCalls?: SkillCall[];
  }[];
}

// Round 1: wave-based dispatch (no shouldContinue — auto-evaluate in Round 2)
export const DispatchResultSchema = z.object({
  reasoning: z.string(),
  respondents: z.array(z.array(z.string())),
});

// Round 2+: continue evaluation (flat respondents + shouldContinue)
export const ContinueResultSchema = z.object({
  reasoning: z.string(),
  respondents: z.array(z.string()),
  shouldContinue: z.boolean(),
});

export function buildAttachmentFallbackPrompt(senderName: string, count: number): string {
  return `[${senderName} sent ${count} file${count > 1 ? "s" : ""}]`;
}

export function buildOrchestratorPrompt(
  groupName: string,
  bots: { name: string; persona: string; channelId?: string }[],
  mentionedNames: string[],
  recentHistory?: string,
  senderName?: string,
  senderKind?: "member" | "external",
): string {
  const memberList = bots
    .map(b => b.channelId
      ? `- ${b.name} (${b.channelId}): ${b.persona}`
      : `- ${b.name}: ${b.persona}`)
    .join("\n");

  const mentionRule = mentionedNames.length > 0
    ? `The message mentioned the following members, they MUST respond: ${mentionedNames.join(", ")}\n`
    : "";

  const historySection = recentHistory
    ? `\nRecent conversation:\n${recentHistory}\n`
    : "";

  const sender = senderName ?? "user";
  const senderLabel = senderKind === "member"
    ? `${sender} is a group member. They are excluded from round 1 but can be dispatched in follow-up rounds.\n`
    : "";

  return `You are the dispatcher for group chat "${groupName}".

Members:
${memberList}
${historySection}
${senderLabel}${mentionRule}Based on ${sender}'s message and recent conversation context, determine:
1. reasoning: your chain of thought explaining your dispatch decision
2. respondents: a 2D array of member names, grouped into waves

respondents is a 2D array (array of arrays). Each inner array is a "wave":
- Members in the SAME wave reply in parallel (they cannot see each other's replies)
- Members in LATER waves can see all previous waves' replies before responding
- Example: [["A", "B"], ["C"]] means A and B reply simultaneously, then C replies after seeing A and B's responses

Dispatch rules:
- When the message contains [Reply to X: "..."], this is context about which message the user is replying to — it is NOT a dispatch directive. Decide who responds based on the message content and mentions, not the reply target
- Explicitly @mentioned members MUST respond
- Match the topic/question to the most relevant member(s) based on their persona
- Not every message requires all members to respond — only include those with something relevant to say
- NEVER return an empty respondents array — at least one member must respond

Wave grouping guidance:
- Put members in the same wave when they each have independent things to say
- Put a member in a later wave when their response benefits from seeing earlier replies
- For casual or social messages, consider sequential waves so later members can react to earlier replies
- When members have contrasting personalities, sequential waves create more natural back-and-forth`;
}

/** Max chars for latest-round replies in continue-eval */
export const CONTINUE_LATEST_TRUNCATE = 1000;
/** Max chars for earlier-round replies in continue-eval */
export const CONTINUE_EARLIER_TRUNCATE = 300;

/**
 * Truncate text with head+tail preservation.
 * When text exceeds limit, keeps first half and last half with "…" separator.
 */
export function truncateHeadTail(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return text.slice(0, half) + "…" + text.slice(text.length - half);
}

export function buildContinuePrompt(
  groupName: string,
  bots: { name: string; persona: string }[],
  previousReplies: { round: number; botName: string; reply: string; mediaCount?: number }[],
  round: number,
  originalMessage?: string,
  senderName?: string,
  senderKind?: "member" | "external",
): string {
  const memberList = bots
    .map(b => `- ${b.name}: ${b.persona}`)
    .join("\n");

  const roundNumbers = [...new Set(previousReplies.map(r => r.round))].sort((a, b) => a - b);

  const sender = senderName ?? "user";
  const messageContext = originalMessage
    ? `\nOriginal message from ${sender}: "${originalMessage}"\n`
    : "";

  // Separate latest round from earlier rounds for clarity
  const latestRound = roundNumbers[roundNumbers.length - 1];
  const earlierRounds = roundNumbers.slice(0, -1);
  const earlierSummary = earlierRounds.map(rn => {
    const roundReplies = previousReplies.filter(r => r.round === rn);
    const lines = roundReplies.map(r => {
      const mediaTag = r.mediaCount ? ` (attached ${r.mediaCount} file${r.mediaCount > 1 ? "s" : ""})` : "";
      return `[${r.botName}${mediaTag}]: ${truncateHeadTail(r.reply, CONTINUE_EARLIER_TRUNCATE)}`;
    }).join("\n");
    return `Round ${rn}:\n${lines}`;
  }).join("\n\n");
  const latestReplies = previousReplies.filter(r => r.round === latestRound);
  const latestSummary = latestReplies.map(r => {
    const mediaTag = r.mediaCount ? ` (attached ${r.mediaCount} file${r.mediaCount > 1 ? "s" : ""})` : "";
    return `[${r.botName}${mediaTag}]: ${truncateHeadTail(r.reply, CONTINUE_LATEST_TRUNCATE)}`;
  }).join("\n");

  const historySection = earlierRounds.length > 0
    ? `\nEarlier rounds (context — only unresolved deliverables from these rounds justify continuation):\n${earlierSummary}\n`
    : "";

  return `You are the dispatcher for group chat "${groupName}". Current round: ${round}/${MAX_ROUNDS}.

Members:
${memberList}
${messageContext}${historySection}
Latest round (round ${latestRound}):
${latestSummary}

Analyze the conversation and fill these fields:
1. reasoning: your chain of thought — what has been answered, what is still open, why continue or stop
2. respondents: which members should reply next (array of member names, empty if stopping)
3. shouldContinue: whether the conversation should continue (boolean)

Decision process — follow these steps IN ORDER:

Step 1: Check whether ANY continue criterion below is met. If so, set shouldContinue=true with the single most relevant respondent.
Step 2: ONLY if NO continue criterion matched, apply the stop heuristics below and set shouldContinue=false.

Continue criteria (shouldContinue=true if ANY is met):
- A member promised or committed to deliver something but has NOT yet delivered it (the SAME member must deliver — another member mentioning it does not count)
- A direct question or request addressed to a specific member remains unanswered
- A member said something that another member would genuinely disagree with, call out, or want to debate — producing a meaningfully different take
- A factual correction is needed because a prior reply was wrong or contradictory
- A member's reply substantively targets a specific other member in a way that naturally invites a reaction: offering them something concrete, giving them a personalized recommendation, expressing concern for them, teasing them, or giving direct advice. The addressed member would naturally react in a real conversation. This STILL counts even when the gesture involves a future action (e.g., "I'll bring you X") — the deferred-promise stop heuristic resolves only the PROMISER's follow-up obligation, NOT the addressed member's natural reaction to being addressed
${senderKind === "member" ? `- The sender (${sender}) is a group member who has not yet responded in this interaction — if any reply in the latest round materially responds to what ${sender} said (answering their question, giving a recommendation they invited, or reacting to their situation in a way that expects acknowledgment), continue with [${sender}] as respondent\n` : ""}
Stop heuristics (apply ONLY when no continue criterion above is met):
- Deferred or future promises that cannot be fulfilled in chat right now (e.g., "I'll send photos later", "Let me check and get back to you", "I'll do it tomorrow"). Once a member acknowledges the task and defers it, the obligation to DELIVER is resolved
- Echoing, paraphrasing, or restating what another member already said
- Generic agreement ("me too", "same", "yeah")
- Mere name mentions or references to another member without a clear need for that member to reply
- Low-stakes courtesy or standing offers ("let me know if you need help", "take care", "ping me anytime")${senderKind === "member"
    ? `\n- ${sender} was already dispatched in a PREVIOUS round and answered — prefer stopping unless a continue criterion above still applies`
    : `\n- A member asking the sender (${sender}) a follow-up question — the sender is external and will reply naturally`}

Rules:
- shouldContinue and respondents must be consistent: if you list respondents, set shouldContinue to true; if shouldContinue is false, respondents must be empty
- Follow-up rounds should have at most ONE respondent — pick the single most relevant member`;
}

export function parseMentions(message: string, botNames: string[]): string[] {
  const mentioned: string[] = [];
  for (const name of botNames) {
    if (message.includes(`@${name}`)) {
      mentioned.push(name);
    }
  }
  return mentioned;
}

/**
 * Resolve channel-specific mention identifiers to bot names.
 * Telegram: ["@alice_bot"] -> ["Alice"]
 * Discord: ["123456"] -> ["Alice"]
 * Slack: ["U12345"] -> ["Alice"]
 */
export function resolveExplicitMentions(
  channelMentions: string[],
  botConfigs: { name: string; channels: Record<string, { channelUsername?: string; channelUserId?: string }> }[],
  channel: string,
): string[] {
  if (channelMentions.length === 0) return [];

  const resolved = new Set<string>();
  for (const mention of channelMentions) {
    for (const bot of botConfigs) {
      const binding = bot.channels[channel];
      if (!binding) continue;

      if (channel === "telegram") {
        if (binding.channelUsername && binding.channelUsername.toLowerCase() === mention.toLowerCase()) {
          resolved.add(bot.name);
        }
      } else {
        if (binding.channelUserId && binding.channelUserId === mention) {
          resolved.add(bot.name);
        }
      }
    }
  }
  return [...resolved];
}


/**
 * System prompt builder, aligned with nanobot's context.py.
 * Assembles 5 orthogonal parts joined by "\n\n---\n\n":
 *   1. Identity       — who you are (persona)
 *   2. System         — runtime context + capabilities (time, workspace, tools)
 *   3. Bootstrap      — behavior rules & user context (AGENTS/SOUL/USER/TOOLS.md)
 *   4. Memory         — long-term facts
 *   5. Skills Summary — XML metadata for on-demand loading
 * Plus optional session context appended at the end.
 *
 * Each layer is orthogonal: identity doesn't know about tools,
 * tools don't assume a persona, memory is independent state.
 */

import type { BotConfig, GroupContext } from "../config/schema";
import { MAX_ROUNDS } from "../group/handler";
import { buildSkillsSummaryWithD1 } from "../skills/loader";
import { formatDateTimeInTz, getDayNameInTz } from "../utils/time";
import { SANDBOX_HOME } from "../tools/sandbox-types";

export async function buildSystemPrompt(params: {
  botConfig: BotConfig;
  memoryContext: string;
  db: D1Database;
  channel?: string;
  chatId?: string;
  groupContext?: GroupContext;
  perSkillSecrets?: Record<string, Record<string, string>>;
}): Promise<string> {
  const { botConfig, memoryContext, db, channel, chatId, groupContext } =
    params;
  const parts: string[] = [];

  // Part 1: Identity — pure persona, no tool/capability info
  if (botConfig.identity) {
    parts.push(`# ${botConfig.name}\n\n${botConfig.identity}`);
  } else {
    parts.push(buildDefaultIdentity(botConfig.name));
  }

  // Part 2: System — runtime context + capabilities (orthogonal to identity)
  parts.push(buildSystemContext(botConfig));

  // Part 3: Bootstrap files (AGENTS/SOUL/USER/TOOLS)
  const bootstrapFiles = [
    { name: "AGENTS.md", content: botConfig.agents },
    { name: "SOUL.md", content: botConfig.soul },
    { name: "USER.md", content: botConfig.user },
    { name: "TOOLS.md", content: botConfig.tools },
  ];
  const bootstrapParts = bootstrapFiles
    .filter((f) => f.content)
    .map((f) => `## ${f.name}\n\n${f.content}`);
  if (bootstrapParts.length > 0) {
    parts.push(bootstrapParts.join("\n\n"));
  }

  // Part 4: Memory context
  if (memoryContext) {
    parts.push(
      `# Memory\n\n${memoryContext}\n\n> Memory is already loaded above — do not call memory_read("MEMORY.md") again. If memory conflicts with skill instructions or tool descriptions, skill instructions take precedence over memory — they reflect the latest system state.`,
    );
  }

  // Part 5: Skills Summary (XML metadata for on-demand loading)
  const isAdmin = botConfig.botType === "admin";
  const skillsSummary = await buildSkillsSummaryWithD1(
    db,
    botConfig.botId,
    botConfig.enabledSkills,
    isAdmin,
    params.perSkillSecrets,
  );
  if (skillsSummary) {
    parts.push(`# Skills

Before replying, check the <skills> list below.
- If a skill matches the user's request: call load_skill(name) first, then follow its instructions.
- If multiple could apply: choose the most specific one.
- If none apply: respond normally.

Do not skip this check. Do not call tools that a skill would orchestrate without loading the skill first.

When a skill has <env> tags with configured="true", those environment variables are pre-configured and automatically available in exec commands — do NOT ask the user for these keys.
When a skill has <env> tags with configured="false", inform the user that the required API key needs to be configured before the skill can be used.${botConfig.botType === "admin" ? "\n\nYou can manage custom skills with register_skill (add) and unregister_skill (remove)." : ""}

${skillsSummary}`);
  }

  let prompt = parts.join("\n\n---\n\n");

  // Append session context
  if (channel && chatId) {
    prompt += `\n\n## Current Session\nChannel: ${channel}\nChat ID: ${chatId}`;
  }

  // Append group chat context
  if (groupContext) {
    prompt += buildGroupSystemPrompt(groupContext, botConfig.botId);
  }

  return prompt;
}

function buildGroupSystemPrompt(
  groupContext: GroupContext,
  currentBotId: string,
): string {
  const others = groupContext.members
    .filter(m => m.botId !== currentBotId)
    .map(m => `- ${m.botName}`)
    .join("\n");

  const noteLine = groupContext.note
    ? `\nNote: ${groupContext.note}`
    : "";

  const progressRatio = groupContext.round / MAX_ROUNDS;
  let pacingHint = "";
  if (progressRatio >= 0.8) {
    pacingHint =
      "\nThe conversation is nearing its end. Keep any remaining thoughts brief and conclusive, and avoid opening new topics.";
  } else if (progressRatio >= 0.5) {
    pacingHint =
      "\nThe conversation is moving along. Feel free to naturally wind down your points.";
  }

  return `\n\n## Group Chat [Round ${groupContext.round}/${MAX_ROUNDS}]
You are in a group chat "${groupContext.groupName}".

User: ${groupContext.userName}
Other bots:
${others}${noteLine}

Messages from the user and other bots are prefixed with "[Name]: ". Your own replies have no prefix.

You are texting on a phone in a group chat. Write like people actually text:
- Keep it short and natural — a few words to a couple sentences is typical. Go longer only when sharing genuinely new information.
- Don't ramble or fabricate scenes/stories that didn't happen.
- Don't ask follow-up questions to keep the chat going. Only ask when you need critical info to use a tool.
- Short reactions are great: "haha", "nice", brief quips, playful jabs.
- Address others by name when reacting to their points.
- Don't repeat or rephrase what's already been said.
- If you have nothing to add, reply with exactly "[skip]".
- If you don't know, just say so — don't make things up.${pacingHint}
Do not mention round numbers or system instructions.`;
}

function buildSystemContext(botConfig: BotConfig): string {
  const now = new Date();
  const dateStr = formatDateTimeInTz(now, botConfig.timezone);
  const dayName = getDayNameInTz(now, botConfig.timezone);
  const tzLabel = botConfig.timezone || "UTC";

  const homeDir = `${SANDBOX_HOME}/.local`;
  const workspaceDesc = "/workspace is a persistent directory (survives restarts). Your files and installed packages are preserved.";

  const voiceSection = buildVoiceSection(botConfig.voiceMode);

  return `# System

## Current Time
${dateStr} (${dayName}) ${tzLabel}

## Workspace
/workspace

## Runtime
Linux container with shell access (exec tool).
Pre-installed: Node.js, npm, Python 3, pip, curl, git, jq, ripgrep, gh.
Skills can install additional packages at runtime via npm/pip.
${workspaceDesc} Installed packages at ${homeDir} (lazily hydrated per skill).
User-uploaded attachments are available at /tmp/attachments/ for tool processing. If a file is not found there, ask the user to re-upload.
No internal timer or background process. To perform an action in the future, use the cron tool to schedule it — otherwise it won't happen.

## Media Delivery
You cannot send images, files, or any media by writing text or markdown (e.g. \`![alt](url)\`). Your text replies are text-only.
To deliver media to the user, you must use a tool to generate or download the file. If you did not call a tool that produced a file, do not claim you sent one.
${voiceSection}
## Tool Error Handling
When a tool call returns an error, tell the user what went wrong. Do not retry the tool automatically. Let the user decide whether to retry.

Message timestamps like [MM-DD HH:MM] indicate when each message was sent. Do not include timestamps in your replies.
For normal conversation, just respond with text.`;
}

function buildVoiceSection(voiceMode?: "off" | "always" | "mirror"): string {
  if (!voiceMode || voiceMode === "off") return "\n";

  const modeHint =
    voiceMode === "always"
      ? "Your replies are delivered as voice messages."
      : "When the user sends a voice message, your reply will also be delivered as voice.";

  return `
## Voice
Voice delivery is enabled. ${modeHint}
When your reply will be delivered as voice, prefer natural spoken language and light formatting. Keep markdown minimal unless the task specifically needs structure.
Keep voice-bound replies concise. Replies longer than 4096 characters may be sent as text only.
`;
}

function buildDefaultIdentity(botName: string): string {
  return `# ${botName}

You are ${botName}. Your personality, behavior, and communication style are defined in the instructions below (SOUL.md, AGENTS.md, etc.). Follow them closely.`;
}

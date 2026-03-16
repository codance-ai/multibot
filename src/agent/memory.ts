import { generateText, tool } from "ai";
import type { LanguageModel } from "ai";
import { z } from "zod";
import { buildCachedSystemPrompt } from "../providers/cache";
import { convertStoredTimestampFull } from "../utils/time";
import { getMemory, upsertMemory, insertHistoryEntry, deleteExpiredHistoryEntries, getHistoryEntries } from "../db/d1";

/** Max messages per consolidation batch (SQL LIMIT) */
export const CONSOLIDATION_MSG_LIMIT = 200;
/** Max chars per message content during consolidation */
export const CONSOLIDATION_MSG_TRUNCATE = 2000;
/** Max quality audit retries per batch */
export const QUALITY_AUDIT_MAX_RETRIES = 1;

/**
 * Load bot memory from D1 and format for system prompt injection.
 * Matches nanobot's MemoryStore.get_memory_context() format.
 */
export async function loadMemoryContext(
  db: D1Database,
  botId: string
): Promise<string> {
  const content = await getMemory(db, botId);
  if (!content) return "";
  return `## Long-term Memory\n${content}`;
}

/**
 * Estimate token count with CJK-aware heuristic.
 * - CJK characters: ~1.5 tokens/char × 1.2 safety = 1.8 tokens/char
 * - Non-CJK characters: ~1 token/3 chars × 1.2 safety = 0.4 tokens/char
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  // Count CJK characters (CJK Unified Ideographs, Kana, Hangul, fullwidth forms)
  const cjkCount = (text.match(/[\u2E80-\u9FFF\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFFEF\u3000-\u303F\u3040-\u309F\u30A0-\u30FF\uAC00-\uD7AF]/g) || []).length;
  const nonCjkCount = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.8 + (nonCjkCount / 3) * 1.2);
}

/** Token usage breakdown for a prompt + history assembly. */
export interface TokenUsage {
  systemPromptTokens: number;
  historyTokens: number;
  totalTokens: number;
  contextWindow: number;
  usageRatio: number; // totalTokens / contextWindow
  trimmedCount: number; // number of history rows dropped due to token budget
}

/** Tiered truncation limits matching buildPromptAndHistory behavior. */
export const HISTORY_RECENT_CHAR_LIMIT = 4000;
export const HISTORY_OLDER_CHAR_LIMIT = 2000;
/** Max chars of tool_calls JSON to estimate (cap outliers). */
const TOOL_CALLS_ESTIMATE_CAP = 4000;

/**
 * Estimate token count for a single conversation history row,
 * applying the same tiered truncation that buildPromptAndHistory uses.
 */
export function estimateRowTokens(
  row: { content: string | null; tool_calls?: string | null },
  isRecent: boolean,
): number {
  const content = row.content ?? "";
  const charLimit = isRecent ? HISTORY_RECENT_CHAR_LIMIT : HISTORY_OLDER_CHAR_LIMIT;
  const truncated = content.length > charLimit ? content.slice(0, charLimit) : content;

  let tokens = estimateTokens(truncated);

  if (row.tool_calls) {
    const toolStr = row.tool_calls.length > TOOL_CALLS_ESTIMATE_CAP
      ? row.tool_calls.slice(0, TOOL_CALLS_ESTIMATE_CAP)
      : row.tool_calls;
    tokens += estimateTokens(toolStr);
  }

  // Fixed overhead: timestamp prefix, role tag, message structure
  tokens += 30;

  return tokens;
}

/** Memory size limit in tokens = 3% of context window */
export function getMemoryTokenLimit(contextWindow: number): number {
  return Math.floor(contextWindow * 0.03);
}

export interface ConsolidateParams {
  model: LanguageModel;
  db: D1Database;
  botId: string;
  messages: Array<{
    id: number;
    role: string;
    content: string | null;
    bot_id?: string | null;
    tool_calls?: string | null;
    created_at: string;
  }>;
  memoryWindow: number;
  archiveAll?: boolean;
  timezone?: string;
}

/** Estimate tokens for a single message (content truncated to CONSOLIDATION_MSG_TRUNCATE + overhead). */
function estimateMessageTokens(m: { content: string | null; tool_calls?: string | null; created_at: string }): number {
  const content = m.content ?? "";
  const truncated = content.length > CONSOLIDATION_MSG_TRUNCATE
    ? content.slice(0, CONSOLIDATION_MSG_TRUNCATE)
    : content;
  // Estimate actual content tokens (CJK-aware) + fixed overhead for timestamp/role/formatting (~30 tokens)
  return estimateTokens(truncated) + 30;
}

/**
 * Align a split index to the nearest user turn boundary.
 * Walks forward from `splitIndex` to find the next `role === 'user'` message.
 * If no user message found within a reasonable range (30% of remaining messages),
 * falls back to the original splitIndex to avoid oversized batches.
 */
export function alignToTurnBoundary<T extends { role: string }>(
  messages: T[],
  splitIndex: number,
): number {
  if (splitIndex <= 0) return 0;
  if (splitIndex >= messages.length) return messages.length;

  // Already on a user message — perfect boundary
  if (messages[splitIndex].role === "user") return splitIndex;

  // Walk forward to find next user message (capped at 5 to avoid excessive keep-window shrinkage)
  const maxWalk = Math.min(5, messages.length - splitIndex - 1);
  for (let j = splitIndex + 1; j < messages.length && j - splitIndex <= maxWalk; j++) {
    if (messages[j].role === "user") return j;
  }

  // No user message found within range — fall back to original index
  return splitIndex;
}

/**
 * Split messages into batches that fit within both message count and token budget.
 * Batch boundaries are aligned to user turn boundaries to avoid splitting conversations mid-turn.
 * If a batch of `maxCount` messages exceeds `tokenBudget`, halve the batch size and retry.
 */
export function splitIntoBatches<T extends { role: string; content: string | null; tool_calls?: string | null; created_at: string }>(
  messages: T[],
  maxCount: number,
  tokenBudget: number,
): T[][] {
  const batches: T[][] = [];
  let i = 0;
  while (i < messages.length) {
    let batchSize = Math.min(maxCount, messages.length - i);
    let batch = messages.slice(i, i + batchSize);

    // Shrink batch if estimated tokens exceed budget
    let tokens = batch.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    while (tokens > tokenBudget && batchSize > 1) {
      batchSize = Math.max(1, Math.floor(batchSize / 2));
      batch = messages.slice(i, i + batchSize);
      tokens = batch.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
    }

    // Align batch end to turn boundary (unless this is the last batch)
    if (i + batchSize < messages.length) {
      const aligned = alignToTurnBoundary(messages, i + batchSize);
      if (aligned > i + batchSize && aligned <= messages.length) {
        // Only extend if it doesn't exceed budget by too much (30% tolerance)
        const extendedBatch = messages.slice(i, aligned);
        const extendedTokens = extendedBatch.reduce((sum, m) => sum + estimateMessageTokens(m), 0);
        if (extendedTokens <= tokenBudget * 1.3) {
          batchSize = aligned - i;
          batch = extendedBatch;
        }
      }
    }

    batches.push(batch);
    i += batchSize;
  }
  return batches;
}

/**
 * Extract opaque identifiers (UUIDs, URLs, file paths) from text.
 * Used for quality auditing of consolidation summaries.
 */
export function extractIdentifiers(text: string): string[] {
  const MAX_IDENTIFIERS = 12;
  // Hex identifiers: 8+ hex chars with at least one A-F letter (excludes pure decimal numbers)
  const matches = text.match(
    /((?=[A-Fa-f0-9]*[A-Fa-f])[A-Fa-f0-9]{8,}|https?:\/\/[^\s)>\],"']+|\/[\w.-]{2,}(?:\/[\w.-]+)+)/g
  ) ?? [];

  return Array.from(
    new Set(
      matches
        .map((v) => v.replace(/[)\]"'`,;:.!?<>]+$/, "").trim()) // strip trailing punctuation
        .filter((v) => v.length >= 4),
    ),
  ).slice(0, MAX_IDENTIFIERS);
}

/** Structured archive result from LLM */
interface ArchiveResult {
  summary: string;
  decisions: string;
  open_todos: string;
  key_identifiers: string;
}

/**
 * Audit quality of a structured archive result.
 * Returns { ok: true } if quality is acceptable, or { ok: false, reasons } with specific failures.
 */
export function auditSummaryQuality(
  result: ArchiveResult,
  sourceIdentifiers: string[],
): { ok: boolean; reasons: string[] } {
  const reasons: string[] = [];

  // Check that summary is non-empty
  if (!result.summary || result.summary.trim().length < 10) {
    reasons.push("summary_too_short");
  }

  // Check that key identifiers from source text are preserved
  if (sourceIdentifiers.length > 0) {
    const identifierValue = (result.key_identifiers ?? "").trim();
    if (!isNoneValue(identifierValue) && identifierValue.length > 0) {
      const missing = sourceIdentifiers.filter(
        (id) => !identifierValue.toUpperCase().includes(id.toUpperCase()),
      );
      if (missing.length > 0) {
        reasons.push(`missing_identifiers:${missing.slice(0, 3).join(",")}`);
      }
    } else {
      // LLM said "None" or empty but source text has identifiers
      reasons.push("identifiers_marked_none_but_source_has_identifiers");
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/**
 * Format a structured archive result into markdown for storage.
 * Omits sections with "None" or "N/A" values.
 */
function formatArchiveEntry(result: ArchiveResult): string {
  const parts: string[] = [result.summary];

  if (result.decisions && !isNoneValue(result.decisions)) {
    parts.push(`**Decisions:** ${result.decisions}`);
  }
  if (result.open_todos && !isNoneValue(result.open_todos)) {
    parts.push(`**Open TODOs:** ${result.open_todos}`);
  }
  if (result.key_identifiers && !isNoneValue(result.key_identifiers)) {
    parts.push(`**Identifiers:** ${result.key_identifiers}`);
  }

  return parts.join("\n");
}

function isNoneValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "none" || normalized === "n/a" || normalized === "none.";
}

/**
 * Consolidate old messages into HISTORY.md only.
 * Pure conversation archiver — produces history_entry logs, never touches MEMORY.md.
 *
 * When archiveAll is true (/new command), consolidates all messages.
 * Otherwise, consolidates messages beyond the keep window.
 *
 * Returns the new last_consolidated boundary (message ID),
 * or null if consolidation was skipped.
 */
export async function consolidateMemory(
  params: ConsolidateParams
): Promise<number | null> {
  const { model, db, botId, messages, memoryWindow, archiveAll, timezone } = params;

  let toConsolidate: typeof messages;

  if (archiveAll) {
    toConsolidate = messages;
  } else {
    const keepCount = Math.floor(memoryWindow / 2);
    if (messages.length <= keepCount) return null;

    // Align split to user turn boundary so we don't cut mid-turn
    const rawSplitIndex = messages.length - keepCount;
    const alignedSplitIndex = alignToTurnBoundary(messages, rawSplitIndex);
    toConsolidate = messages.slice(0, alignedSplitIndex);
  }

  if (toConsolidate.length === 0) return null;

  // Process in batches — start with CONSOLIDATION_MSG_LIMIT, then shrink if token estimate exceeds safe threshold.
  // Conservative context budget: 100K tokens for the consolidation prompt (leaves room for system prompt + tool schema).
  const CONSOLIDATION_TOKEN_BUDGET = 100_000;
  const batches = splitIntoBatches(toConsolidate, CONSOLIDATION_MSG_LIMIT, CONSOLIDATION_TOKEN_BUDGET);

  // Track the last message ID that was successfully archived.
  // Only advance boundary to batches where LLM actually produced a summary.
  let lastSuccessfulId: number | null = null;

  for (const batch of batches) {
    // Format messages matching nanobot's format:
    // [{timestamp}] {ROLE} [tools: tool1, tool2]: {content}
    const lines: string[] = [];
    for (const m of batch) {
      if (!m.content) continue;
      const ts = m.created_at ? convertStoredTimestampFull(m.created_at, timezone) : "?";
      let toolsSuffix = "";
      if (m.tool_calls) {
        try {
          const parsed = JSON.parse(m.tool_calls);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const toolNames = parsed.map((c: { toolName: string }) => c.toolName);
            toolsSuffix = ` [tools: ${toolNames.join(", ")}]`;
          }
        } catch (e) {
          // ignore parse errors
          console.warn("[memory] Failed to parse tool_calls JSON:", e);
        }
      }
      const role = m.role.toUpperCase();
      // In shared sessions, label other bots' assistant messages
      const botLabel = (m.role === "assistant" && m.bot_id && m.bot_id !== botId)
        ? ` [${m.bot_id}]` : "";
      // Truncate individual message content
      const content = m.content.length > CONSOLIDATION_MSG_TRUNCATE
        ? m.content.slice(0, CONSOLIDATION_MSG_TRUNCATE) + "…"
        : m.content;
      lines.push(`[${ts}] ${role}${botLabel}${toolsSuffix}: ${content}`);
    }

    if (lines.length === 0) continue;

    const conversation = lines.join("\n");

    // Extract identifiers from formatted text (what LLM actually sees)
    const sourceIdentifiers = extractIdentifiers(conversation);

    const archiveTool = {
      archive_conversation: tool({
        description: "Archive the conversation to the history log with structured sections.",
        inputSchema: z.object({
          summary: z.string().describe(
            "A paragraph (2-5 sentences) summarizing key events/decisions/topics. " +
            "Start with [YYYY-MM-DD HH:MM]. Include detail useful for grep search. " +
            "Include any observed user preferences, rules, or commitments expressed during the conversation — " +
            "these details are essential for downstream memory curation."
          ),
          decisions: z.string().describe(
            "Key decisions made during the conversation. Write 'None' if no decisions were made."
          ),
          open_todos: z.string().describe(
            "Open action items or commitments. Write 'None' if none."
          ),
          key_identifiers: z.string().describe(
            "Important UUIDs, URLs, file paths, or other identifiers mentioned. Write 'None' if none."
          ),
        }),
      }),
    };

    const consolidationSystemPrompt =
      "You are a conversation archiver. Summarize the conversation into a structured history entry.\n\n" +
      "Capture WHAT HAPPENED: key topics, decisions, actions taken, tool calls, and outcomes.\n" +
      "Also note any user preferences, rules, or commitments expressed — these are valuable for memory curation.\n" +
      "Preserve important identifiers (UUIDs, URLs, file paths) exactly as they appear.\n" +
      "Include timestamps and searchable details. Write in the same language the conversation primarily uses.\n\n" +
      "Call the archive_conversation tool with your structured summary.";
    const { system, systemMessages } = buildCachedSystemPrompt(model, consolidationSystemPrompt);

    const userPrompt = `Archive this conversation by calling the archive_conversation tool.\n\n## Conversation to Archive\n${conversation}`;

    let archiveResult: ArchiveResult | null = null;
    let attempts = 0;
    const maxAttempts = 1 + QUALITY_AUDIT_MAX_RETRIES;

    while (attempts < maxAttempts) {
      attempts++;

      // Build system prompt — on retry, append quality feedback
      let currentSystemPrompt = consolidationSystemPrompt;
      if (attempts > 1 && archiveResult) {
        const audit = auditSummaryQuality(archiveResult, sourceIdentifiers);
        currentSystemPrompt += `\n\nQuality feedback from previous attempt (fix these issues):\n- ${audit.reasons.join("\n- ")}\n` +
          "Ensure all identifiers from the conversation are preserved in the key_identifiers field.";
      }

      const { system: currentSystem, systemMessages: currentSysMsgs } =
        buildCachedSystemPrompt(model, currentSystemPrompt);

      const result = await generateText({
        model,
        ...(currentSystem ? { system: currentSystem } : {}),
        messages: [
          ...currentSysMsgs,
          {
            role: "user",
            content: [{ type: "text", text: userPrompt }],
          },
        ],
        tools: archiveTool,
        toolChoice: { type: "tool", toolName: "archive_conversation" },
      });

      // Extract tool call result
      const toolCall = result.toolCalls?.[0];
      if (!toolCall || toolCall.toolName !== "archive_conversation") {
        console.warn("[memory] LLM did not call archive_conversation, batch skipped — will retry on next consolidation cycle");
        archiveResult = null;
        break;
      }

      archiveResult = toolCall.input as ArchiveResult;

      // Quality audit — retry if audit fails and we have retries left
      if (attempts < maxAttempts) {
        const audit = auditSummaryQuality(archiveResult, sourceIdentifiers);
        if (audit.ok) break;
        console.warn(`[memory] Quality audit failed (attempt ${attempts}/${maxAttempts}): ${audit.reasons.join(", ")}`);
        // Loop will retry with feedback
      } else {
        break; // Max attempts reached — accept best effort
      }
    }

    if (archiveResult) {
      const historyEntry = formatArchiveEntry(archiveResult);
      if (historyEntry) {
        await insertHistoryEntry(db, botId, historyEntry);
      }
    }

    // Batch succeeded — advance boundary to end of this batch
    if (archiveResult) {
      lastSuccessfulId = batch[batch.length - 1].id;
    }
  }

  // Clean up expired history entries once after all batches
  await deleteExpiredHistoryEntries(db, botId, 180);

  // Only return the boundary up to the last successfully archived batch.
  // If no batch succeeded, return null so the caller does NOT advance the boundary.
  return lastSuccessfulId;
}

export interface ReviewMemoryParams {
  model: LanguageModel;
  db: D1Database;
  botId: string;
  contextWindow?: number;
}

/**
 * Periodic memory review: read recent history entries, curate MEMORY.md.
 * Extracts durable patterns from history, removes outdated info.
 * Returns true if memory was updated.
 */
export async function reviewMemory(params: ReviewMemoryParams): Promise<boolean> {
  const { model, db, botId, contextWindow } = params;

  const currentMemory = await getMemory(db, botId);
  const historyEntries = await getHistoryEntries(db, botId, 200);

  // Skip if no history to review
  if (historyEntries.length === 0) return false;

  const historyText = historyEntries
    .map((e) => e.content)
    .join("\n\n");

  const tokenLimit = getMemoryTokenLimit(contextWindow ?? 128000);
  const currentTokens = estimateTokens(currentMemory || "");

  const reviewSystemPrompt =
    "You are a memory review agent. Review recent history entries and curate the long-term memory.\n\n" +
    "Tasks:\n" +
    "1. Extract newly discovered durable facts from history → add to memory\n" +
    "2. Identify patterns that appear multiple times in history → summarize as rules/preferences\n" +
    "3. Remove outdated information from memory that history shows has changed\n" +
    "4. Ensure memory contains NO timestamped event logs — only curated wisdom\n\n" +
    "ONLY add to memory: user preferences, habits, personality traits, relationship facts, " +
    "explicit rules set by the user, ongoing commitments and goals.\n\n" +
    "NEVER add to memory: tool usage or command syntax, skill instructions or workflows, " +
    "system capabilities or platform limitations, API details or technical implementation. " +
    "This information comes from skills and system prompts which update with each deployment.\n\n" +
    "Your output MUST use only these markdown sections (omit empty ones):\n" +
    "## User Profile\n## Preferences\n## Rules & Boundaries\n## Relationships\n## Ongoing Commitments\n\n" +
    "Return ONLY the updated memory text as markdown. Write in the same language as the input.";

  const userPrompt = `Review and curate this memory based on recent history.

## Current Long-term Memory (~${currentTokens} tokens, target limit: ~${tokenLimit} tokens)
${currentMemory || "(empty)"}

## Recent History Entries
${historyText}`;

  const { system, systemMessages } = buildCachedSystemPrompt(model, reviewSystemPrompt);

  const result = await generateText({
    model,
    ...(system ? { system } : {}),
    messages: [
      ...systemMessages,
      { role: "user", content: [{ type: "text", text: userPrompt }] },
    ],
  });

  let updatedMemory = result.text;

  // Overflow compression (same logic as consolidateMemory)
  const memoryTokens = estimateTokens(updatedMemory);
  if (memoryTokens > tokenLimit) {
    const { system: compressSystem, systemMessages: compressSystemMessages } =
      buildCachedSystemPrompt(model,
        "You are a memory compression agent. Compress the memory to fit within the token budget. " +
        "Rules: 1) Remove ALL timestamped event logs (they belong in history, not memory). " +
        "2) Merge related facts into concise statements. " +
        "3) Keep: user profile, preferences, relationships, rules/boundaries. " +
        "4) Remove: transactional details, one-off events, superseded information. " +
        "Write in the same language as the input. Return ONLY the compressed memory text, nothing else."
      );

    const compressResult = await generateText({
      model,
      ...(compressSystem ? { system: compressSystem } : {}),
      messages: [
        ...compressSystemMessages,
        { role: "user", content: [{ type: "text", text: `Compress this memory to fit within ~${tokenLimit} tokens (currently ~${memoryTokens} tokens):\n\n${updatedMemory}` }] },
      ],
    });
    updatedMemory = compressResult.text;
  }

  // Hard truncation fallback — section-aware: drop low-priority sections first
  const finalTokens = estimateTokens(updatedMemory);
  const hardLimit = Math.floor(tokenLimit * 1.2);
  if (finalTokens > hardLimit) {
    updatedMemory = truncateMemoryBySections(updatedMemory, tokenLimit);
  }

  if (!updatedMemory || updatedMemory === currentMemory) return false;

  await upsertMemory(db, botId, updatedMemory);
  return true;
}

/** Section retention priority: higher number = keep longer */
const SECTION_PRIORITY: Record<string, number> = {
  "rules & boundaries": 5,
  "user profile": 4,
  "preferences": 3,
  "ongoing commitments": 2,
  "relationships": 1,
};

interface MemorySection {
  header: string;
  title: string;
  lines: string[];
  priority: number;
}

/** Parse memory markdown into sections by `## ` headers. */
function parseSections(markdown: string): MemorySection[] {
  const sections: MemorySection[] = [];
  const lines = markdown.split("\n");

  let currentHeader = "";
  let currentTitle = "";
  let currentLines: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ")) {
      if (currentHeader || currentLines.length > 0) {
        sections.push({
          header: currentHeader,
          title: currentTitle,
          lines: currentLines,
          priority: SECTION_PRIORITY[currentTitle] ?? 0,
        });
      }
      currentHeader = line;
      currentTitle = line.replace(/^##\s+/, "").trim().toLowerCase();
      currentLines = [];
    } else {
      currentLines.push(line);
    }
  }

  if (currentHeader || currentLines.length > 0) {
    sections.push({
      header: currentHeader,
      title: currentTitle,
      lines: currentLines,
      priority: SECTION_PRIORITY[currentTitle] ?? 0,
    });
  }

  return sections;
}

/** Rebuild markdown from sections, preserving original order. */
function buildMarkdown(sections: MemorySection[]): string {
  return sections
    .filter((s) => s.header || s.lines.some((l) => l.trim()))
    .map((s) => {
      const parts: string[] = [];
      if (s.header) parts.push(s.header);
      // Strip trailing blank lines to avoid double-spacing after truncation
      const trimmedLines = [...s.lines];
      while (trimmedLines.length > 0 && !trimmedLines[trimmedLines.length - 1].trim()) {
        trimmedLines.pop();
      }
      if (trimmedLines.length > 0) parts.push(trimmedLines.join("\n"));
      return parts.join("\n");
    })
    .join("\n\n");
}

/**
 * Section-aware memory truncation.
 * Removes content from lowest-priority sections first (line by line from the end),
 * then drops entire sections if needed, until within token budget.
 */
export function truncateMemoryBySections(markdown: string, maxTokens: number): string {
  const sections = parseSections(markdown);
  const dropOrder = [...sections].sort((a, b) => a.priority - b.priority);

  const initial = buildMarkdown(sections).replace(/\n{3,}/g, "\n\n").trim();
  if (estimateTokens(initial) <= maxTokens) {
    return initial;
  }

  for (const target of dropOrder) {
    while (target.lines.length > 0 && estimateTokens(buildMarkdown(sections)) > maxTokens) {
      target.lines.pop();
    }

    // Empty section — drop the header too
    if (target.lines.length === 0 && target.header) {
      target.header = "";
    }

    if (estimateTokens(buildMarkdown(sections)) <= maxTokens) break;
  }

  return buildMarkdown(sections).replace(/\n{3,}/g, "\n\n").trim();
}

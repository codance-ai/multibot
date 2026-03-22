/**
 * Context Pruning — runtime tool result trimming before LLM calls.
 *
 * Three-tier mechanism inspired by OpenClaw:
 * 1. Soft-trim: keep head+tail of large tool results, replace middle
 * 2. Hard-clear: replace entire tool result with a placeholder
 * 3. Bootstrap protection: never touch messages before the first user message
 *
 * Only modifies in-memory messages; persisted history is never changed.
 */
import type { ModelMessage } from "ai";
import { estimateTokens } from "./memory";

// ── Configuration ──────────────────────────────────────────────────────

/** Context ratio threshold to trigger soft-trim (30% of context window). */
export const SOFT_TRIM_RATIO = 0.3;
/** Context ratio threshold to trigger hard-clear (50% of context window). */
export const HARD_CLEAR_RATIO = 0.5;
/** Tool results shorter than this (chars) are never soft-trimmed. */
export const SOFT_TRIM_MAX_CHARS = 4000;
/** Characters to keep from the head of a soft-trimmed tool result. */
export const SOFT_TRIM_HEAD_CHARS = 1500;
/** Characters to keep from the tail of a soft-trimmed tool result. */
export const SOFT_TRIM_TAIL_CHARS = 1500;
/** Number of most-recent assistant-with-tool-call blocks to protect. */
export const KEEP_LAST_TOOL_ASSISTANTS = 3;

// ── Types ──────────────────────────────────────────────────────────────

export interface PruningStats {
  softTrimmed: number;
  hardCleared: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
}

export interface PruneOptions {
  /** Model context window in tokens. Default 128 000. */
  contextWindowTokens?: number;
}

// ── Helpers ────────────────────────────────────────────────────────────

/** Extract text value from a tool-result output (handles AI SDK v6 nested format). */
function extractToolResultText(output: unknown): string {
  if (typeof output === "string") return output;
  if (output != null && typeof output === "object" && "value" in output) {
    const v = (output as { value: unknown }).value;
    return typeof v === "string" ? v : JSON.stringify(v);
  }
  return typeof output === "undefined" ? "" : JSON.stringify(output);
}

/** Estimate tokens for a single ModelMessage (CJK-aware). */
function estimateMessageTokens(msg: ModelMessage): number {
  if (typeof msg.content === "string") return estimateTokens(msg.content);
  if (!Array.isArray(msg.content)) return 0;

  let tokens = 0;
  for (const part of msg.content) {
    const p = part as Record<string, unknown>;
    if (p.type === "text") {
      tokens += estimateTokens(p.text as string);
    } else if (p.type === "tool-call") {
      tokens += estimateTokens(JSON.stringify(p.input ?? p.args ?? {})) + 8;
    } else if (p.type === "tool-result") {
      tokens += estimateTokens(extractToolResultText(p.output ?? p.result));
    } else if (p.type === "image" || p.type === "file") {
      tokens += 8000; // conservative estimate for binary content
    }
  }
  return tokens;
}

/** Estimate total tokens for all messages. */
function estimateTotalTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/** Find the index of the first user message (bootstrap boundary). */
export function findFirstUserIndex(messages: ModelMessage[]): number {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user") return i;
  }
  return messages.length;
}

/**
 * Find the cutoff index: tool results at or after this index are protected.
 * Protects the last N assistant messages that contain tool-call parts.
 */
export function findToolAssistantCutoffIndex(
  messages: ModelMessage[],
  keepCount: number = KEEP_LAST_TOOL_ASSISTANTS,
): number {
  let found = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role === "assistant" && Array.isArray(msg.content)) {
      const hasToolCall = msg.content.some((p: any) => p.type === "tool-call");
      if (hasToolCall) {
        found++;
        if (found >= keepCount) return i;
      }
    }
  }
  return 0; // protect everything if fewer than keepCount found
}

/**
 * Check if a tool result starts with [Error] — these should not be hard-cleared.
 * Coupled to the format produced by wrapToolsWithErrorHandling in loop.ts.
 */
function isErrorResult(text: string): boolean {
  return text.startsWith("[Error]");
}

// ── Core pruning ───────────────────────────────────────────────────────

/**
 * Soft-trim a single tool-result text: keep head + tail, replace middle.
 */
export function softTrimText(
  text: string,
  headChars: number = SOFT_TRIM_HEAD_CHARS,
  tailChars: number = SOFT_TRIM_TAIL_CHARS,
): string {
  if (text.length <= headChars + tailChars) return text;
  const head = text.slice(0, headChars);
  const tail = text.slice(-tailChars);
  const trimmedCount = text.length - headChars - tailChars;
  return `${head}\n[...trimmed ${trimmedCount} chars...]\n${tail}`;
}

/**
 * Deep-clone and soft-trim tool results in a single tool message.
 * Returns the new message and count of trimmed parts.
 */
function softTrimToolMessage(msg: ModelMessage): { message: ModelMessage; trimCount: number } {
  if (!Array.isArray(msg.content)) return { message: msg, trimCount: 0 };

  let trimCount = 0;
  const newContent = msg.content.map((part: any) => {
    if (part.type !== "tool-result") return part;

    const text = extractToolResultText(part.output ?? part.result);
    if (text.length <= SOFT_TRIM_MAX_CHARS) return part;

    const trimmed = softTrimText(text);
    trimCount++;

    // Reconstruct with the same output shape
    if (part.output != null && typeof part.output === "object" && "type" in part.output) {
      return { ...part, output: { type: "text", value: trimmed } };
    }
    if ("result" in part) {
      return { ...part, result: trimmed };
    }
    return { ...part, output: trimmed };
  });

  return { message: { ...msg, content: newContent }, trimCount };
}

/**
 * Replace a tool message's content with a placeholder.
 * Preserves toolCallId and toolName for each part.
 * Uses originalChars map to report pre-soft-trim sizes when available.
 */
function hardClearToolMessage(msg: ModelMessage, originalChars?: Map<string, number>): ModelMessage {
  if (!Array.isArray(msg.content)) return msg;

  const newContent = msg.content.map((part: any) => {
    if (part.type !== "tool-result") return part;

    const toolName = part.toolName ?? "unknown";
    const toolCallId = part.toolCallId ?? "";
    const charCount = originalChars?.get(toolCallId)
      ?? extractToolResultText(part.output ?? part.result).length;
    const placeholder = `[Tool result cleared: ${toolName}, ${charCount} chars]`;

    if (part.output != null && typeof part.output === "object" && "type" in part.output) {
      return { ...part, output: { type: "text", value: placeholder } };
    }
    if ("result" in part) {
      return { ...part, result: placeholder };
    }
    return { ...part, output: placeholder };
  });

  return { ...msg, content: newContent };
}

/** Check if all tool-result parts in a message are error results (should not be hard-cleared). */
function hasOnlyErrorResults(msg: ModelMessage): boolean {
  if (!Array.isArray(msg.content)) return false;
  const toolParts = msg.content.filter((p: any) => p.type === "tool-result");
  if (toolParts.length === 0) return false;
  return toolParts.every((part: any) => {
    const text = extractToolResultText(part.output ?? part.result);
    return isErrorResult(text);
  });
}

// ── Main entry point ───────────────────────────────────────────────────

/**
 * Prune tool results in messages to fit within the context window.
 * Never mutates the input. Returns the same reference when no pruning is needed,
 * or a shallow copy with modified tool messages when pruning occurs.
 *
 * Called before each generateText() invocation inside the agent loop.
 */
export function pruneContextMessages(
  messages: ModelMessage[],
  options?: PruneOptions,
): { messages: ModelMessage[]; stats: PruningStats } {
  const contextWindowTokens = options?.contextWindowTokens ?? 128_000;

  const tokensBefore = estimateTotalTokens(messages);
  const ratio = tokensBefore / contextWindowTokens;

  // No pruning needed
  if (ratio < SOFT_TRIM_RATIO) {
    return {
      messages,
      stats: {
        softTrimmed: 0,
        hardCleared: 0,
        estimatedTokensBefore: tokensBefore,
        estimatedTokensAfter: tokensBefore,
      },
    };
  }

  // Determine prunable range
  const firstUserIdx = findFirstUserIndex(messages);
  const cutoffIdx = findToolAssistantCutoffIndex(messages);
  // Prunable range: [firstUserIdx, cutoffIdx)
  // Messages before firstUserIdx are bootstrap-protected
  // Messages at or after cutoffIdx are recent-protected

  let result = [...messages];
  let softTrimmed = 0;
  let hardCleared = 0;

  // Record original char counts before any modification (for hard-clear placeholders)
  const originalChars = new Map<string, number>();
  for (let i = firstUserIdx; i < cutoffIdx; i++) {
    if (result[i].role !== "tool" || !Array.isArray(result[i].content)) continue;
    for (const part of result[i].content as any[]) {
      if (part.type === "tool-result" && part.toolCallId) {
        originalChars.set(part.toolCallId, extractToolResultText(part.output ?? part.result).length);
      }
    }
  }

  // ── Phase 1: Soft-trim ───────────────────────────────────────────────
  for (let i = firstUserIdx; i < cutoffIdx; i++) {
    if (result[i].role !== "tool") continue;
    const { message, trimCount } = softTrimToolMessage(result[i]);
    if (trimCount > 0) {
      result[i] = message;
      softTrimmed += trimCount;
    }
  }

  // ── Phase 2: Hard-clear (if still over threshold) ────────────────────
  const tokensAfterSoftTrim = estimateTotalTokens(result);
  const ratioAfterSoftTrim = tokensAfterSoftTrim / contextWindowTokens;

  if (ratioAfterSoftTrim >= HARD_CLEAR_RATIO) {
    // Clear from oldest to newest until we drop below threshold.
    // Track running token total to avoid O(n²) re-estimation.
    let runningTokens = tokensAfterSoftTrim;
    for (let i = firstUserIdx; i < cutoffIdx; i++) {
      if (result[i].role !== "tool") continue;
      // Skip error results — they carry important semantic info
      if (hasOnlyErrorResults(result[i])) continue;

      const tokensBefore = estimateMessageTokens(result[i]);
      result[i] = hardClearToolMessage(result[i], originalChars);
      const tokensAfter = estimateMessageTokens(result[i]);
      runningTokens += tokensAfter - tokensBefore;
      hardCleared++;

      if (runningTokens / contextWindowTokens < HARD_CLEAR_RATIO) break;
    }
  }

  const tokensAfter = estimateTotalTokens(result);

  return {
    messages: result,
    stats: {
      softTrimmed,
      hardCleared,
      estimatedTokensBefore: tokensBefore,
      estimatedTokensAfter: tokensAfter,
    },
  };
}

import { generateText, stepCountIs } from "ai";
import type { LanguageModel, ModelMessage, ToolSet } from "ai";
import { withRetry, isRetryableError } from "../utils/retry";
import type { Logger, SkillCall, SkillToolCall } from "../utils/logger";
import { buildCachedSystemPrompt } from "../providers/cache";
import { pruneContextMessages } from "./context-pruning";

/** Maximum length of tool result text stored in the assistant's toolCalls JSON. */
export const TOOL_RESULT_MAX_LENGTH = 500;

/** Per-step timeout: 90 seconds. Covers LLM reasoning (~15-60s) + tool execution (~1-60s). */
const STEP_TIMEOUT_MS = 90_000;

/**
 * Combine a per-step timeout with an optional parent abort signal.
 * Whichever fires first wins.
 */
function combinedAbortSignal(parentSignal?: AbortSignal): AbortSignal {
  const perCall = AbortSignal.timeout(STEP_TIMEOUT_MS);
  if (!parentSignal) return perCall;
  return AbortSignal.any([parentSignal, perCall]);
}

/**
 * A message in storable format, matching nanobot's message structure.
 */
export interface StoredMessage {
  role: string;
  content: string | null;
  botId?: string;
  attachments?: string | null; // JSON array of {r2Key, mediaType} for assistant attachments
  toolCalls?: string | null; // JSON array of {toolCallId, toolName, input}
  requestId?: string;
  // In-memory only fields (for tool result matching in loop, not persisted to D1)
  toolCallId?: string;
  toolName?: string;
}

export interface LoopResult {
  reply: string;
  iterations: number;
  toolCallsTotal: number;
  newMessages: StoredMessage[];
  inputTokens: number;
  outputTokens: number;
  model?: string;
  /** Skill-grouped tool calls: each skill has its tool call chain */
  skillCalls: SkillCall[];
  /** Content strings from all tool results in this turn */
  toolResults: string[];
}

/**
 * Convert AI SDK ModelMessage[] to StoredMessage[] for persistence.
 * Extracts tool call metadata matching nanobot's format.
 *
 * botId and requestId are injected into each assistant message for D1 persistence.
 * Tool result messages are kept in memory (for loop logging and toolResults extraction)
 * but are filtered out by d1.persistMessages before writing to D1.
 */
export function convertToStoredMessages(
  sdkMessages: ModelMessage[],
  botId?: string,
  requestId?: string
): StoredMessage[] {
  const stored: StoredMessage[] = [];
  // Map toolCallId → index in stored[] for O(1) lookup when merging tool results
  const toolCallOwnerMap = new Map<string, number>();

  for (const msg of sdkMessages) {
    if (msg.role === "assistant") {
      const content = typeof msg.content === "string" ? msg.content : null;
      let textContent = content;
      let toolCalls: Array<{
        toolCallId: string;
        toolName: string;
        input: unknown;
      }> = [];

      if (Array.isArray(msg.content)) {
        const textParts = msg.content
          .filter((p: any) => p.type === "text")
          .map((p: any) => p.text);
        textContent = textParts.length > 0 ? textParts.join("") : null;

        for (const part of msg.content) {
          if ((part as any).type === "tool-call") {
            const tc = part as any;
            toolCalls.push({
              toolCallId: tc.toolCallId,
              toolName: tc.toolName,
              input: tc.args ?? tc.input,
            });
          }
        }
      }

      const assistantIndex = stored.length;
      stored.push({
        role: "assistant",
        content: textContent,
        toolCalls: toolCalls.length > 0 ? JSON.stringify(toolCalls) : null,
        botId,
        requestId,
      });

      // Register each tool call's owning assistant index
      for (const tc of toolCalls) {
        toolCallOwnerMap.set(tc.toolCallId, assistantIndex);
      }
    } else if (msg.role === "tool") {
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if ((part as any).type === "tool-result") {
            const tr = part as any;
            const rawOutput = tr.result ?? tr.output;
            // AI SDK v6: output is { type: "text", value: string } | { type: "json", value: unknown } | ...
            const output =
              rawOutput != null && typeof rawOutput === "object" && "value" in rawOutput
                ? rawOutput.value
                : rawOutput;
            const resultContent =
              typeof output === "string"
                ? output
                : JSON.stringify(output);
            stored.push({
              role: "tool",
              content: resultContent,
              toolCallId: tr.toolCallId,
              toolName: tr.toolName,
            });

            // Merge result back into the owning assistant's toolCalls JSON
            const ownerIndex = toolCallOwnerMap.get(tr.toolCallId);
            if (ownerIndex != null && stored[ownerIndex].toolCalls) {
              try {
                const parsed = JSON.parse(stored[ownerIndex].toolCalls!) as Array<{
                  toolCallId: string;
                  toolName: string;
                  input: unknown;
                  result?: string;
                }>;
                const match = parsed.find((tc) => tc.toolCallId === tr.toolCallId);
                if (match) {
                  match.result = resultContent.slice(0, TOOL_RESULT_MAX_LENGTH);
                  stored[ownerIndex].toolCalls = JSON.stringify(parsed);
                }
              } catch {
                console.warn(`[convertToStoredMessages] Failed to merge tool result for ${tr.toolCallId}`);
              }
            }
          }
        }
      }
    }
  }

  return stored;
}

/**
 * Format tool calls into a human-readable hint string.
 * Matches nanobot's _tool_hint format: toolName("firstArg"), truncated at 40 chars.
 */
export function formatToolHint(
  toolCalls: Array<{ toolName: string; input: unknown }>
): string {
  return toolCalls
    .map((tc) => {
      // Escape underscores to prevent Markdown italic interpretation
      // e.g. send_to_group has two underscores → _to_ becomes italic
      const name = tc.toolName.replace(/_/g, "\\_");
      const args = tc.input as Record<string, unknown> | undefined;
      const firstVal = Object.values(args ?? {})[0];
      if (typeof firstVal !== "string") return name;
      return firstVal.length > 40
        ? `${name}("${firstVal.slice(0, 40)}…")`
        : `${name}("${firstVal}")`;
    })
    .join(", ");
}

/** Per-tool-call timing info recorded during execution inside generateText. */
export interface ToolTiming {
  startedAt: number; // Date.now() when tool started
  durationMs: number; // elapsed ms
}
export type ToolTimings = Map<string, ToolTiming>;

/**
 * Wrap each tool's execute function so that:
 * 1. A hint is sent to the user BEFORE execution starts (immediate feedback).
 * 2. Thrown errors (external faults) are caught and returned as a formatted
 *    string telling the LLM not to retry.
 * Business-logic errors that tools return as strings pass through unchanged.
 */
export function wrapToolsWithErrorHandling(
  tools: ToolSet,
  onToolStart?: (toolName: string, input: unknown) => Promise<void>,
  toolTimings?: ToolTimings,
): ToolSet {
  const wrapped: ToolSet = {};
  for (const [name, t] of Object.entries(tools)) {
    if (!t.execute) {
      wrapped[name] = t;
      continue;
    }
    const orig = t.execute;
    wrapped[name] = {
      ...t,
      execute: async (...args: any[]) => {
        const toolStart = Date.now();
        console.log(`[tool] calling ${name}`);
        // Send hint before execution so user sees immediate feedback
        if (onToolStart) {
          try {
            await onToolStart(name, args[0]);
          } catch (e) {
            console.warn(`[tool] hint send failed for ${name}:`, e);
          }
        }
        try {
          const result = await (orig as any)(...args);
          const elapsed = Date.now() - toolStart;
          console.log(`[tool] ${name} completed (${elapsed}ms)`);
          // Record timing by toolCallId if available (AI SDK passes it as args[1])
          const toolCallId = args[1]?.toolCallId as string | undefined;
          if (toolTimings && toolCallId) toolTimings.set(toolCallId, { startedAt: toolStart, durationMs: elapsed });
          return result;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          const elapsed = Date.now() - toolStart;
          console.log(`[tool] ${name} error (${elapsed}ms): ${msg.slice(0, 100)}`);
          const toolCallId = args[1]?.toolCallId as string | undefined;
          if (toolTimings && toolCallId) toolTimings.set(toolCallId, { startedAt: toolStart, durationMs: elapsed });
          return `[Error] ${msg}\n\nThis tool call failed. Do not retry automatically. Tell the user what happened and let them decide.`;
        }
      },
    } as any;
  }
  return wrapped;
}

/**
 * Normalize ModelMessage content to an array of content parts.
 * Handles string, array, and edge cases uniformly.
 */
function contentToArray(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "text", text: content }] : [];
  }
  if (Array.isArray(content)) {
    return content;
  }
  return [];
}

/**
 * Check whether a content array contains any tool-call parts.
 */
function hasToolCallParts(parts: Array<Record<string, unknown>>): boolean {
  return parts.some((p) => p.type === "tool-call");
}

/**
 * Merge consecutive same-role messages to ensure strict role alternation.
 * Gemini requires strict user/model alternation and rejects consecutive same-role messages.
 * Other providers (Claude, GPT) tolerate them but benefit from cleaner input.
 *
 * User messages: text parts joined with "\n\n", non-text parts (images) preserved in order.
 * Assistant messages: text-only messages merged with "\n\n". Messages with tool-call parts
 * are NOT merged into (tool-calls should stay as distinct turns for proper tool result pairing).
 * An assistant message with tool-calls that has no preceding tool result is malformed — left as-is.
 */
export function mergeConsecutiveMessages(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length <= 1) return messages;

  const result: ModelMessage[] = [];

  for (const msg of messages) {
    const prev = result[result.length - 1];

    // --- Merge consecutive user messages ---
    if (prev && prev.role === "user" && msg.role === "user") {
      const prevParts = contentToArray(prev.content);
      const currParts = contentToArray(msg.content);

      if (currParts.length === 0) continue;
      if (prevParts.length === 0) {
        result[result.length - 1] = { ...msg };
        continue;
      }

      const prevAllText = prevParts.every((p) => p.type === "text");
      const currAllText = currParts.every((p) => p.type === "text");

      let mergedContent: unknown;
      if (prevAllText && currAllText) {
        const prevText = prevParts.map((p) => p.text).join("");
        const currText = currParts.map((p) => p.text).join("");
        mergedContent = [{ type: "text", text: `${prevText}\n\n${currText}` }];
      } else {
        mergedContent = [...prevParts, ...currParts];
      }
      result[result.length - 1] = { ...prev, content: mergedContent as any };
      continue;
    }

    // --- Merge consecutive assistant messages (text-only) ---
    if (prev && prev.role === "assistant" && msg.role === "assistant") {
      const prevParts = contentToArray(prev.content);
      const currParts = contentToArray(msg.content);

      // Never merge INTO a message that has tool-call parts (it needs its own tool result)
      if (hasToolCallParts(prevParts)) {
        result.push({ ...msg });
        continue;
      }
      // Never merge a message that has tool-call parts into a text message
      // (tool-call after plain assistant text is malformed — leave as-is for debugging)
      if (hasToolCallParts(currParts)) {
        result.push({ ...msg });
        continue;
      }

      // Both are text-only assistant messages — safe to merge
      if (currParts.length === 0) continue;
      if (prevParts.length === 0) {
        result[result.length - 1] = { ...msg };
        continue;
      }

      const prevAllText = prevParts.every((p) => p.type === "text");
      const currAllText = currParts.every((p) => p.type === "text");

      let mergedContent: unknown;
      if (prevAllText && currAllText) {
        const prevText = prevParts.map((p) => p.text).join("");
        const currText = currParts.map((p) => p.text).join("");
        mergedContent = [{ type: "text", text: `${prevText}\n\n${currText}` }];
      } else {
        // Mixed content (text + non-text parts): concatenate arrays to preserve all parts
        mergedContent = [...prevParts, ...currParts];
      }
      result[result.length - 1] = { ...prev, content: mergedContent as any };
      continue;
    }

    result.push({ ...msg });
  }

  return result;
}

/** @deprecated Use mergeConsecutiveMessages instead */
export const mergeConsecutiveUserMessages = mergeConsecutiveMessages;

export async function runAgentLoop(params: {
  model: LanguageModel;
  systemPrompt: string;
  userMessage: string;
  conversationHistory: ModelMessage[];
  tools: ToolSet;
  maxIterations: number;
  onProgress?: (text: string) => Promise<void>;
  /** When false, skip sending tool execution hints via onProgress. Default true. */
  sendToolHints?: boolean;
  log?: Logger;
  botId?: string;
  requestId?: string;
  /** Multimodal content parts from user attachments (images, files, inline text). */
  attachmentParts?: Array<
    | { type: "image"; image: Uint8Array; mediaType: string }
    | { type: "file"; data: Uint8Array; mediaType: string }
    | { type: "text"; text: string }
  >;
  /** Annotation text listing sandbox file paths (not persisted to D1, injected per-turn only). */
  sandboxAnnotation?: string;
  /** When false, skip appending userMessage as current turn (D1 history already has it). */
  appendUserTurn?: boolean;
  /** Abort signal for cancelling the loop (e.g. overall request timeout). */
  abortSignal?: AbortSignal;
  /** Model context window size in tokens (for context pruning). Default 128000. */
  contextWindowTokens?: number;
}): Promise<LoopResult> {
  const { model, systemPrompt, userMessage, maxIterations } = params;
  const appendUserTurn = params.appendUserTurn ?? true;
  // Safe wrapper for onProgress — best-effort, never throws.
  // Used by both tool-hint sends and intermediate-text sends.
  const safeOnProgress = params.onProgress
    ? async (text: string) => {
        try {
          await params.onProgress!(text);
        } catch (e) {
          params.log?.warn("onProgress send failed", { error: String(e) });
        }
      }
    : undefined;
  // Build onToolStart callback: sends hint to user when a tool begins executing
  // (inside generateText, before the tool runs — not after it completes).
  const onToolStart = (safeOnProgress && (params.sendToolHints ?? true))
    ? async (toolName: string, input: unknown) => {
        const hint = formatToolHint([{ toolName, input }]);
        await safeOnProgress(hint);
      }
    : undefined;
  const toolTimings: ToolTimings = new Map();
  const tools = wrapToolsWithErrorHandling(params.tools, onToolStart, toolTimings);

  // Build system prompt with Anthropic cache control when applicable
  const { system, systemMessages } = buildCachedSystemPrompt(model, systemPrompt);

  const rawMessages: ModelMessage[] = [
    ...systemMessages,
    ...params.conversationHistory,
  ];

  if (appendUserTurn) {
    // Build user message content: text + optional attachment parts (images, files, inline text)
    // Skip empty text part to avoid "text content blocks must be non empty" errors (e.g. pure-image messages)
    type AttachmentPart = NonNullable<typeof params.attachmentParts>[number];
    const userContent: Array<{ type: "text"; text: string } | AttachmentPart> = [];
    if (userMessage.trim().length > 0) {
      userContent.push({ type: "text", text: userMessage });
    }
    if (params.attachmentParts?.length) {
      userContent.push(...params.attachmentParts);
    }
    // Append sandbox file paths annotation (not persisted to D1 — current turn only)
    if (params.sandboxAnnotation) {
      userContent.push({ type: "text", text: params.sandboxAnnotation });
    }
    // Fallback: if no content at all (no text, no attachments), add the original text to avoid empty content
    if (userContent.length === 0) {
      userContent.push({ type: "text", text: userMessage });
    }
    rawMessages.push({ role: "user", content: userContent as any });
  }

  // Merge consecutive same-role messages before sending to LLM
  // (Gemini requires strict user/model alternation)
  const messages: ModelMessage[] = mergeConsecutiveMessages(rawMessages);

  let iterations = 0;
  let toolCallsTotal = 0;
  const allNewMessages: StoredMessage[] = [];
  // Accumulate final-answer text (iterations without tool calls)
  let accumulatedText = "";
  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let lastModel: string | undefined;
  let currentSkill = "";
  const skillCallsMap = new Map<string, SkillToolCall[]>();
  // Guard: only retry once after provider content-filter, to avoid loops
  let contentFilterRetried = false;

  const { log } = params;

  while (iterations < maxIterations) {
    iterations++;

    // Prune tool results to fit context window before each LLM call
    const { messages: prunedMessages, stats: pruneStats } = pruneContextMessages(
      messages,
      { contextWindowTokens: params.contextWindowTokens },
    );
    if (pruneStats.softTrimmed > 0 || pruneStats.hardCleared > 0) {
      console.log(
        `[prune] soft-trimmed: ${pruneStats.softTrimmed}, hard-cleared: ${pruneStats.hardCleared}, ` +
        `tokens: ${pruneStats.estimatedTokensBefore} → ${pruneStats.estimatedTokensAfter}`
      );
      log?.info("Context pruning", {
        iteration: iterations,
        softTrimmed: pruneStats.softTrimmed,
        hardCleared: pruneStats.hardCleared,
        estimatedTokensBefore: pruneStats.estimatedTokensBefore,
        estimatedTokensAfter: pruneStats.estimatedTokensAfter,
      });
    }

    log?.info("Starting LLM call", { iteration: iterations, messageCount: prunedMessages.length });
    console.log(`[LLM] starting call (iteration ${iterations}, ${prunedMessages.length} messages)`);

    const t0 = performance.now();
    const result = await withRetry(
      () =>
        generateText({
          model,
          ...(system ? { system } : {}),
          messages: prunedMessages,
          tools,
          stopWhen: stepCountIs(1),
          maxRetries: 0,
          abortSignal: combinedAbortSignal(params.abortSignal),
        }),
      { retryIf: isRetryableError }
    );
    const durationMs = Math.round(performance.now() - t0);
    console.log(`[LLM] response received (${durationMs}ms), tool_calls: ${result.toolCalls?.length ?? 0}`);

    const promptTokens = result.usage?.inputTokens ?? 0;
    const completionTokens = result.usage?.outputTokens ?? 0;
    totalInputTokens += promptTokens;
    totalOutputTokens += completionTokens;
    lastModel = result.response?.modelId ?? lastModel;

    // Convert and collect intermediate messages for persistence
    const newMessages = convertToStoredMessages(result.response.messages, params.botId, params.requestId);
    allNewMessages.push(...newMessages);

    // Append response messages to conversation (AI SDK format)
    messages.push(...result.response.messages);

    // Compute tool execution time from toolTimings map, then derive pure LLM reasoning time
    let toolsDurationMs = 0;
    for (const tc of (result.toolCalls ?? [])) {
      toolsDurationMs += toolTimings.get(tc.toolCallId)?.durationMs ?? 0;
    }
    const llmDurationMs = Math.max(0, durationMs - toolsDurationMs);
    // Find the earliest tool start time for the "Tool calls" log timestamp
    let toolCallsTs: number | undefined;
    for (const tc of (result.toolCalls ?? [])) {
      const timing = toolTimings.get(tc.toolCallId);
      if (timing && (toolCallsTs === undefined || timing.startedAt < toolCallsTs)) {
        toolCallsTs = timing.startedAt;
      }
    }

    // Text with tool calls + onProgress: send immediately via onProgress (single-bot chat)
    // Text with tool calls but no onProgress: accumulate into reply (group chat)
    // Text without tool calls: accumulate into reply (final answer)
    if (result.text) {
      if (result.toolCalls?.length && safeOnProgress) {
        await safeOnProgress(result.text);
      } else {
        accumulatedText = accumulatedText
          ? `${accumulatedText}\n\n${result.text}`
          : result.text;
      }
    }

    if (result.toolCalls?.length) {
      toolCallsTotal += result.toolCalls.length;
      for (const tc of result.toolCalls) {
        // Detect skill activation via load_skill tool
        if (tc.toolName === "load_skill") {
          const skillName = (tc.input as { name?: string })?.name;
          if (skillName) currentSkill = skillName;
        }

        // Find matching tool result from stored messages
        const resultMsg = newMessages.find(
          (m) => m.role === "tool" && m.toolCallId === tc.toolCallId
        );
        const resultContent = (resultMsg?.content ?? "").slice(0, 200);

        const toolCall: SkillToolCall = {
          name: tc.toolName,
          input: JSON.stringify(tc.input)?.slice(0, 200) ?? "",
          result: resultContent,
          isError: resultContent.startsWith("[Error]"),
        };

        if (!skillCallsMap.has(currentSkill)) skillCallsMap.set(currentSkill, []);
        skillCallsMap.get(currentSkill)!.push(toolCall);
      }

      // Log tool call details with actual execution timestamp
      log?.info("Tool calls", {
        iteration: iterations,
        toolCallDetails: result.toolCalls.map((tc) => {
          const resultMsg = newMessages.find(
            (m) => m.role === "tool" && m.toolCallId === tc.toolCallId
          );
          return {
            toolName: tc.toolName,
            input: JSON.stringify(tc.input)?.slice(0, 500),
            result: (resultMsg?.content ?? "")?.slice(0, 500),
            durationMs: toolTimings.get(tc.toolCallId)?.durationMs,
          };
        }),
      }, toolCallsTs);

      // Separate log for exec tool results (easier to query, longer output)
      for (const tc of result.toolCalls) {
        if (tc.toolName !== "exec") continue;
        const resultMsg = newMessages.find(
          (m) => m.role === "tool" && m.toolCallId === tc.toolCallId
        );
        const input = tc.input as { command?: string };
        const execTiming = toolTimings.get(tc.toolCallId);
        const execEndTs = execTiming ? execTiming.startedAt + execTiming.durationMs : undefined;
        log?.info("Exec result", {
          iteration: iterations,
          command: input.command?.slice(0, 300),
          result: (resultMsg?.content ?? "").slice(0, 2000),
          exitedOk: !(resultMsg?.content ?? "").includes("Exit code:"),
        }, execEndTs);
      }

      // Tool hints are now sent inside wrapToolsWithErrorHandling (onToolStart)
      // before each tool executes, giving the user immediate feedback.
    }

    // Log LLM response AFTER tool details so trace order is:
    // Starting LLM call → Tool calls → Exec result → LLM response
    log?.info("LLM response", {
      iteration: iterations,
      finishReason: result.finishReason,
      promptTokens,
      completionTokens,
      model: result.response?.modelId,
      durationMs,
      llmDurationMs,
      toolsDurationMs,
      hasToolCalls: (result.toolCalls?.length ?? 0) > 0,
    });

    // Clear timings unconditionally — they've been consumed by Tool calls + LLM response logs
    toolTimings.clear();

    // Provider content filter produced an empty reply.
    // Mirror the image-tool-error pattern: feed the event back as a system
    // notice and let the LLM generate a natural, language-appropriate reply
    // on the next iteration. Capped to one retry to prevent loops.
    if (
      result.finishReason === "content-filter" &&
      !accumulatedText.trim() &&
      !contentFilterRetried
    ) {
      contentFilterRetried = true;
      log?.warn("Provider content-filter hit, retrying with system notice", {
        iteration: iterations,
      });
      // Roll back the empty filtered response from persistence and LLM context
      // so D1 does not accumulate null-content assistant rows and the retry
      // sees a clean turn ending at the user's original message.
      allNewMessages.length -= newMessages.length;
      messages.length -= result.response.messages.length;
      messages.push({
        role: "user",
        content:
          "[System notice: Your previous reply was blocked by the model provider's content filter and was not delivered to the user. Briefly acknowledge this to the user in the same language they are using and suggest they rephrase. Do NOT attempt to reproduce the blocked content.]",
      });
      continue;
    }

    // If no more tool calls, we have the final answer
    if (result.finishReason !== "tool-calls") {
      const toolResults = allNewMessages
        .filter(m => m.role === "tool" && m.content)
        .map(m => m.content!);
      const skillCalls: SkillCall[] = [];
      for (const [skill, tools] of skillCallsMap) {
        skillCalls.push({ skill, tools });
      }
      return {
        reply: accumulatedText,
        iterations,
        toolCallsTotal,
        newMessages: allNewMessages,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        model: lastModel,
        skillCalls,
        toolResults,
      };
    }
  }

  const toolResults = allNewMessages
    .filter(m => m.role === "tool" && m.content)
    .map(m => m.content!);
  const skillCalls: SkillCall[] = [];
  for (const [skill, tools] of skillCallsMap) {
    skillCalls.push({ skill, tools });
  }
  return {
    reply: accumulatedText || "I've reached my thinking limit for this request.",
    iterations,
    toolCallsTotal,
    newMessages: allNewMessages,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    model: lastModel,
    skillCalls,
    toolResults,
  };
}

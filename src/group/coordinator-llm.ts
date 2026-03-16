/**
 * Orchestrator LLM call logic extracted from ChatCoordinator.executeTurn().
 * Pure refactoring — no behavior changes.
 */

import { generateObject } from "ai";
import type { LanguageModel } from "ai";
import { withRetry, isRetryableError } from "../utils/retry";
import { DispatchResultSchema, ContinueResultSchema } from "./handler";
import type { Logger } from "../utils/logger";
import type { GroupChatTrace } from "./handler";
import { ORCHESTRATOR_TIMEOUT_MS, fallbackDispatch } from "./coordinator-utils";

export interface OrchestratorDispatchResult {
  waves: string[][];
  traceDecision: GroupChatTrace["decisions"][number];
  inputTokens: number;
  outputTokens: number;
}

/**
 * Call orchestrator LLM to decide which bots should respond (first call).
 * Includes timeout, retry, validation, mention enforcement, sender exclusion, and fallback.
 */
export async function callOrchestratorDispatch(params: {
  model: LanguageModel;
  systemPrompt: string;
  userPrompt: string;
  botConfigs: { name: string; botId: string }[];
  mentionedNames: string[];
  senderBotId?: string;
  log: Logger;
}): Promise<OrchestratorDispatchResult> {
  const { model, systemPrompt, userPrompt, botConfigs, mentionedNames, senderBotId, log } = params;

  const availableBotNames = new Set(botConfigs.map(b => b.name));
  const orchStart = performance.now();
  let orchTimeoutId: ReturnType<typeof setTimeout>;
  let waves: string[][];

  try {
    const orchTimeout = new Promise<never>((_, reject) => {
      orchTimeoutId = setTimeout(
        () => reject(new Error(`Orchestrator LLM timed out after ${ORCHESTRATOR_TIMEOUT_MS / 1000}s`)),
        ORCHESTRATOR_TIMEOUT_MS,
      );
    });
    const firstResult = await Promise.race([
      withRetry(
        () => generateObject({
          model,
          schema: DispatchResultSchema,
          system: systemPrompt,
          prompt: userPrompt,
          maxRetries: 0,
        }),
        { retryIf: isRetryableError },
      ),
      orchTimeout,
    ]);
    clearTimeout(orchTimeoutId!);
    const orchDuration = Math.round(performance.now() - orchStart);

    // Normalize waves: trim names, validate against actual bot list, filter empty waves
    waves = firstResult.object.respondents
      .map(wave => wave.map(n => n.trim()).filter(n => availableBotNames.has(n)))
      .filter(wave => wave.length > 0);

    // Ensure mentioned bots are included (add to wave 1 if missing)
    const allRespondentNames = new Set(waves.flat());
    const missingMentioned = mentionedNames.filter(n => !allRespondentNames.has(n));
    if (missingMentioned.length > 0) {
      if (waves.length === 0) {
        waves = [missingMentioned];
      } else {
        waves[0] = [...missingMentioned, ...waves[0].filter(n => !missingMentioned.includes(n))];
      }
    }

    // Exclude sender bot from respondents
    if (senderBotId) {
      waves = waves
        .map(wave => wave.filter(name => {
          const bot = botConfigs.find(b => b.name === name);
          return !bot || bot.botId !== senderBotId;
        }))
        .filter(wave => wave.length > 0);
    }

    log.info("Orchestrator dispatch", { reasoning: firstResult.object.reasoning, waves, userMessage: userPrompt, orchestratorDurationMs: orchDuration });

    return {
      waves,
      traceDecision: {
        round: 1,
        respondents: waves,
        reasoning: firstResult.object.reasoning,
        orchestratorDurationMs: orchDuration,
      },
      inputTokens: firstResult.usage?.inputTokens ?? 0,
      outputTokens: firstResult.usage?.outputTokens ?? 0,
    };
  } catch (e) {
    clearTimeout(orchTimeoutId!);
    const orchDuration = Math.round(performance.now() - orchStart);
    log.error("Orchestrator LLM failed, using fallback", { error: String(e), orchestratorDurationMs: orchDuration });
    waves = fallbackDispatch(botConfigs, mentionedNames, undefined, senderBotId);
    return {
      waves,
      traceDecision: {
        round: 1,
        respondents: waves,
        reasoning: `[fallback] orchestrator LLM error: ${String(e).slice(0, 200)}`,
        orchestratorDurationMs: orchDuration,
      },
      inputTokens: 0,
      outputTokens: 0,
    };
  }
}

/**
 * Call orchestrator LLM to evaluate whether conversation should continue (rounds 2+).
 * Returns null on timeout/error (caller should stop the interaction loop).
 */
export async function callOrchestratorContinue(params: {
  model: LanguageModel;
  systemPrompt: string;
  log: Logger;
  round: number;
}): Promise<
  | { ok: true; result: typeof ContinueResultSchema._type; orchDurationMs: number; inputTokens: number; outputTokens: number }
  | { ok: false; orchDurationMs: number; error: string }
> {
  const { model, systemPrompt, log, round } = params;

  const orchStart = performance.now();
  let orchTimeoutId: ReturnType<typeof setTimeout>;
  try {
    const orchTimeout = new Promise<never>((_, reject) => {
      orchTimeoutId = setTimeout(
        () => reject(new Error(`Orchestrator continue-eval timed out after ${ORCHESTRATOR_TIMEOUT_MS / 1000}s`)),
        ORCHESTRATOR_TIMEOUT_MS,
      );
    });
    const continueResult = await Promise.race([
      withRetry(
        () => generateObject({
          model,
          schema: ContinueResultSchema,
          system: systemPrompt,
          prompt: "Evaluate the replies above. Determine whether the discussion should continue.",
          maxRetries: 0,
        }),
        { retryIf: isRetryableError },
      ),
      orchTimeout,
    ]);
    clearTimeout(orchTimeoutId!);
    return {
      ok: true,
      result: continueResult.object,
      orchDurationMs: Math.round(performance.now() - orchStart),
      inputTokens: continueResult.usage?.inputTokens ?? 0,
      outputTokens: continueResult.usage?.outputTokens ?? 0,
    };
  } catch (e) {
    clearTimeout(orchTimeoutId!);
    const orchDuration = Math.round(performance.now() - orchStart);
    log.error("Orchestrator continue-eval failed, stopping", { round, error: String(e) });
    return {
      ok: false,
      orchDurationMs: orchDuration,
      error: String(e),
    };
  }
}

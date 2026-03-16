/**
 * Concurrency and dispatch utilities for ChatCoordinator.
 */

export const GROUP_BOT_TIMEOUT_MS = 60_000;
export const ORCHESTRATOR_TIMEOUT_MS = 30_000;
/** Hard wall-clock budget for the entire executeTurn — must be below CF DO eviction threshold (~104s observed). */
export const TURN_DEADLINE_MS = 85_000;
/** Max times a single bot can respond per user turn (defense-in-depth) */
export const MAX_BOT_REPLIES_PER_TURN = 2;

/**
 * Promise-chain mutex — ensures async tasks run one at a time, in FIFO order.
 */
export class TurnSerializer {
  private chain: Promise<void> = Promise.resolve();

  enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.chain.then(fn, fn);
    this.chain = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}

/**
 * Monotonic epoch counter — used for stale-turn detection.
 * Each bump() returns a new epoch; callers snapshot the value and later
 * check isStale() to see if a newer turn has arrived.
 */
export class EpochTracker {
  private epoch = 0;

  bump(): number {
    return ++this.epoch;
  }

  current(): number {
    return this.epoch;
  }

  isStale(snapshot: number): boolean {
    return snapshot !== this.epoch;
  }
}

/**
 * Build a case-insensitive name resolver from a set of canonical bot names.
 */
function buildNameResolver(availableBotNames: Set<string>): (raw: string) => string | undefined {
  const map = new Map<string, string>();
  for (const name of availableBotNames) map.set(name.toLowerCase(), name);
  return (raw: string) => map.get(raw.trim().toLowerCase());
}

/**
 * Apply guard logic to continue-eval result.
 * Normalizes respondents (case-insensitive), enforces consistency between
 * shouldContinue and respondents, and limits follow-up respondents to one.
 */
export function applyContinueGuard(
  result: {
    shouldContinue: boolean;
    respondents: string[];
  },
  availableBotNames: Set<string>,
): { shouldContinue: boolean; respondents: string[] } {
  const resolve = buildNameResolver(availableBotNames);

  let respondents = result.respondents
    .map(n => resolve(n))
    .filter((n): n is string => n !== undefined);
  // Deduplicate (case variants may resolve to same name)
  respondents = [...new Set(respondents)];

  let shouldContinue = result.shouldContinue;

  // Enforce consistency: stop → clear respondents, continue without respondents → stop
  if (!shouldContinue) {
    respondents = [];
  } else if (respondents.length === 0) {
    shouldContinue = false;
  }

  // Limit follow-up respondents to 1 (match prompt guidance)
  if (respondents.length > 1) {
    respondents = [respondents[0]];
  }

  return { shouldContinue, respondents };
}

/**
 * Try to determine dispatch without LLM when the routing decision is obvious.
 * Returns waves if fast-path applies, or null to fall through to LLM dispatch.
 *
 * Fast-path cases:
 * 1. Explicit mentions (including reply-to-bot) → dispatch mentioned bots
 * 2. Single bot in group → dispatch that bot
 *
 * Note: mentionedNames must be in canonical casing (from resolveExplicitMentions /
 * parseMentions / replyToName resolution — all resolve to botConfig.name).
 */
export function tryFastDispatch(
  bots: { name: string; botId: string }[],
  mentionedNames: string[],
  senderBotId?: string,
): string[][] | null {
  const available = senderBotId
    ? bots.filter((b) => b.botId !== senderBotId)
    : bots;

  if (available.length === 0) return null;

  // Case 1: Explicit mentions — dispatch mentioned bots only
  if (mentionedNames.length > 0) {
    const mentioned = mentionedNames.filter((n) => available.some((b) => b.name === n));
    if (mentioned.length > 0) return [mentioned];
  }

  // Case 2: Single available bot after exclusion — no routing decision needed
  if (available.length === 1) return [[available[0].name]];

  // Ambiguous — fall through to LLM dispatch
  return null;
}

/**
 * Determine which bots should respond (and in what waves) when the LLM
 * orchestrator result is missing or invalid.
 *
 * @param bots       All bots in the group
 * @param mentionedNames  Bot names explicitly @-mentioned in the user message
 * @param llmResult  Waves returned by the LLM orchestrator (may be undefined)
 * @param senderBotId  If the message was sent by a bot, exclude it from responding
 * @returns Waves of bot names, e.g. [["Alice"], ["Bob"]]
 */
/**
 * Given the requestIds of successfully replied bots in a wave/round,
 * pick the parentRequestId for the next wave/round.
 *
 * - Exactly 1 → chain through that bot's requestId
 * - 0 or 2+ → undefined (falls back to coordinator's own requestId)
 */
export function pickNextParentRequestId(successRequestIds: string[]): string | undefined {
  return successRequestIds.length === 1 ? successRequestIds[0] : undefined;
}

export function fallbackDispatch(
  bots: { name: string; botId: string }[],
  mentionedNames: string[],
  llmResult: string[][] | undefined,
  senderBotId?: string,
): string[][] {
  const available = senderBotId
    ? bots.filter((b) => b.botId !== senderBotId)
    : bots;

  // LLM returned valid non-empty waves — pass through, but normalize names against bot list
  if (llmResult && llmResult.length > 0 && llmResult.some((w) => w.length > 0)) {
    const normalized = llmResult
      .map((w) => w.filter((n) => available.some((b) => b.name === n)))
      .filter((w) => w.length > 0);
    if (normalized.length > 0) return normalized;
    // All names invalid — fall through to fallback
  }

  // Fallback: mentioned bots or all bots
  if (mentionedNames.length > 0) {
    const mentioned = mentionedNames.filter((n) => available.some((b) => b.name === n));
    return mentioned.length > 0 ? [mentioned] : [available.map((b) => b.name)];
  }

  return [available.map((b) => b.name)];
}

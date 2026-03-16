/**
 * Sub-agent run tracking via Durable Object storage.
 * Runtime state for drain scheduling; D1 is the durable record.
 */

import type { SubagentRun } from "./subagent-types";
import { SUBAGENT_RUN_PREFIX, SESSION_EPOCH_PREFIX } from "./subagent-types";

type Storage = DurableObjectStorage;

// -- Run CRUD --

export async function getSubagentRun(storage: Storage, runId: string): Promise<SubagentRun | undefined> {
  return storage.get<SubagentRun>(`${SUBAGENT_RUN_PREFIX}${runId}`);
}

export async function putSubagentRun(storage: Storage, run: SubagentRun): Promise<void> {
  await storage.put(`${SUBAGENT_RUN_PREFIX}${run.runId}`, run);
}

export async function deleteSubagentRun(storage: Storage, runId: string): Promise<void> {
  await storage.delete(`${SUBAGENT_RUN_PREFIX}${runId}`);
}

// -- Queries --

export async function listRunsByParentSession(
  storage: Storage,
  parentSessionId: string,
): Promise<SubagentRun[]> {
  const all = await storage.list<SubagentRun>({ prefix: SUBAGENT_RUN_PREFIX });
  const runs: SubagentRun[] = [];
  for (const [, run] of all) {
    if (run.parentSessionId === parentSessionId) runs.push(run);
  }
  return runs;
}

export async function countActiveChildren(
  storage: Storage,
  parentSessionId: string,
): Promise<number> {
  const runs = await listRunsByParentSession(storage, parentSessionId);
  return runs.filter(r => r.status === "running").length;
}

/**
 * Claim all completed/error/timeout runs for a parent session and remove them from DO storage.
 * Only claims runs matching the current session epoch (stale results are dropped).
 */
/**
 * Collect all completed/error/timeout runs for a parent session.
 * Only returns runs matching the current session epoch (stale results are dropped from storage).
 * NOTE: Does NOT delete claimed runs — caller must call deleteCompletedRuns() after successful delivery.
 */
export async function claimCompletedRuns(
  storage: Storage,
  parentSessionId: string,
  currentEpoch: number,
): Promise<SubagentRun[]> {
  const all = await storage.list<SubagentRun>({ prefix: SUBAGENT_RUN_PREFIX });
  const claimed: SubagentRun[] = [];
  const staleKeys: string[] = [];

  for (const [key, run] of all) {
    if (run.parentSessionId !== parentSessionId) continue;
    if (run.status === "running") continue;
    // Drop stale results from a previous epoch
    if (run.sessionEpoch !== currentEpoch) {
      staleKeys.push(key);
      continue;
    }
    claimed.push(run);
  }

  // Only delete stale-epoch entries (safe to discard). Valid entries stay until delivery succeeds.
  if (staleKeys.length > 0) {
    await storage.delete(staleKeys);
  }

  return claimed;
}

/**
 * Delete completed runs from DO storage after successful delivery.
 */
export async function deleteCompletedRuns(
  storage: Storage,
  runs: SubagentRun[],
): Promise<void> {
  if (runs.length === 0) return;
  await storage.delete(runs.map(r => `${SUBAGENT_RUN_PREFIX}${r.runId}`));
}

// -- Session Epoch --

export async function getSessionEpoch(storage: Storage, sessionId: string): Promise<number> {
  return (await storage.get<number>(`${SESSION_EPOCH_PREFIX}${sessionId}`)) ?? 0;
}

export async function bumpSessionEpoch(storage: Storage, sessionId: string): Promise<number> {
  const current = await getSessionEpoch(storage, sessionId);
  const next = current + 1;
  await storage.put(`${SESSION_EPOCH_PREFIX}${sessionId}`, next);
  return next;
}

// -- Orphan Recovery --

/**
 * Find runs stuck in "running" state past the timeout and mark them as errors.
 * Returns the orphaned runs (for drain scheduling).
 */
export async function recoverOrphanedRuns(
  storage: Storage,
  maxAgeMs: number,
): Promise<SubagentRun[]> {
  const all = await storage.list<SubagentRun>({ prefix: SUBAGENT_RUN_PREFIX });
  const now = Date.now();
  const orphans: SubagentRun[] = [];

  for (const [key, run] of all) {
    if (run.status === "running" && now - run.createdAt > maxAgeMs) {
      run.status = "error";
      run.error = "Orphaned: DO was evicted or request timed out";
      run.completedAt = now;
      await storage.put(key, run);
      orphans.push(run);
    }
  }

  return orphans;
}

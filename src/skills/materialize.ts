import { createHash } from "node:crypto";
import { getSandboxPaths, type SandboxClient } from "../tools/sandbox-types";

export function createMaterializationEngine(sandbox: SandboxClient) {
  const readySet = new Set<string>();
  const failedSet = new Map<string, string>();
  const inflight = new Map<string, Promise<void>>();
  let installChain: Promise<void> = Promise.resolve();

  function withMutex<T>(fn: () => Promise<T>): Promise<T> {
    const chained = installChain.then(fn);
    installChain = chained.then(
      () => {},
      (e) => console.warn("[materialize] mutex error (swallowed):", e),
    );
    return chained;
  }

  async function materializeSingle(
    key: string,
    hash: string,
    setupFn: () => Promise<void>,
  ): Promise<void> {
    const { homeLocal } = getSandboxPaths();
    const safeKey = key.replace(/[^a-zA-Z0-9._-]/g, "_");
    const markerPath = `${homeLocal}/.ready_${safeKey}`;
    try {
      const { exists } = await sandbox.exists(markerPath);
      if (exists) {
        const content = await sandbox.readFile(markerPath);
        if (content.trim() === hash) return; // marker matches
      }
    } catch (e) {
      console.warn("[materialize] marker check failed:", e);
    }
    await withMutex(setupFn);
    await sandbox.mkdir(homeLocal, { recursive: true });
    await sandbox.writeFile(markerPath, hash);
  }

  return {
    ensure: async (
      key: string,
      hash: string,
      setupFn: () => Promise<void>,
    ): Promise<void> => {
      if (readySet.has(key)) return;
      const err = failedSet.get(key);
      if (err) throw new Error(err);
      const existing = inflight.get(key);
      if (existing) return existing;

      const promise = materializeSingle(key, hash, setupFn)
        .then(() => {
          readySet.add(key);
        })
        .catch((e) => {
          failedSet.set(key, e instanceof Error ? e.message : String(e));
          throw e;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, promise);
      return promise;
    },
    invalidate: (key: string) => {
      readySet.delete(key);
      failedSet.delete(key);
    },
  };
}

export type MaterializationEngine = ReturnType<
  typeof createMaterializationEngine
>;

/** Content hash for materialization marker (short, deterministic). */
export function contentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

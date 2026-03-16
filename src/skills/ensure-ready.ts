import { createHash } from "node:crypto";
import { getSandboxPaths, type SandboxClient } from "../tools/sandbox-types";
import type { SkillInstallSpec } from "./loader";
import { parseSkillFrontmatter } from "./loader";
import { findCompatibleSpecs, executeInstallSpec, binExists } from "./install";

/**
 * Deterministic hash of install specs. Order-independent, deduplicated.
 * Returns "" for empty specs (no deps needed).
 */
export function computeSpecHash(specs: SkillInstallSpec[]): string {
  if (specs.length === 0) return "";
  const seen = new Set<string>();
  const unique = specs.filter((s) => {
    const key = `${s.kind}:${s.package ?? s.url ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const normalized = unique
    .map((s) => ({ kind: s.kind, package: s.package, url: s.url, bins: s.bins?.sort() }))
    .sort((a, b) =>
      `${a.kind}:${a.package ?? a.url}`.localeCompare(`${b.kind}:${b.package ?? b.url}`),
    );
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
}

export interface SkillHydratorDeps {
  sandbox: SandboxClient;
}

export type EnsureSkillReady = (name: string) => Promise<void>;

/**
 * Extract skill name from a shell command containing `/installed-skills/{name}/`.
 * Returns the first match or null.
 */
export function extractSkillNameFromCommand(command: string): string | null {
  const match = command.match(/\/installed-skills\/([a-z0-9-]+)\//);
  return match ? match[1] : null;
}

/**
 * Factory that creates an `ensureSkillReady(name)` function with per-skill
 * lazy hydration. Each skill is hydrated at most once per factory instance.
 *
 * - In-memory caching: `readySkills` (success) and `failedSkills` (error)
 * - Concurrent dedup: in-flight promises are reused
 * - Install mutex: npm/pip installs are serialized across all skills
 */
export function createSkillHydrator(deps: SkillHydratorDeps): EnsureSkillReady {
  const { sandbox } = deps;

  const readySkills = new Set<string>();
  const failedSkills = new Map<string, string>();
  const inflight = new Map<string, Promise<void>>();

  // Install mutex — serializes all install operations (npm/pip can't run concurrently)
  let installChain: Promise<void> = Promise.resolve();

  function withInstallMutex<T>(fn: () => Promise<T>): Promise<T> {
    const chained = installChain.then(fn);
    // Update the chain — swallow errors so the chain stays alive
    installChain = chained.then(() => {}, (e) => console.warn("[skillInstall] Install mutex error (swallowed to keep chain alive):", e));
    return chained;
  }

  async function hydrateSingle(name: string): Promise<void> {
    const start = Date.now();

    // Step 1: Read SKILL.md from sandbox (files are already on sprite from install)
    let content: string;
    try {
      content = await sandbox.readFile(`/installed-skills/${name}/SKILL.md`);
    } catch (e) {
      console.warn(`[ensureSkillReady] ${name}: sandbox readFile failed:`, e);
      throw new Error(`SKILL.md not found for skill "${name}" on sandbox filesystem`);
    }
    const meta = parseSkillFrontmatter(content);
    console.log(`[ensureSkillReady] ${name}: SKILL.md read from sandbox (${Date.now() - start}ms)`);

    // Step 2: Compute hash
    const compatibleSpecs = findCompatibleSpecs(meta?.metadata?.install ?? []);
    const specHash = computeSpecHash(compatibleSpecs);
    const hash = specHash || "no-deps";

    // Step 3: Check per-skill marker
    const paths = getSandboxPaths();
    const markerPath = `${paths.homeLocal}/.skill_ready_${name}`;
    try {
      const markerResult = await sandbox.exists(markerPath);
      if (markerResult.exists) {
        const markerContent = await sandbox.readFile(markerPath);
        if (markerContent.trim() === hash) {
          // Hot path — skill is already ready
          console.log(`[ensureSkillReady] ${name}: marker matched, hot path (${Date.now() - start}ms)`);
          return;
        }
      }
    } catch (e) {
      // Marker check failed, continue to install
      console.warn("[ensureSkillReady] Marker check failed, continuing to install:", e);
    }

    // Step 4: Install missing deps (behind install mutex)
    const requiredBins = meta?.metadata?.requires?.bins;
    if (requiredBins && requiredBins.length > 0) {
      await withInstallMutex(async () => {
        let missing: string[] = [];
        for (const bin of requiredBins) {
          if (!(await binExists(sandbox, bin))) missing.push(bin);
        }
        if (missing.length === 0) return;

        const allInstallSpecs = meta?.metadata?.install ?? [];
        if (allInstallSpecs.length === 0) {
          throw new Error(
            `Missing binaries [${missing.join(", ")}] for skill "${name}": no installation instructions provided`,
          );
        }

        if (compatibleSpecs.length === 0) {
          throw new Error(
            `Missing binaries [${missing.join(", ")}] for skill "${name}": no compatible installer for this environment (found: ${allInstallSpecs.map((s) => s.kind).join(", ")})`,
          );
        }

        console.log(`[ensureSkillReady] ${name}: installing deps, missing: [${missing.join(", ")}]`);

        for (const spec of compatibleSpecs) {
          await executeInstallSpec(sandbox, spec);
          const stillMissing: string[] = [];
          for (const bin of missing) {
            if (!(await binExists(sandbox, bin))) stillMissing.push(bin);
          }
          missing = stillMissing;
          if (missing.length === 0) break;
        }

        if (missing.length > 0) {
          throw new Error(
            `Missing binaries [${missing.join(", ")}] after install for skill "${name}"`,
          );
        }

        console.log(`[ensureSkillReady] ${name}: deps installed (${Date.now() - start}ms)`);
      });
    }

    // Step 5: Write marker file (files are already on sprite from install)
    await sandbox.mkdir(paths.homeLocal, { recursive: true });
    await sandbox.writeFile(markerPath, hash);
    console.log(`[ensureSkillReady] ${name}: marker written, hydration complete (${Date.now() - start}ms)`);
  }

  return async function ensureSkillReady(name: string): Promise<void> {
    // Fast check: already ready
    if (readySkills.has(name)) return;

    // Fast check: previously failed
    const cachedError = failedSkills.get(name);
    if (cachedError !== undefined) {
      console.warn(`[ensureSkillReady] ${name}: returning cached failure`);
      throw new Error(cachedError);
    }

    // Dedup concurrent calls
    const existing = inflight.get(name);
    if (existing) return existing;

    const promise = hydrateSingle(name)
      .then(() => {
        readySkills.add(name);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        failedSkills.set(name, message);
        throw err;
      })
      .finally(() => {
        inflight.delete(name);
      });

    inflight.set(name, promise);
    return promise;
  };
}

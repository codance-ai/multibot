import { describe, it, expect, vi } from "vitest";
import {
  createMaterializationEngine,
  contentHash,
} from "./materialize";
import type { SandboxClient } from "../tools/sandbox-types";

function createMockSandbox(): SandboxClient & {
  written: Map<string, string>;
} {
  const written = new Map<string, string>();
  return {
    written,
    exec: vi.fn(async () => ({
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    })),
    readFile: vi.fn(async (path: string) => {
      const content = written.get(path);
      if (content !== undefined) return content;
      throw new Error(`not found: ${path}`);
    }),
    writeFile: vi.fn(async (path: string, content: string) => {
      written.set(path, content);
    }),
    exists: vi.fn(async (path: string) => ({ exists: written.has(path) })),
    mkdir: vi.fn(async () => {}),
  };
}

describe("createMaterializationEngine", () => {
  it("hot path: in-memory readySet hit → no sandbox calls", async () => {
    const sandbox = createMockSandbox();
    const engine = createMaterializationEngine(sandbox);
    const setupFn = vi.fn(async () => {});

    // First call — cold path
    await engine.ensure("test-key", "hash1", setupFn);
    expect(setupFn).toHaveBeenCalledTimes(1);

    // Reset mocks to track second call
    sandbox.exists.mockClear();
    sandbox.readFile.mockClear();
    const setupFn2 = vi.fn(async () => {});

    // Second call — hot path (in-memory)
    await engine.ensure("test-key", "hash1", setupFn2);
    expect(setupFn2).not.toHaveBeenCalled();
    expect(sandbox.exists).not.toHaveBeenCalled();
    expect(sandbox.readFile).not.toHaveBeenCalled();
  });

  it("warm path: filesystem marker matches hash → no setupFn call", async () => {
    const sandbox = createMockSandbox();
    // Pre-write the marker file
    sandbox.written.set("/home/sprite/.local/.ready_warm-key", "hash-abc");

    const engine = createMaterializationEngine(sandbox);
    const setupFn = vi.fn(async () => {});

    await engine.ensure("warm-key", "hash-abc", setupFn);
    expect(setupFn).not.toHaveBeenCalled();
  });

  it("cold path: no marker → setupFn called → marker written", async () => {
    const sandbox = createMockSandbox();
    const engine = createMaterializationEngine(sandbox);
    const setupFn = vi.fn(async () => {});

    await engine.ensure("cold-key", "hash-cold", setupFn);
    expect(setupFn).toHaveBeenCalledTimes(1);
    // Marker should be written
    expect(sandbox.written.get("/home/sprite/.local/.ready_cold-key")).toBe(
      "hash-cold",
    );
  });

  it("hash change: marker exists but hash mismatch → setupFn re-executed", async () => {
    const sandbox = createMockSandbox();
    // Pre-write marker with old hash
    sandbox.written.set("/home/sprite/.local/.ready_change-key", "old-hash");

    const engine = createMaterializationEngine(sandbox);
    const setupFn = vi.fn(async () => {});

    await engine.ensure("change-key", "new-hash", setupFn);
    expect(setupFn).toHaveBeenCalledTimes(1);
    // Marker should be updated
    expect(sandbox.written.get("/home/sprite/.local/.ready_change-key")).toBe(
      "new-hash",
    );
  });

  it("failure caching: setupFn throws → second call throws immediately without retrying", async () => {
    const sandbox = createMockSandbox();
    const engine = createMaterializationEngine(sandbox);
    const setupFn = vi.fn(async () => {
      throw new Error("install failed");
    });

    await expect(
      engine.ensure("fail-key", "hash-fail", setupFn),
    ).rejects.toThrow("install failed");
    expect(setupFn).toHaveBeenCalledTimes(1);

    // Second call should throw immediately with cached error
    const setupFn2 = vi.fn(async () => {});
    await expect(
      engine.ensure("fail-key", "hash-fail", setupFn2),
    ).rejects.toThrow("install failed");
    expect(setupFn2).not.toHaveBeenCalled();
  });

  it("concurrent dedup: two concurrent ensure() for same key → setupFn runs only once", async () => {
    const sandbox = createMockSandbox();
    const engine = createMaterializationEngine(sandbox);
    let callCount = 0;
    const setupFn = vi.fn(async () => {
      callCount++;
      // Simulate async work
      await new Promise((r) => setTimeout(r, 10));
    });

    // Fire two concurrent calls
    const [r1, r2] = await Promise.all([
      engine.ensure("dedup-key", "hash-dedup", setupFn),
      engine.ensure("dedup-key", "hash-dedup", setupFn),
    ]);

    expect(r1).toBeUndefined();
    expect(r2).toBeUndefined();
    expect(setupFn).toHaveBeenCalledTimes(1);
    expect(callCount).toBe(1);
  });

  it("invalidate: after invalidate(), ensure() re-checks and runs setupFn for new hash", async () => {
    const sandbox = createMockSandbox();
    const engine = createMaterializationEngine(sandbox);
    const setupFn = vi.fn(async () => {});

    // First call with hash-v1
    await engine.ensure("inv-key", "hash-v1", setupFn);
    expect(setupFn).toHaveBeenCalledTimes(1);

    // Invalidate clears in-memory cache
    engine.invalidate("inv-key");

    // Second call with new hash (content changed) → setupFn runs again
    await engine.ensure("inv-key", "hash-v2", setupFn);
    expect(setupFn).toHaveBeenCalledTimes(2);
    // Marker updated to new hash
    expect(sandbox.written.get("/home/sprite/.local/.ready_inv-key")).toBe(
      "hash-v2",
    );
  });

  it("invalidate: after invalidate(), same hash hits warm path via marker", async () => {
    const sandbox = createMockSandbox();
    const engine = createMaterializationEngine(sandbox);
    const setupFn = vi.fn(async () => {});

    // First call
    await engine.ensure("warm-inv-key", "hash-same", setupFn);
    expect(setupFn).toHaveBeenCalledTimes(1);

    // Invalidate clears in-memory cache
    engine.invalidate("warm-inv-key");

    // Second call with same hash → warm path (marker still matches)
    const setupFn2 = vi.fn(async () => {});
    await engine.ensure("warm-inv-key", "hash-same", setupFn2);
    expect(setupFn2).not.toHaveBeenCalled(); // marker matched, no need to re-run
  });

  it("key with slashes/colons is sanitized in marker path", async () => {
    const sandbox = createMockSandbox();
    const engine = createMaterializationEngine(sandbox);
    const setupFn = vi.fn(async () => {});

    await engine.ensure("builtin:/skills/image/scripts/gen.py", "hash-py", setupFn);
    expect(setupFn).toHaveBeenCalledTimes(1);
    // Marker path should use sanitized key (slashes/colons → underscores)
    expect(
      sandbox.written.get(
        "/home/sprite/.local/.ready_builtin__skills_image_scripts_gen.py",
      ),
    ).toBe("hash-py");
  });

  it("invalidate clears failure cache so ensure retries", async () => {
    const sandbox = createMockSandbox();
    const engine = createMaterializationEngine(sandbox);
    let shouldFail = true;
    const setupFn = vi.fn(async () => {
      if (shouldFail) throw new Error("transient error");
    });

    // First call fails
    await expect(
      engine.ensure("retry-key", "hash-retry", setupFn),
    ).rejects.toThrow("transient error");

    // Invalidate clears failure cache
    engine.invalidate("retry-key");
    shouldFail = false;

    // Now should succeed
    await engine.ensure("retry-key", "hash-retry", setupFn);
    expect(setupFn).toHaveBeenCalledTimes(2);
  });
});

describe("contentHash", () => {
  it("returns deterministic hash", () => {
    const h1 = contentHash("hello world");
    const h2 = contentHash("hello world");
    expect(h1).toBe(h2);
  });

  it("different content → different hash", () => {
    const h1 = contentHash("hello");
    const h2 = contentHash("world");
    expect(h1).not.toBe(h2);
  });

  it("returns 16-char hex string", () => {
    const h = contentHash("test content");
    expect(h).toHaveLength(16);
    expect(h).toMatch(/^[0-9a-f]{16}$/);
  });
});

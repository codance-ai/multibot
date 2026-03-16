import { describe, it, expect, vi } from "vitest";
import {
  extractSkillNameFromCommand,
  createSkillHydrator,
  computeSpecHash,
} from "./ensure-ready";
import type { SandboxClient } from "../tools/sandbox-types";
import { findCompatibleSpecs } from "./install";

function createMockSandbox(): SandboxClient & { written: Map<string, string> } {
  const written = new Map<string, string>();
  return {
    written,
    exec: vi.fn(async () => ({ success: true, stdout: "", stderr: "", exitCode: 0 })),
    readFile: vi.fn(async (path: string) => {
      const content = written.get(path);
      if (content !== undefined) return content;
      throw new Error(`not found: ${path}`);
    }),
    writeFile: vi.fn(async (path: string, content: string) => { written.set(path, content); }),
    exists: vi.fn(async () => ({ exists: false })),
    mkdir: vi.fn(async () => {}),
  };
}

/** Simple skill with no deps */
const SIMPLE_SKILL_MD = `---
name: my-tool
description: My Tool
---
# My Tool`;

/** Skill with requires.bins and node install spec */
const ORACLE_SKILL_MD = `---
name: oracle
description: Oracle.
metadata: {"openclaw":{"requires":{"bins":["oracle"]},"install":[{"kind":"node","package":"@steipete/oracle","bins":["oracle"]}]}}
---
# Oracle`;

/** Skill with unsupported install kind */
const DNF_SKILL_MD = `---
name: pdf-extract
description: PDF extract.
metadata: {"openclaw":{"requires":{"bins":["pdftotext"]},"install":[{"kind":"dnf","package":"poppler-utils","bins":["pdftotext"]}]}}
---
# PDF Extract`;

/** Skill with requires.bins but no install specs at all */
const NO_INSTALL_SKILL_MD = `---
name: bare
description: Bare.
metadata: {"openclaw":{"requires":{"bins":["somecli"]}}}
---
# Bare`;

// -- extractSkillNameFromCommand --

describe("extractSkillNameFromCommand", () => {
  it("extracts name from python command", () => {
    expect(extractSkillNameFromCommand("python /installed-skills/weather/run.py")).toBe("weather");
  });

  it("returns null for unrelated command", () => {
    expect(extractSkillNameFromCommand("ls /workspace")).toBeNull();
  });

  it("extracts name from piped command", () => {
    expect(extractSkillNameFromCommand("cat /installed-skills/my-tool/SKILL.md | head")).toBe("my-tool");
  });
});

// -- createSkillHydrator --

describe("createSkillHydrator", () => {
  it("hot path: skips install when marker matches", async () => {
    const specs = findCompatibleSpecs([]);
    const specHash = computeSpecHash(specs);
    const expectedMarker = specHash || "no-deps";

    const sandbox = createMockSandbox();
    sandbox.exists = vi.fn(async (path: string) => {
      if (path === "/home/sprite/.local/.skill_ready_my-tool") return { exists: true };
      return { exists: false };
    });
    sandbox.readFile = vi.fn(async (path: string) => {
      if (path === "/home/sprite/.local/.skill_ready_my-tool") return expectedMarker;
      if (path === "/installed-skills/my-tool/SKILL.md") return SIMPLE_SKILL_MD;
      throw new Error("not found");
    });

    const ensureReady = createSkillHydrator({ sandbox });
    await ensureReady("my-tool");

    // sandbox.readFile IS called (to read SKILL.md and compute hash)
    expect(sandbox.readFile).toHaveBeenCalledWith("/installed-skills/my-tool/SKILL.md");
    // No install commands
    expect(sandbox.exec).not.toHaveBeenCalled();
    // No file writes (marker already matches)
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("cold path, no deps: writes marker", async () => {
    const sandbox = createMockSandbox();
    sandbox.exists = vi.fn(async () => ({ exists: false }));
    // Pre-populate sandbox with skill files (written during install)
    sandbox.written.set("/installed-skills/my-tool/SKILL.md", SIMPLE_SKILL_MD);

    const ensureReady = createSkillHydrator({ sandbox });
    await ensureReady("my-tool");

    // Marker written
    expect(sandbox.written.get("/home/sprite/.local/.skill_ready_my-tool")).toBe("no-deps");
    // No install commands (no deps)
    const execCalls = (sandbox.exec as ReturnType<typeof vi.fn>).mock.calls;
    expect(execCalls.length).toBe(0);
  });

  it("cold path, with deps: installs and writes marker", async () => {
    const sandbox = createMockSandbox();
    sandbox.exists = vi.fn(async () => ({ exists: false }));
    // Pre-populate sandbox with skill files
    sandbox.written.set("/installed-skills/oracle/SKILL.md", ORACLE_SKILL_MD);
    sandbox.readFile = vi.fn(async (path: string) => {
      const content = sandbox.written.get(path);
      if (content !== undefined) return content;
      throw new Error("not found");
    });

    let npmInstalled = false;
    sandbox.exec = vi.fn(async (cmd: string) => {
      if (cmd.includes("which")) {
        return npmInstalled
          ? { success: true, stdout: "/home/sprite/.local/bin/oracle", stderr: "", exitCode: 0 }
          : { success: false, stdout: "", stderr: "", exitCode: 1 };
      }
      if (cmd.includes("npm install")) {
        npmInstalled = true;
        return { success: true, stdout: "", stderr: "", exitCode: 0 };
      }
      return { success: true, stdout: "", stderr: "", exitCode: 0 };
    });

    const ensureReady = createSkillHydrator({ sandbox });
    await ensureReady("oracle");

    // npm install was called
    expect(sandbox.exec).toHaveBeenCalledWith(expect.stringContaining("npm install"));
    // Marker written with spec hash
    const specs = findCompatibleSpecs([
      { kind: "node", package: "@steipete/oracle", bins: ["oracle"] },
    ]);
    const expectedHash = computeSpecHash(specs);
    expect(sandbox.written.get("/home/sprite/.local/.skill_ready_oracle")).toBe(expectedHash);
  });

  it("throws descriptive error when install fails (bins still missing)", async () => {
    const sandbox = createMockSandbox();
    sandbox.exists = vi.fn(async () => ({ exists: false }));
    // Pre-populate sandbox with skill files
    sandbox.written.set("/installed-skills/oracle/SKILL.md", ORACLE_SKILL_MD);
    sandbox.readFile = vi.fn(async (path: string) => {
      const content = sandbox.written.get(path);
      if (content !== undefined) return content;
      throw new Error("not found");
    });
    // All exec calls fail (which + npm install)
    sandbox.exec = vi.fn(async () => ({ success: false, stdout: "", stderr: "not found", exitCode: 1 }));

    const ensureReady = createSkillHydrator({ sandbox });
    await expect(ensureReady("oracle")).rejects.toThrow(/Missing binaries/);
  });

  it("throws when no compatible installer available", async () => {
    const sandbox = createMockSandbox();
    sandbox.exists = vi.fn(async () => ({ exists: false }));
    // Pre-populate sandbox with skill files
    sandbox.written.set("/installed-skills/pdf-extract/SKILL.md", DNF_SKILL_MD);
    // which always fails
    sandbox.exec = vi.fn(async () => ({ success: false, stdout: "", stderr: "", exitCode: 1 }));

    const ensureReady = createSkillHydrator({ sandbox });
    await expect(ensureReady("pdf-extract")).rejects.toThrow(/no compatible installer/);
  });

  it("throws when no installation instructions provided", async () => {
    const sandbox = createMockSandbox();
    sandbox.exists = vi.fn(async () => ({ exists: false }));
    // Pre-populate sandbox with skill files
    sandbox.written.set("/installed-skills/bare/SKILL.md", NO_INSTALL_SKILL_MD);
    sandbox.exec = vi.fn(async () => ({ success: false, stdout: "", stderr: "", exitCode: 1 }));

    const ensureReady = createSkillHydrator({ sandbox });
    await expect(ensureReady("bare")).rejects.toThrow(/no installation instructions/);
  });

  it("caches failure: second call throws immediately without re-attempting", async () => {
    const sandbox = createMockSandbox();
    sandbox.exists = vi.fn(async () => ({ exists: false }));
    // Pre-populate sandbox with skill files
    sandbox.written.set("/installed-skills/oracle/SKILL.md", ORACLE_SKILL_MD);
    sandbox.exec = vi.fn(async () => ({ success: false, stdout: "", stderr: "", exitCode: 1 }));

    const ensureReady = createSkillHydrator({ sandbox });

    // First call fails
    await expect(ensureReady("oracle")).rejects.toThrow(/Missing binaries/);

    // Reset mocks to verify they're NOT called again
    (sandbox.readFile as ReturnType<typeof vi.fn>).mockClear();
    (sandbox.exec as ReturnType<typeof vi.fn>).mockClear();

    // Second call throws immediately
    await expect(ensureReady("oracle")).rejects.toThrow(/Missing binaries/);

    // No sandbox calls on second attempt
    expect(sandbox.readFile).not.toHaveBeenCalled();
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it("caches success: second call returns immediately without any calls", async () => {
    const sandbox = createMockSandbox();
    sandbox.exists = vi.fn(async () => ({ exists: false }));
    // Pre-populate sandbox with skill files
    sandbox.written.set("/installed-skills/my-tool/SKILL.md", SIMPLE_SKILL_MD);

    const ensureReady = createSkillHydrator({ sandbox });

    // First call succeeds
    await ensureReady("my-tool");

    // Reset mocks
    (sandbox.readFile as ReturnType<typeof vi.fn>).mockClear();
    (sandbox.exists as ReturnType<typeof vi.fn>).mockClear();
    (sandbox.exec as ReturnType<typeof vi.fn>).mockClear();
    (sandbox.mkdir as ReturnType<typeof vi.fn>).mockClear();
    (sandbox.writeFile as ReturnType<typeof vi.fn>).mockClear();

    // Second call returns immediately
    await ensureReady("my-tool");

    // No calls at all
    expect(sandbox.readFile).not.toHaveBeenCalled();
    expect(sandbox.exists).not.toHaveBeenCalled();
    expect(sandbox.exec).not.toHaveBeenCalled();
    expect(sandbox.mkdir).not.toHaveBeenCalled();
    expect(sandbox.writeFile).not.toHaveBeenCalled();
  });

  it("deduplicates concurrent calls: hydrateSingle runs only once", async () => {
    const sandbox = createMockSandbox();
    sandbox.exists = vi.fn(async () => ({ exists: false }));
    // Pre-populate sandbox with skill files
    sandbox.written.set("/installed-skills/my-tool/SKILL.md", SIMPLE_SKILL_MD);

    const ensureReady = createSkillHydrator({ sandbox });

    // Launch two concurrent calls for the same skill
    const [result1, result2] = await Promise.all([
      ensureReady("my-tool"),
      ensureReady("my-tool"),
    ]);

    expect(result1).toBeUndefined();
    expect(result2).toBeUndefined();

    // writeFile is called for marker only. If hydrateSingle ran twice, we'd see 2 marker writes.
    // Dedup ensures only 1 hydration runs.
    const writeFileCalls = (sandbox.writeFile as ReturnType<typeof vi.fn>).mock.calls;
    const markerWrites = writeFileCalls.filter(([path]: [string]) =>
      path.includes(".skill_ready_"),
    );
    expect(markerWrites).toHaveLength(1);
  });
});

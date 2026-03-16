import { describe, it, expect, vi } from "vitest";
import { createLoadSkillTool } from "./load-skill";
import type { SandboxClient } from "./sandbox-types";

function createMockSandbox(files: Record<string, string> = {}): SandboxClient {
  return {
    exec: vi.fn(async () => ({ success: true, stdout: "", stderr: "", exitCode: 0 })),
    readFile: vi.fn(async (path: string) => {
      if (path in files) return files[path];
      throw new Error(`File not found: ${path}`);
    }),
    writeFile: vi.fn(async () => {}),
    exists: vi.fn(async (path: string) => ({ exists: path in files })),
    mkdir: vi.fn(async () => {}),
  };
}

describe("createLoadSkillTool", () => {
  const builtinSkills: Record<string, string> = {
    weather: "# Weather Skill\nCheck the weather.",
    selfie: "# Selfie Skill\nTake a selfie.",
  };

  it("returns builtin skill content by name", async () => {
    const tools = createLoadSkillTool(builtinSkills);
    const result = await (tools.load_skill as any).execute({ name: "weather" });
    expect(result).toBe("# Weather Skill\nCheck the weather.");
  });

  it("returns error for unknown skill without sandbox", async () => {
    const tools = createLoadSkillTool(builtinSkills);
    const result = await (tools.load_skill as any).execute({ name: "unknown" });
    expect(result).toContain("not found");
  });

  it("reads installed skill from sandbox", async () => {
    const sandbox = createMockSandbox({
      "/installed-skills/my-tool/SKILL.md": "# Installed Skill",
    });
    const tools = createLoadSkillTool(builtinSkills, sandbox);
    const result = await (tools.load_skill as any).execute({ name: "my-tool" });
    expect(result).toBe("# Installed Skill");
    expect(sandbox.readFile).toHaveBeenCalledWith("/installed-skills/my-tool/SKILL.md");
  });

  it("triggers hydration before reading from sandbox", async () => {
    const sandbox = createMockSandbox({
      "/installed-skills/my-tool/SKILL.md": "# Hydrated",
    });
    const ensureSkillReady = vi.fn(async () => {});
    const tools = createLoadSkillTool(builtinSkills, sandbox, ensureSkillReady);
    const result = await (tools.load_skill as any).execute({ name: "my-tool" });
    expect(ensureSkillReady).toHaveBeenCalledWith("my-tool");
    expect(result).toBe("# Hydrated");
  });

  it("returns error when hydration fails", async () => {
    const sandbox = createMockSandbox({});
    const ensureSkillReady = vi.fn(async () => {
      throw new Error("SKILL.md not found");
    });
    const tools = createLoadSkillTool(builtinSkills, sandbox, ensureSkillReady);
    const result = await (tools.load_skill as any).execute({ name: "broken" });
    expect(result).toContain("not available");
    expect(result).toContain("SKILL.md not found");
  });

  it("returns error when sandbox has no SKILL.md for installed skill", async () => {
    const sandbox = createMockSandbox({});
    const tools = createLoadSkillTool(builtinSkills, sandbox);
    const result = await (tools.load_skill as any).execute({ name: "missing" });
    expect(result).toContain("not found");
  });

  it("prefers builtin over sandbox for same name", async () => {
    const sandbox = createMockSandbox({
      "/installed-skills/weather/SKILL.md": "# Sandbox Version",
    });
    const tools = createLoadSkillTool(builtinSkills, sandbox);
    const result = await (tools.load_skill as any).execute({ name: "weather" });
    expect(result).toBe("# Weather Skill\nCheck the weather.");
    expect(sandbox.readFile).not.toHaveBeenCalled();
  });
});

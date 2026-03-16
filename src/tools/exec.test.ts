import { describe, it, expect, vi } from "vitest";
import { guardCommand, createExecTools } from "./exec";
import type { SandboxClient } from "./sandbox-types";

function createMockSandbox(
  overrides: Partial<SandboxClient> = {}
): SandboxClient {
  return {
    exec: vi.fn(async () => ({
      success: true,
      stdout: "",
      stderr: "",
      exitCode: 0,
    })),
    readFile: vi.fn(async () => ""),
    writeFile: vi.fn(async () => {}),
    exists: vi.fn(async () => ({ exists: true })),
    mkdir: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("guardCommand", () => {
  it("blocks rm -rf", () => {
    expect(guardCommand("rm -rf /")).not.toBeNull();
    expect(guardCommand("rm -fr /tmp")).not.toBeNull();
    expect(guardCommand("rm -r /tmp")).not.toBeNull();
  });

  it("blocks del /f", () => {
    expect(guardCommand("del /f file.txt")).not.toBeNull();
    expect(guardCommand("del /q file.txt")).not.toBeNull();
  });

  it("blocks rmdir /s", () => {
    expect(guardCommand("rmdir /s C:\\folder")).not.toBeNull();
  });

  it("blocks format", () => {
    expect(guardCommand("format C:")).not.toBeNull();
    expect(guardCommand("echo hi; format C:")).not.toBeNull();
  });

  it("blocks mkfs and diskpart", () => {
    expect(guardCommand("mkfs.ext4 /dev/sda1")).not.toBeNull();
    expect(guardCommand("diskpart")).not.toBeNull();
  });

  it("blocks dd if=", () => {
    expect(guardCommand("dd if=/dev/zero of=/dev/sda")).not.toBeNull();
  });

  it("blocks writing to /dev/sd*", () => {
    expect(guardCommand("echo x > /dev/sda")).not.toBeNull();
  });

  it("blocks shutdown/reboot/poweroff", () => {
    expect(guardCommand("shutdown -h now")).not.toBeNull();
    expect(guardCommand("reboot")).not.toBeNull();
    expect(guardCommand("poweroff")).not.toBeNull();
  });

  it("blocks fork bomb", () => {
    expect(guardCommand(":(){ :|:& };:")).not.toBeNull();
  });

  it("allows safe commands", () => {
    expect(guardCommand("ls -la")).toBeNull();
    expect(guardCommand("echo hello")).toBeNull();
    expect(guardCommand("git status")).toBeNull();
    expect(guardCommand("python3 script.py")).toBeNull();
    expect(guardCommand("npm install lodash")).toBeNull();
    expect(guardCommand("curl https://example.com")).toBeNull();
  });

  it("allows rm without -rf flags", () => {
    expect(guardCommand("rm file.txt")).toBeNull();
  });
});

const P = [
  "export PATH=/home/sprite/.local/bin:$PATH",
  "export NPM_CONFIG_PREFIX=/home/sprite/.local",
  "export PYTHONUSERBASE=/home/sprite/.local",
  "export PIP_USER=1",
  "export PIP_CACHE_DIR=/tmp/cache/pip",
  "export npm_config_cache=/tmp/cache/npm",
  "export NODE_PATH=/home/sprite/.local/lib/node_modules:${NODE_PATH:-}",
  "",
].join("; ");

describe("createExecTools", () => {
  it("executes command and returns stdout", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "hello world",
        stderr: "",
        exitCode: 0,
      })),
    });
    const tools = createExecTools(sandbox);
    const result = await (tools.exec as any).execute({
      command: "echo hello world",
    });
    expect(result).toBe("hello world");
    expect(sandbox.exec).toHaveBeenCalledWith(`${P}echo hello world`, { timeout: 60_000 });
  });

  it("prepends cd for working_dir", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      })),
    });
    const tools = createExecTools(sandbox);
    await (tools.exec as any).execute({
      command: "ls",
      working_dir: "/tmp",
    });
    expect(sandbox.exec).toHaveBeenCalledWith(`${P}cd '/tmp' && ls`, { timeout: 60_000 });
  });

  it("quotes working_dir with special characters", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      })),
    });
    const tools = createExecTools(sandbox);
    await (tools.exec as any).execute({
      command: "ls",
      working_dir: "/my project's dir",
    });
    expect(sandbox.exec).toHaveBeenCalledWith(
      `${P}cd '/my project'\\''s dir' && ls`,
      { timeout: 60_000 }
    );
  });

  it("includes stderr in output", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: false,
        stdout: "partial output",
        stderr: "warning: something",
        exitCode: 0,
      })),
    });
    const tools = createExecTools(sandbox);
    const result = await (tools.exec as any).execute({ command: "test" });
    expect(result).toContain("partial output");
    expect(result).toContain("STDERR:");
    expect(result).toContain("warning: something");
  });

  it("includes exit code when non-zero", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: false,
        stdout: "",
        stderr: "not found",
        exitCode: 1,
      })),
    });
    const tools = createExecTools(sandbox);
    const result = await (tools.exec as any).execute({ command: "test" });
    expect(result).toContain("Exit code: 1");
    expect(result).toContain("not found");
  });

  it("returns (no output) for empty successful command", async () => {
    const sandbox = createMockSandbox();
    const tools = createExecTools(sandbox);
    const result = await (tools.exec as any).execute({ command: "true" });
    expect(result).toBe("(no output)");
  });

  it("blocks dangerous commands", async () => {
    const sandbox = createMockSandbox();
    const tools = createExecTools(sandbox);
    const result = await (tools.exec as any).execute({
      command: "rm -rf /",
    });
    expect(result).toContain("blocked by safety guard");
    expect(sandbox.exec).not.toHaveBeenCalled();
  });

  it("truncates long output", async () => {
    const longOutput = "x".repeat(15_000);
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: longOutput,
        stderr: "",
        exitCode: 0,
      })),
    });
    const tools = createExecTools(sandbox);
    const result = await (tools.exec as any).execute({ command: "test" });
    expect(result.length).toBeLessThan(longOutput.length);
    expect(result).toContain("truncated");
    expect(result).toContain("5000 more chars");
  });

  it("throws on timeout error", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => {
        throw new Error("Command timed out");
      }),
    });
    const tools = createExecTools(sandbox);
    await expect(
      (tools.exec as any).execute({ command: "sleep 120" })
    ).rejects.toThrow("timed out after 60 seconds");
  });

  it("passes env to sandbox.exec", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      })),
    });
    const tools = createExecTools(sandbox);
    await (tools.exec as any).execute({
      command: "python3 gen.py --prompt-env IMAGE_PROMPT",
      env: { IMAGE_PROMPT: "a cat sitting on a chair" },
    });
    expect(sandbox.exec).toHaveBeenCalledWith(
      `${P}python3 gen.py --prompt-env IMAGE_PROMPT`,
      { timeout: 60_000, env: { IMAGE_PROMPT: "a cat sitting on a chair" } }
    );
  });

  it("throws on general execution error", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => {
        throw new Error("Container not available");
      }),
    });
    const tools = createExecTools(sandbox);
    await expect(
      (tools.exec as any).execute({ command: "echo hi" })
    ).rejects.toThrow("Container not available");
  });

  it("pipes stdin via printenv when stdin is provided", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "got it",
        stderr: "",
        exitCode: 0,
      })),
    });
    const tools = createExecTools(sandbox);
    await (tools.exec as any).execute({
      command: "python3 gen.py",
      stdin: "a beautiful sunset over the ocean",
    });
    expect(sandbox.exec).toHaveBeenCalledWith(
      `${P}printenv __EXEC_STDIN__ | python3 gen.py`,
      { timeout: 60_000, env: { __EXEC_STDIN__: "a beautiful sunset over the ocean" } }
    );
  });

  it("prepends /home/sprite/.local/bin to PATH via export", async () => {
    const sandbox = createMockSandbox();
    const tools = createExecTools(sandbox);
    await (tools.exec as any).execute({ command: "which mytool" });
    const cmd = (sandbox.exec as any).mock.calls[0][0];
    expect(cmd).toContain("export PATH=/home/sprite/.local/bin:$PATH");
    expect(cmd).toContain("export PYTHONUSERBASE=/home/sprite/.local");
    expect(cmd).toContain("export PIP_USER=1");
    expect(cmd).toContain("export NPM_CONFIG_PREFIX=/home/sprite/.local");
    expect(cmd).toContain("export NODE_PATH=/home/sprite/.local/lib/node_modules:${NODE_PATH:-}");
    expect(cmd).toContain("which mytool");
  });

  it("PATH export works with working_dir cd chain", async () => {
    const sandbox = createMockSandbox();
    const tools = createExecTools(sandbox);
    await (tools.exec as any).execute({ command: "mytool run", working_dir: "/workspace" });
    const call = (sandbox.exec as any).mock.calls[0][0];
    expect(call).toMatch(/^export PATH=.*; cd .* && mytool run$/);
  });

  it("PATH export works with stdin pipeline", async () => {
    const sandbox = createMockSandbox();
    const tools = createExecTools(sandbox);
    await (tools.exec as any).execute({ command: "mytool", stdin: "hello" });
    const call = (sandbox.exec as any).mock.calls[0][0];
    expect(call).toMatch(/^export PATH=.*; printenv __EXEC_STDIN__ \| mytool$/);
  });

  it("combines stdin with env and working_dir", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      })),
    });
    const tools = createExecTools(sandbox);
    await (tools.exec as any).execute({
      command: "python3 gen.py",
      working_dir: "/workspace",
      env: { SOME_KEY: "value" },
      stdin: "prompt text",
    });
    expect(sandbox.exec).toHaveBeenCalledWith(
      `${P}cd '/workspace' && printenv __EXEC_STDIN__ | python3 gen.py`,
      { timeout: 60_000, env: { SOME_KEY: "value", __EXEC_STDIN__: "prompt text" } }
    );
  });
});

describe("createExecTools — skillSecrets", () => {
  it("injects skillSecrets into exec env", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      })),
    });
    const secrets = { WEATHER_API_KEY: "sk-weather-123" };
    const tools = createExecTools(sandbox, secrets);
    await (tools.exec as any).execute({ command: "python3 weather.py" });
    expect(sandbox.exec).toHaveBeenCalledWith(
      `${P}python3 weather.py`,
      { timeout: 60_000, env: { WEATHER_API_KEY: "sk-weather-123" } }
    );
  });

  it("user env overrides skillSecrets", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "ok",
        stderr: "",
        exitCode: 0,
      })),
    });
    const secrets = { API_KEY: "secret-default", OTHER: "other-val" };
    const tools = createExecTools(sandbox, secrets);
    await (tools.exec as any).execute({
      command: "test",
      env: { API_KEY: "user-override" },
    });
    const passedEnv = (sandbox.exec as any).mock.calls[0][1].env;
    expect(passedEnv.API_KEY).toBe("user-override");
    expect(passedEnv.OTHER).toBe("other-val");
  });

  it("redacts secret values from stdout", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "Response: key is sk-weather-123 and done",
        stderr: "",
        exitCode: 0,
      })),
    });
    const secrets = { WEATHER_API_KEY: "sk-weather-123" };
    const tools = createExecTools(sandbox, secrets);
    const result = await (tools.exec as any).execute({ command: "test" });
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("sk-weather-123");
  });

  it("redacts secret values from stderr", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "",
        stderr: "Error: invalid token ghp_secrettoken123",
        exitCode: 1,
      })),
    });
    const secrets = { GH_TOKEN: "ghp_secrettoken123" };
    const tools = createExecTools(sandbox, secrets);
    const result = await (tools.exec as any).execute({ command: "test" });
    expect(result).toContain("[REDACTED]");
    expect(result).not.toContain("ghp_secrettoken123");
  });

  it("does not redact when no secrets configured", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "normal output with sk-weather-123",
        stderr: "",
        exitCode: 0,
      })),
    });
    const tools = createExecTools(sandbox);
    const result = await (tools.exec as any).execute({ command: "test" });
    expect(result).toBe("normal output with sk-weather-123");
  });

  it("does not redact short secret values (< 4 chars)", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "value is abc here",
        stderr: "",
        exitCode: 0,
      })),
    });
    const secrets = { SHORT: "abc" };
    const tools = createExecTools(sandbox, secrets);
    const result = await (tools.exec as any).execute({ command: "test" });
    expect(result).toBe("value is abc here");
  });
});

describe("createExecTools — onOutput interceptor", () => {
  it("calls onOutput with raw output and returns transformed result", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "![cat](image:/workspace/images/abc.png)",
        stderr: "",
        exitCode: 0,
      })),
    });
    const onOutput = vi.fn(async (output: string) =>
      output.replace("image:/workspace/images/abc.png", "image:/media/bot-1/123_abc.png")
    );
    const tools = createExecTools(sandbox, undefined, undefined, undefined, undefined, onOutput);
    const result = await (tools.exec as any).execute({ command: "python3 gen.py" });
    expect(onOutput).toHaveBeenCalledWith("![cat](image:/workspace/images/abc.png)");
    expect(result).toContain("image:/media/bot-1/123_abc.png");
    expect(result).not.toContain("/workspace/");
  });

  it("preserves image refs across truncation", async () => {
    const longOutput = "x".repeat(10_000) + "\n![cat](image:/media/bot-1/123.png)";
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: longOutput,
        stderr: "",
        exitCode: 0,
      })),
    });
    // onOutput returns output as-is (images already resolved)
    const onOutput = vi.fn(async (output: string) => output);
    const tools = createExecTools(sandbox, undefined, undefined, undefined, undefined, onOutput);
    const result = await (tools.exec as any).execute({ command: "test" });
    // Image ref should be re-appended even though main output was truncated
    expect(result).toContain("![cat](image:/media/bot-1/123.png)");
    expect(result).toContain("truncated");
  });

  it("continues normally when onOutput throws", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "![cat](image:/workspace/images/abc.png)",
        stderr: "",
        exitCode: 0,
      })),
    });
    const onOutput = vi.fn(async () => {
      throw new Error("R2 upload failed");
    });
    const tools = createExecTools(sandbox, undefined, undefined, undefined, undefined, onOutput);
    const result = await (tools.exec as any).execute({ command: "test" });
    // Output preserved unchanged (workspace path kept for fallback)
    expect(result).toContain("image:/workspace/images/abc.png");
  });

  it("applies onOutput after secret redaction", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: true,
        stdout: "key=sk-secret-1234 ![img](image:/workspace/images/x.png)",
        stderr: "",
        exitCode: 0,
      })),
    });
    const secrets = { API_KEY: "sk-secret-1234" };
    const onOutput = vi.fn(async (output: string) => output);
    const tools = createExecTools(sandbox, secrets, undefined, undefined, undefined, onOutput);
    await (tools.exec as any).execute({ command: "test" });
    // onOutput should receive the redacted output
    expect(onOutput).toHaveBeenCalledWith(
      "key=[REDACTED] ![img](image:/workspace/images/x.png)"
    );
  });

  it("handles non-zero exit code with image refs", async () => {
    const sandbox = createMockSandbox({
      exec: vi.fn(async () => ({
        success: false,
        stdout: "![img](image:/workspace/images/abc.png)",
        stderr: "warning: partial",
        exitCode: 1,
      })),
    });
    const onOutput = vi.fn(async (output: string) =>
      output.replace("image:/workspace/images/abc.png", "image:/media/bot-1/resolved.png")
    );
    const tools = createExecTools(sandbox, undefined, undefined, undefined, undefined, onOutput);
    const result = await (tools.exec as any).execute({ command: "gen.py" });
    expect(result).toContain("image:/media/bot-1/resolved.png");
    expect(result).toContain("Exit code: 1");
  });
});

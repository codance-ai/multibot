import { describe, it, expect, vi } from "vitest";
import { createFilesystemTools, buildNotFoundMessage } from "./filesystem";
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

describe("buildNotFoundMessage", () => {
  it("shows unified diff when match is above threshold", () => {
    const content = "function hello() {\n  console.log('hi');\n}\n";
    const result = buildNotFoundMessage("function helo() {", content, "test.js");
    expect(result).toContain("Best match");
    expect(result).toContain("% similar");
    expect(result).toContain("line 1");
    // Should show unified diff format
    expect(result).toContain("---");
    expect(result).toContain("+++");
  });

  it("shows multi-line diff for multi-line old_text", () => {
    const content = "const a = 1;\nconst b = 2;\nconst c = 3;\n";
    const result = buildNotFoundMessage("const a = 1;\nconst b = 99;\nconst c = 3;", content, "test.js");
    expect(result).toContain("Best match");
    expect(result).toContain("-const b = 99;");
    expect(result).toContain("+const b = 2;");
  });

  it("shows generic message when no similar text", () => {
    const content = "completely different content\n";
    const result = buildNotFoundMessage(
      "zzzzzzzzzzzzzzzzz",
      content,
      "test.js"
    );
    expect(result).toContain("old_text not found");
    expect(result).toContain("No similar text found");
  });
});

describe("createFilesystemTools", () => {
  describe("read_file", () => {
    it("reads existing file", async () => {
      const sandbox = createMockSandbox({
        exists: vi.fn(async () => ({ exists: true })),
        readFile: vi.fn(async () => "hello world"),
      });
      const tools = createFilesystemTools(sandbox);
      const result = await (tools.read_file as any).execute({
        path: "/workspace/test.txt",
      });
      expect(result).toBe("hello world");
    });

    it("returns error for missing file", async () => {
      const sandbox = createMockSandbox({
        exists: vi.fn(async () => ({ exists: false })),
      });
      const tools = createFilesystemTools(sandbox);
      const result = await (tools.read_file as any).execute({
        path: "/workspace/missing.txt",
      });
      expect(result).toContain("File not found");
      expect(result).toContain("/workspace/missing.txt");
    });

    it("throws on read errors", async () => {
      const sandbox = createMockSandbox({
        exists: vi.fn(async () => ({ exists: true })),
        readFile: vi.fn(async () => {
          throw new Error("Permission denied");
        }),
      });
      const tools = createFilesystemTools(sandbox);
      await expect(
        (tools.read_file as any).execute({ path: "/workspace/secret.txt" })
      ).rejects.toThrow("Permission denied");
    });
  });

  describe("write_file", () => {
    it("writes file and creates parent dirs", async () => {
      const sandbox = createMockSandbox();
      const tools = createFilesystemTools(sandbox);
      const result = await (tools.write_file as any).execute({
        path: "/workspace/sub/test.txt",
        content: "hello",
      });
      expect(result).toContain("Successfully wrote");
      expect(result).toContain("5 bytes");
      expect(result).toContain("/workspace/sub/test.txt");
      expect(sandbox.mkdir).toHaveBeenCalledWith("/workspace/sub", {
        recursive: true,
      });
      expect(sandbox.writeFile).toHaveBeenCalledWith(
        "/workspace/sub/test.txt",
        "hello"
      );
    });

    it("throws on write errors", async () => {
      const sandbox = createMockSandbox({
        writeFile: vi.fn(async () => {
          throw new Error("Disk full");
        }),
      });
      const tools = createFilesystemTools(sandbox);
      await expect(
        (tools.write_file as any).execute({ path: "/workspace/test.txt", content: "data" })
      ).rejects.toThrow("Disk full");
    });

    it("counts bytes correctly for multi-byte characters", async () => {
      const sandbox = createMockSandbox();
      const tools = createFilesystemTools(sandbox);
      const result = await (tools.write_file as any).execute({
        path: "/workspace/test.txt",
        content: "你好",
      });
      expect(result).toContain("6 bytes");
    });
  });

  describe("edit_file", () => {
    it("replaces exact text", async () => {
      const sandbox = createMockSandbox({
        exists: vi.fn(async () => ({ exists: true })),
        readFile: vi.fn(async () => "hello world"),
      });
      const tools = createFilesystemTools(sandbox);
      const result = await (tools.edit_file as any).execute({
        path: "/workspace/test.txt",
        old_text: "hello",
        new_text: "goodbye",
      });
      expect(result).toBe("Successfully edited /workspace/test.txt");
      expect(sandbox.writeFile).toHaveBeenCalledWith(
        "/workspace/test.txt",
        "goodbye world"
      );
    });

    it("returns error when file not found", async () => {
      const sandbox = createMockSandbox({
        exists: vi.fn(async () => ({ exists: false })),
      });
      const tools = createFilesystemTools(sandbox);
      const result = await (tools.edit_file as any).execute({
        path: "/workspace/missing.txt",
        old_text: "a",
        new_text: "b",
      });
      expect(result).toContain("File not found");
    });

    it("returns error when old_text not found", async () => {
      const sandbox = createMockSandbox({
        exists: vi.fn(async () => ({ exists: true })),
        readFile: vi.fn(async () => "hello world"),
      });
      const tools = createFilesystemTools(sandbox);
      const result = await (tools.edit_file as any).execute({
        path: "/workspace/test.txt",
        old_text: "nonexistent text",
        new_text: "replacement",
      });
      expect(result).toContain("old_text not found");
    });

    it("returns error when multiple matches", async () => {
      const sandbox = createMockSandbox({
        exists: vi.fn(async () => ({ exists: true })),
        readFile: vi.fn(async () => "aaa bbb aaa"),
      });
      const tools = createFilesystemTools(sandbox);
      const result = await (tools.edit_file as any).execute({
        path: "/workspace/test.txt",
        old_text: "aaa",
        new_text: "ccc",
      });
      expect(result).toContain("found 2 times");
      expect(result).toContain("more context");
      expect(sandbox.writeFile).not.toHaveBeenCalled();
    });

    it("throws on edit errors", async () => {
      const sandbox = createMockSandbox({
        exists: vi.fn(async () => ({ exists: true })),
        readFile: vi.fn(async () => "hello"),
        writeFile: vi.fn(async () => {
          throw new Error("Write failed");
        }),
      });
      const tools = createFilesystemTools(sandbox);
      await expect(
        (tools.edit_file as any).execute({
          path: "/workspace/test.txt",
          old_text: "hello",
          new_text: "world",
        })
      ).rejects.toThrow("Write failed");
    });
  });

  describe("list_dir", () => {
    it("lists directory contents", async () => {
      const sandbox = createMockSandbox({
        exec: vi.fn(async () => ({
          success: true,
          stdout: "total 4\ndrwxr-xr-x 2 root root 4096 Jan 1 00:00 .\n-rw-r--r-- 1 root root 5 Jan 1 00:00 test.txt",
          stderr: "",
          exitCode: 0,
        })),
      });
      const tools = createFilesystemTools(sandbox);
      const result = await (tools.list_dir as any).execute({
        path: "/workspace",
      });
      expect(result).toContain("test.txt");
    });

    it("throws for non-existent directory", async () => {
      const sandbox = createMockSandbox({
        exec: vi.fn(async () => ({
          success: false,
          stdout: "",
          stderr: "ls: cannot access '/nonexistent': No such file or directory",
          exitCode: 2,
        })),
      });
      const tools = createFilesystemTools(sandbox);
      await expect(
        (tools.list_dir as any).execute({ path: "/nonexistent" })
      ).rejects.toThrow("No such file");
    });

    it("returns (empty directory) for empty output", async () => {
      const sandbox = createMockSandbox({
        exec: vi.fn(async () => ({
          success: true,
          stdout: "",
          stderr: "",
          exitCode: 0,
        })),
      });
      const tools = createFilesystemTools(sandbox);
      const result = await (tools.list_dir as any).execute({
        path: "/workspace",
      });
      expect(result).toBe("(empty directory)");
    });
  });
});

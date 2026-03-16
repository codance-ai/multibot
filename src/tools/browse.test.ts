import { describe, it, expect, vi } from "vitest";

import { createBrowseTools, classifyBrowseError, detectChallengePage } from "./browse";
import type { BrowseResult } from "./browse";
import type { SandboxClient } from "./sandbox-types";

describe("createBrowseTools", () => {
  it("returns empty tools when sandboxClient is null", () => {
    const { tools } = createBrowseTools(null);
    expect(tools).toEqual({});
  });

  it("returns browse and browse_interact when sandboxClient is provided", () => {
    const mockSandbox = { exec: vi.fn(), readFile: vi.fn(), writeFile: vi.fn(), exists: vi.fn(), mkdir: vi.fn() } as unknown as SandboxClient;
    const { tools } = createBrowseTools(mockSandbox);
    expect(Object.keys(tools).sort()).toEqual(["browse", "browse_interact"]);
  });

  it("browse throws initialization message when Playwright is not installed", async () => {
    const execMock = vi.fn().mockResolvedValue({ success: true, stdout: "", stderr: "", exitCode: 0 });
    const existsMock = vi.fn().mockResolvedValue({ exists: false });
    const mockSandbox = {
      exec: execMock,
      exists: existsMock,
      readFile: vi.fn(),
      writeFile: vi.fn(),
      mkdir: vi.fn(),
    } as unknown as SandboxClient;

    const { tools } = createBrowseTools(mockSandbox, "sprites");
    const browse = tools.browse as any;

    // Execute the browse tool — should return error JSON because marker doesn't exist
    const result = await browse.execute({ url: "https://example.com" });

    // ensureBrowseReady throws, outer catch in browse.execute returns error JSON
    expect(existsMock).toHaveBeenCalledWith(expect.stringContaining(".playwright-ready-v2"));
    // Fire-and-forget exec should have been called for installation
    expect(execMock).toHaveBeenCalledWith(
      expect.stringContaining("playwright install"),
      expect.objectContaining({ timeout: 120_000 }),
    );
    // Error should have installing errorType and hint telling LLM to inform the user
    const parsed = JSON.parse(result);
    expect(parsed.errorType).toBe("installing");
    expect(parsed.hint).toContain("Tell the user");
  });
});

describe("ensureServerRunning (via browse tool)", () => {
  function createMockSandbox(overrides: Partial<SandboxClient> = {}) {
    return {
      exec: vi.fn(),
      readFile: vi.fn(),
      writeFile: vi.fn().mockResolvedValue(undefined),
      exists: vi.fn().mockResolvedValue({ exists: true }), // Playwright installed
      mkdir: vi.fn(),
      ...overrides,
    } as unknown as SandboxClient;
  }

  it("server start exec timeout does not block browse (fire-and-forget)", async () => {
    let healthCallCount = 0;
    const execMock = vi.fn().mockImplementation((cmd: string, opts?: { timeout?: number }) => {
      // Server start — simulate WebSocket timeout (fire-and-forget)
      if (cmd.includes('nohup node server.js')) {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error(`WebSocket exec timed out after ${opts?.timeout}ms`)), 10);
        });
      }
      // Health checks — fail first 2, then succeed
      if (cmd.includes('/health')) {
        healthCallCount++;
        if (healthCallCount <= 2) return Promise.resolve({ success: false, stdout: '', stderr: '', exitCode: 1 });
        return Promise.resolve({ success: true, stdout: '{"ok":true}', stderr: '', exitCode: 0 });
      }
      // Browse curl — return a valid result
      if (cmd.includes('/browse')) {
        return Promise.resolve({
          success: true,
          stdout: JSON.stringify({ url: 'https://example.com', title: 'Example', tabs: [], revision: 1, truncated: false, markdown: 'content', mode: 'browser', interactable: true }),
          stderr: '', exitCode: 0,
        });
      }
      return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
    });

    const mockSandbox = createMockSandbox({ exec: execMock });
    const { tools } = createBrowseTools(mockSandbox);
    const browse = tools.browse as any;

    const result = await browse.execute({ url: "https://example.com" });
    const parsed = JSON.parse(result);

    // Should succeed — the timeout on server start should not block the browse
    expect(parsed.error).toBeUndefined();
    expect(parsed.url).toBe("https://example.com");
    // writeFile should have been called to write server.js
    expect(mockSandbox.writeFile).toHaveBeenCalledWith(
      expect.stringContaining("server.js"),
      expect.any(String),
    );
  });

  it("server start uses short timeout and closes stdin", async () => {
    let startCmd = '';
    let startTimeout = 0;
    let healthCallCount = 0;
    const execMock = vi.fn().mockImplementation((cmd: string, opts?: { timeout?: number }) => {
      if (cmd.includes('nohup node server.js')) {
        startCmd = cmd;
        startTimeout = opts?.timeout ?? 0;
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('WebSocket exec timed out')), 10);
        });
      }
      if (cmd.includes('/health')) {
        healthCallCount++;
        if (healthCallCount <= 1) {
          return Promise.resolve({ success: false, stdout: '', stderr: '', exitCode: 1 });
        }
        return Promise.resolve({ success: true, stdout: '{"ok":true}', stderr: '', exitCode: 0 });
      }
      if (cmd.includes('/browse')) {
        return Promise.resolve({ success: true, stdout: '{}', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
    });

    const mockSandbox = createMockSandbox({ exec: execMock });
    const { tools } = createBrowseTools(mockSandbox);
    await (tools.browse as any).execute({ url: "https://example.com" });

    // Verify stdin is closed and timeout is short
    expect(startCmd).toContain('</dev/null');
    expect(startTimeout).toBeLessThanOrEqual(5_000);
  });

  it("concurrent browse calls share the same server start", async () => {
    let writeCount = 0;
    const execMock = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes('nohup node server.js')) {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('WebSocket exec timed out')), 10);
        });
      }
      if (cmd.includes('/health')) {
        // Fail first 2 calls, then succeed
        const healthCalls = execMock.mock.calls.filter((c: string[]) => c[0].includes('/health')).length;
        if (healthCalls <= 2) return Promise.resolve({ success: false, stdout: '', stderr: '', exitCode: 1 });
        return Promise.resolve({ success: true, stdout: '{"ok":true}', stderr: '', exitCode: 0 });
      }
      if (cmd.includes('/browse')) {
        return Promise.resolve({ success: true, stdout: '{}', stderr: '', exitCode: 0 });
      }
      return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
    });

    const writeFileMock = vi.fn().mockImplementation(() => {
      writeCount++;
      return Promise.resolve();
    });

    const mockSandbox = createMockSandbox({ exec: execMock, writeFile: writeFileMock });
    const { tools } = createBrowseTools(mockSandbox);
    const browse = tools.browse as any;

    // Launch two concurrent browse calls
    await Promise.all([
      browse.execute({ url: "https://example.com" }),
      browse.execute({ url: "https://example.org" }),
    ]);

    // writeFile for server.js should only be called once (startup lock)
    expect(writeCount).toBe(1);
  });

  it("concurrent callers both receive error when startup fails", { timeout: 25_000 }, async () => {
    const execMock = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes('nohup node server.js')) {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('WebSocket exec timed out')), 5);
        });
      }
      if (cmd.includes('tail -20 /tmp/browse-server.log')) {
        return Promise.resolve({ success: true, stdout: 'EADDRINUSE', stderr: '', exitCode: 1 });
      }
      // All health checks fail — server never starts
      if (cmd.includes('/health')) {
        return Promise.resolve({ success: false, stdout: '', stderr: '', exitCode: 1 });
      }
      return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
    });

    const mockSandbox = createMockSandbox({ exec: execMock });
    const { tools } = createBrowseTools(mockSandbox);
    const browse = tools.browse as any;

    // Both concurrent calls should get error responses
    const [result1, result2] = await Promise.all([
      browse.execute({ url: "https://example.com" }),
      browse.execute({ url: "https://example.org" }),
    ]);

    const parsed1 = JSON.parse(result1);
    const parsed2 = JSON.parse(result2);

    // Both callers should receive the startup failure error
    expect(parsed1.error).toBe(true);
    expect(parsed1.message).toContain('Browse server failed to start');
    expect(parsed2.error).toBe(true);
    expect(parsed2.message).toContain('Browse server failed to start');
  });

  it("includes server log in error when health check polling fails", { timeout: 25_000 }, async () => {
    const execMock = vi.fn().mockImplementation((cmd: string) => {
      if (cmd.includes('nohup node server.js')) {
        return new Promise((_, reject) => {
          setTimeout(() => reject(new Error('WebSocket exec timed out')), 5);
        });
      }
      if (cmd.includes('tail -20 /tmp/browse-server.log')) {
        return Promise.resolve({ success: true, stdout: 'Error: Cannot find module playwright', stderr: '', exitCode: 0 });
      }
      // All health checks fail
      if (cmd.includes('/health')) {
        return Promise.resolve({ success: false, stdout: '', stderr: '', exitCode: 1 });
      }
      return Promise.resolve({ success: true, stdout: '', stderr: '', exitCode: 0 });
    });

    const mockSandbox = createMockSandbox({ exec: execMock });
    const { tools } = createBrowseTools(mockSandbox);
    const browse = tools.browse as any;

    const result = await browse.execute({ url: "https://example.com" });
    const parsed = JSON.parse(result);

    expect(parsed.error).toBe(true);
    expect(parsed.message).toContain('Browse server failed to start');
    expect(parsed.message).toContain('Cannot find module playwright');
  });
});

describe("classifyBrowseError", () => {
  it("classifies timeout errors", () => {
    expect(classifyBrowseError(new Error("Timeout 30000ms exceeded"))).toBe("timeout");
    expect(classifyBrowseError(new Error("Navigation timeout"))).toBe("timeout");
  });

  it("classifies DNS errors", () => {
    expect(classifyBrowseError(new Error("ERR_NAME_NOT_RESOLVED"))).toBe("dns_error");
  });

  it("classifies network errors", () => {
    expect(classifyBrowseError(new Error("ERR_CONNECTION_REFUSED"))).toBe("network_error");
    expect(classifyBrowseError(new Error("net::ERR_CONNECTION_RESET"))).toBe("network_error");
  });

  it("classifies browser errors", () => {
    expect(classifyBrowseError(new Error("Browser closed"))).toBe("browser_error");
    expect(classifyBrowseError(new Error("Target closed"))).toBe("browser_error");
  });

  it("classifies installing errors", () => {
    expect(classifyBrowseError(new Error("Browser environment is being initialized (first-time setup, ~30-60 seconds)."))).toBe("installing");
  });

  it("defaults to unknown", () => {
    expect(classifyBrowseError(new Error("Something weird"))).toBe("unknown");
  });
});

describe("detectChallengePage", () => {
  it("detects cf-mitigated header", () => {
    const headers = new Map([["cf-mitigated", "challenge"]]);
    expect(detectChallengePage(403, headers, "")).toBe("cloudflare_challenge");
  });

  it("detects Cloudflare challenge by title", () => {
    expect(detectChallengePage(403, new Map(), "Just a moment...")).toBe("cloudflare_challenge");
  });

  it("detects captcha/verify page by title on 403", () => {
    expect(detectChallengePage(403, new Map(), "Verify you are human")).toBe("captcha");
  });

  it("does not detect captcha on 200 (normal page)", () => {
    expect(detectChallengePage(200, new Map(), "Verify you are human")).toBeNull();
  });

  it("detects 403 with short WAF-like title", () => {
    expect(detectChallengePage(403, new Map(), "Access Denied")).toBe("blocked_403");
    expect(detectChallengePage(403, new Map(), "Forbidden")).toBe("blocked_403");
    expect(detectChallengePage(403, new Map(), "403 Forbidden")).toBe("blocked_403");
    expect(detectChallengePage(403, new Map(), "")).toBe("blocked_403");
  });

  it("does not flag 403 with normal/long title as challenge", () => {
    expect(detectChallengePage(403, new Map(), "Repository not found - GitHub")).toBeNull();
    expect(detectChallengePage(403, new Map(), "This repository has been blocked for content policy violations")).toBeNull();
  });

  it("returns null for normal pages", () => {
    expect(detectChallengePage(200, new Map(), "My Website - Home")).toBeNull();
  });

  it("does not flag SPA loading pages as challenge", () => {
    expect(detectChallengePage(200, new Map(), "Just a moment...")).toBeNull();
  });

  it("detects 503 with specific challenge phrasing", () => {
    expect(detectChallengePage(503, new Map(), "Checking your browser...")).toBe("service_challenge");
    expect(detectChallengePage(503, new Map(), "DDoS Protection by Cloudflare")).toBe("service_challenge");
  });

  it("does not flag 503 with generic wait message", () => {
    expect(detectChallengePage(503, new Map(), "Please wait...")).toBeNull();
    expect(detectChallengePage(503, new Map(), "Checking out - Amazon")).toBeNull();
  });
});

describe("BrowseResult", () => {
  it("browser mode result has correct shape", () => {
    const result: BrowseResult = {
      url: "https://example.com",
      title: "Example",
      tabs: [],
      revision: 1,
      truncated: false,
      markdown: "content",
      mode: "browser",
      interactable: true,
    };
    expect(result.mode).toBe("browser");
    expect(result.interactable).toBe(true);
  });
});

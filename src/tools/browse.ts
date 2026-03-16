import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";
import { assertSafeUrl } from "./browse-safety";
import type { SandboxClient } from "./sandbox-types";

// @ts-expect-error — text module imported via wrangler [[rules]]
import browseServerCode from "./browse.server.js";

export const MAX_SNAPSHOT_SIZE = 12_000;

/** Indexed interactive element from DOM. */
export interface IndexedElement {
  id: number;
  role: string;
  name: string;
  tag: string;
  inputType?: string;
  value?: string;
  checked?: boolean;
  expanded?: boolean;
}

/** Metadata about the current page state. */
export interface PageInfo {
  url: string;
  title: string;
  tabIndex: number;
  tabCount: number;
  scrollStart: number;
  scrollEnd: number;
  canScrollDown: boolean;
}

/** Browse result returned to LLM as JSON-wrapped anchored markdown. */
export interface BrowseResult {
  url: string;
  title: string;
  tabs: Array<{ id: number; title: string; url: string; active: boolean }>;
  revision: number;
  truncated: boolean;
  lastDialog?: string;
  markdown: string;
  mode: "browser";
  /** Whether browse_interact can be used on this page. */
  interactable: boolean;
}

export interface BrowseToolsResult {
  tools: ToolSet;
}

export type BrowseErrorType = "timeout" | "dns_error" | "network_error" | "browser_error" | "installing" | "unknown";
export type ChallengeType = "cloudflare_challenge" | "captcha" | "blocked_403" | "service_challenge";

/** Classify a navigation error for structured reporting. NOTE: duplicated in browse.server.js — keep in sync. */
export function classifyBrowseError(error: Error): BrowseErrorType {
  const msg = error.message.toLowerCase();
  if (msg.includes("being initialized")) return "installing";
  if (msg.includes("timeout")) return "timeout";
  if (msg.includes("err_name_not_resolved") || msg.includes("dns")) return "dns_error";
  if (msg.includes("err_connection") || msg.includes("err_network") || msg.includes("net::")) return "network_error";
  if (msg.includes("browser closed") || msg.includes("target closed") || msg.includes("browser.close")) return "browser_error";
  return "unknown";
}

/**
 * Detect if a successfully loaded page is actually a challenge/block page.
 * Returns challenge type or null if the page appears normal.
 * NOTE: duplicated in browse.server.js — keep in sync.
 */
export function detectChallengePage(
  status: number,
  headers: Map<string, string>,
  title: string,
): ChallengeType | null {
  // Cloudflare challenge header (most reliable signal)
  if (headers.get("cf-mitigated") === "challenge") return "cloudflare_challenge";

  const lowerTitle = title.toLowerCase();

  // Cloudflare "Just a moment" interstitial — only on 403/503 (CF challenges always use these)
  if ((status === 403 || status === 503) && lowerTitle.includes("just a moment")) return "cloudflare_challenge";

  // Captcha / human verification — status-gated to avoid matching normal pages
  if ((status === 403 || status === 503) && (
    lowerTitle.includes("verify you are human") || lowerTitle.includes("captcha")
  )) return "captcha";

  // 403 WAF block — require short, generic WAF-like titles (not long content titles that happen to contain "forbidden")
  if (status === 403 && title.length < 30 && (
    lowerTitle === "access denied" ||
    lowerTitle === "forbidden" ||
    lowerTitle === "blocked" ||
    lowerTitle === "403 forbidden" ||
    lowerTitle === "" // Empty title on 403 often indicates WAF block
  )) return "blocked_403";

  // 503 with specific challenge phrasing (not generic "please wait" which e-commerce uses)
  if (status === 503 && (
    lowerTitle.includes("checking your browser") ||
    lowerTitle.includes("ddos protection")
  )) return "service_challenge";

  return null;
}

export function createBrowseTools(
  sandboxClient: SandboxClient | null,
  r2?: R2Bucket,
  botId?: string,
  chatId?: string,
): BrowseToolsResult {
  if (!sandboxClient) {
    return { tools: {} };
  }

  // Session-scoped: each chat gets its own BrowserContext to isolate cookies/tabs/state
  const sessionId = chatId ? `${botId || "default"}-${chatId}` : (botId || "default");

  const BROWSE_MARKER = ".playwright-ready-v2";
  const BROWSE_INSTALL_DIR = "/home/sprite/.browse-deps";

  let browseInstalled = false; // in-memory cache to skip marker check after first success
  let serverStartPromise: Promise<void> | null = null; // lock to prevent concurrent server starts

  /**
   * Check if Playwright is installed. If not, trigger a fire-and-forget background
   * installation and throw a user-friendly error. The next request after installation
   * completes will find the marker and proceed normally.
   */
  async function ensureBrowseReady(): Promise<void> {
    if (browseInstalled) return;

    const { exists } = await sandboxClient!.exists(`${BROWSE_INSTALL_DIR}/${BROWSE_MARKER}`);
    if (exists) {
      browseInstalled = true;
      return;
    }

    // Fire-and-forget: trigger installation in background (flock prevents concurrent installs)
    const installCmd = [
      `mkdir -p ${BROWSE_INSTALL_DIR}`,
      `&& cd ${BROWSE_INSTALL_DIR}`,
      `&& flock -w 120 /tmp/browse-install.lock bash -c '`,
      `test -f ${BROWSE_MARKER} && exit 0;`,
      `npm init -y > /dev/null 2>&1;`,
      `PLAYWRIGHT_BROWSERS_PATH=/home/sprite/pw-browsers npm install playwright > /dev/null 2>&1;`,
      `PLAYWRIGHT_BROWSERS_PATH=/home/sprite/pw-browsers npx playwright install --with-deps chromium --only-shell > /dev/null 2>&1;`,
      `touch ${BROWSE_MARKER};`,
      `'`,
    ].join(' ');

    // Non-blocking: don't await — let it run in the sandbox background
    sandboxClient!.exec(installCmd, { timeout: 120_000 }).then(
      (result) => {
        if (result.success) {
          // Fast-path for repeated calls within the same createBrowseTools() closure only.
          // Across sessions/DO restarts, the marker file check (line above) is the source of truth.
          browseInstalled = true;
          console.log("[browse] Playwright installation completed successfully");
        } else {
          console.error("[browse] Playwright installation failed:", result.stderr);
        }
      },
      (err) => console.error("[browse] Playwright installation error:", err),
    );

    throw new Error(
      "Browser environment is being initialized (first-time setup, ~30-60 seconds). " +
      "Please try again shortly. In the meantime, use web_fetch for static pages."
    );
  }

  async function ensureServerRunning(): Promise<void> {
    // Quick health check
    const health = await sandboxClient!.exec(
      'curl -sf http://127.0.0.1:3000/health',
      { timeout: 5_000 }
    );
    if (health.success) return;

    // Prevent concurrent server starts (multiple parallel browse calls)
    if (serverStartPromise) {
      await serverStartPromise;
      return;
    }

    serverStartPromise = startServer();
    try {
      await serverStartPromise;
    } finally {
      serverStartPromise = null;
    }
  }

  async function startServer(): Promise<void> {
    // Write server code to Sprite
    await sandboxClient!.writeFile(
      `${BROWSE_INSTALL_DIR}/server.js`,
      browseServerCode
    );

    // Start server in background — fire-and-forget with short timeout.
    // Sprites WebSocket exec doesn't close until ALL spawned processes exit,
    // so a long-running server process keeps the connection alive indefinitely.
    // We close stdin (</dev/null) for clean detachment and use a short timeout
    // since we only need the command to be dispatched, not completed.
    sandboxClient!.exec(
      `cd ${BROWSE_INSTALL_DIR} && PLAYWRIGHT_BROWSERS_PATH=/home/sprite/pw-browsers nohup node server.js </dev/null > /tmp/browse-server.log 2>&1 &`,
      { timeout: 2_000 }
    ).catch(err => {
      // Expected: WebSocket exec timeout fires because the background server process
      // keeps the connection alive. Only log genuinely unexpected errors.
      const isExpectedTimeout = err.message.includes('WebSocket exec timed out after 2000ms');
      if (!isExpectedTimeout) {
        console.warn("[browse] server start exec error:", err.message);
      }
    });

    // Poll for readiness
    for (let i = 0; i < 15; i++) {
      const check = await sandboxClient!.exec(
        'curl -sf http://127.0.0.1:3000/health',
        { timeout: 3_000 }
      );
      if (check.success) return;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }

    // Server failed to start — read log for diagnostics
    const log = await sandboxClient!.exec(
      'tail -20 /tmp/browse-server.log 2>/dev/null',
      { timeout: 3_000 }
    ).catch(() => ({ stdout: '', stderr: '', success: false, exitCode: 1 }));

    throw new Error(
      `Browse server failed to start within 15 seconds.` +
      (log.stdout ? ` Server log:\n${log.stdout}` : '')
    );
  }

  const tools: ToolSet = {
    browse: tool({
      description:
        "Open a URL in a headless browser with full JavaScript execution. " +
        "Use ONLY when the page requires JS rendering (SPAs, dynamic content) " +
        "or interactive operations (clicking buttons, filling forms, logging in). " +
        "Returns page content as markdown with numbered interactive element anchors " +
        "(e.g. [Button 1: Submit], [Link 3: Details]). " +
        "Use browse_interact to interact with elements by their ID number. " +
        "For reading articles, docs, or static pages, use web_fetch instead — it's faster and more reliable.",
      inputSchema: z.object({
        url: z.string().url().describe("Target URL (http/https only)"),
      }),
      execute: async ({ url }) => {
        assertSafeUrl(url);

        try {
          await ensureBrowseReady();
          await ensureServerRunning();

          const payload = JSON.stringify({ url, sessionId });
          // JSON.stringify output never contains raw single quotes, so this escaping is safe
          const escaped = payload.replace(/'/g, "'\\''");
          const result = await sandboxClient!.exec(
            `curl -s -X POST http://127.0.0.1:3000/browse -H 'Content-Type: application/json' -d '${escaped}'`,
            { timeout: 60_000 }
          );

          if (!result.success) {
            console.warn("[browse] curl failed:", result.stderr);
            return JSON.stringify({
              error: true,
              errorType: "server_error",
              url,
              message: `Browse server error: ${result.stderr}`,
              hint: "Try using web_fetch for a simpler request, or try a different URL.",
            });
          }

          return result.stdout;
        } catch (error) {
          const err = error instanceof Error ? error : new Error(String(error));
          const errorType = classifyBrowseError(err);
          console.warn("[browse] error:", err.message);
          return JSON.stringify({
            error: true,
            errorType,
            url,
            message: `Browse failed: ${err.message}`,
            hint: errorType === "installing"
              ? "IMPORTANT: Tell the user that the browser is being set up for the first time (~30-60 seconds) and to try again shortly. Do NOT silently switch to another tool or ignore this."
              : "Try using web_fetch for a simpler request, or try a different URL.",
          });
        }
      },
    }),

    browse_interact: tool({
      description:
        "Interact with the current browser page opened by browse(). " +
        "Returns updated page content with refreshed element anchors. " +
        "Element IDs are refreshed after each action — always use IDs from the most recent response.",
      inputSchema: z.object({
        action: z.enum([
          "click", "type", "select", "press", "scroll",
          "back", "switch_tab", "wait", "screenshot",
        ]).describe("Action to perform"),
        id: z.number().optional()
          .describe("Element ID from page anchors (required for click/type/select)"),
        value: z.string().optional()
          .describe("Text to type (for 'type'), option to select (for 'select')"),
        key: z.string().optional()
          .describe("Key name for 'press': Enter, Escape, Tab, ArrowDown, ArrowUp, Space"),
        direction: z.enum(["down", "up"]).default("down").optional()
          .describe("Scroll direction (default: down)"),
        selector: z.string().optional()
          .describe("CSS selector to wait for (for 'wait' action)"),
        tabId: z.number().optional()
          .describe("Tab number to switch to (for 'switch_tab')"),
      }),
      execute: async ({ action, id, value, key, direction, selector, tabId }) => {
        // Ensure server is still running (cheap health check, handles Sprite restarts)
        await ensureServerRunning();
        const payload = JSON.stringify({
          action, sessionId, id, value, key, direction, selector, tabId,
        });
        const escaped = payload.replace(/'/g, "'\\''");
        const result = await sandboxClient!.exec(
          `curl -s -X POST http://127.0.0.1:3000/interact -H 'Content-Type: application/json' -d '${escaped}'`,
          { timeout: 60_000 }
        );

        if (!result.success) {
          console.warn("[browse] interact curl failed:", result.stderr);
          return JSON.stringify({
            error: true,
            errorType: "interact_failed",
            message: `Interact failed: ${result.stderr}`,
            hint: "The browser session may have expired. Try browsing the URL again.",
          });
        }

        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(result.stdout);
        } catch {
          console.warn("[browse] interact returned non-JSON:", result.stdout.slice(0, 200));
          return JSON.stringify({
            error: true,
            errorType: "parse_error",
            message: "Browse server returned invalid response",
            hint: "Try browsing the URL again.",
          });
        }

        // Handle screenshot: upload base64 to R2
        if (parsed.screenshot && r2 && botId) {
          const imgBuf = Uint8Array.from(atob(parsed.screenshot as string), c => c.charCodeAt(0));
          const hash = crypto.randomUUID().replace(/-/g, '').slice(0, 12);
          const r2Key = `media/${botId}/${hash}.png`;
          await r2.put(r2Key, imgBuf, { httpMetadata: { contentType: 'image/png' } });
          return `![Screenshot](image:/${r2Key})`;
        }

        return result.stdout;
      },
    }),
  };

  return { tools };
}

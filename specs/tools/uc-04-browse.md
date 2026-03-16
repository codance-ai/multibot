# UC-04: Headless Browser

## Trigger

The LLM invokes `browse` to open a URL with full JavaScript execution, or `browse_interact` to interact with the currently loaded page (click, type, scroll, screenshot, etc.). These tools are only available when the sandbox backend is `"sprites"`.

## Expected Behavior

1. **SSRF prevention**: All URLs are validated via `assertSafeUrl()` before navigation. Blocks private networks (127.x, 10.x, 192.168.x, etc.), IPv6 loopback/link-local, metadata endpoints (metadata.google, metadata.aws), `.internal` domains, and non-http(s) schemes
2. **Playwright installation check**: On first use, checks for a `.playwright-ready-v2` marker file in the sandbox. If missing, triggers a **fire-and-forget background installation** (Playwright + Chromium headless shell, ~30-60s) and returns an error JSON telling the LLM to retry shortly or use `web_fetch` in the meantime. Subsequent calls find the marker and proceed
3. **Browse server**: A Node.js HTTP server (`browse.server.js`) runs inside the Sprites sandbox on port 3000. `ensureServerRunning()` does a health check and starts the server if needed via fire-and-forget exec (Sprites WebSocket doesn't close until background process exits), then polls up to 15 times at 1-second intervals. Concurrent calls share the same startup via a promise lock. If startup fails, server log is included in the error for diagnostics
4. **Session-scoped browser context**: Each chat gets its own browser session ID (`{botId}-{chatId}`), isolating cookies, tabs, and page state across conversations
5. **Browse result format**: Returns a `BrowseResult` JSON with: url, title, tabs, revision number, markdown content (page rendered as markdown with numbered interactive element anchors like `[Button 1: Submit]`), mode (`"browser"`), and interactability flag
6. **Challenge/error detection**: If the Playwright server detects a challenge (Cloudflare, captcha, WAF 403, DDoS protection) or error (timeout, connection error, browser error), the error is returned directly to the LLM as a JSON error response. The LLM can then decide to use `web_fetch` or inform the user
7. **Browse interact**: Supports actions: `click`, `type`, `select`, `press`, `scroll`, `back`, `switch_tab`, `wait`, `screenshot`. Element IDs are refreshed after each action. Screenshot results are uploaded to R2 as PNG and returned as `![Screenshot](image:/{r2Key})`
8. **Content truncation**: Page markdown is capped at `MAX_SNAPSHOT_SIZE` (12,000 chars)
9. **Cleanup**: Browser session cleanup is handled automatically by the browse server's idle timeouts (per-session context TTL + 60-second server-level idle shutdown)

## Example

```
LLM calls: browse({ url: "https://example.com/spa-app" })

→ assertSafeUrl("https://example.com/spa-app") → passes
→ ensureBrowseReady() → marker exists, proceed
→ ensureServerRunning() → health check passes
→ curl POST http://127.0.0.1:3000/browse with { url, sessionId: "d1ea9d49-chatId123" }
→ Server returns BrowseResult JSON with rendered markdown + element anchors
→ Return to LLM:
  {
    "url": "https://example.com/spa-app",
    "title": "SPA App",
    "markdown": "# SPA App\n\n[Button 1: Login] [Input 2: Username]...",
    "mode": "browser",
    "interactable": true
  }
```

```
LLM calls: browse({ url: "https://protected-site.com" })

→ assertSafeUrl() → passes
→ Server returns: { error: true, errorType: "cloudflare_challenge", url: "...", message: "...", hint: "..." }
→ Error returned directly to LLM — LLM decides next action (web_fetch, inform user, etc.)
```

## Key Code Path

- Tool factory: `createBrowseTools()` in `src/tools/browse.ts`
- URL validation: `assertSafeUrl()` in `src/tools/browse-safety.ts`
- Challenge detection: `detectChallengePage()` in `src/tools/browse.ts` (duplicated in `browse.server.js`)
- Error classification: `classifyBrowseError()` in `src/tools/browse.ts`
- Server code: `browse.server.js` imported as text module via wrangler `[[rules]]`
- Screenshot upload: R2 `media/{botId}/{hash}.png`

## Edge Cases

- **First-ever browse call**: Playwright is not installed. Installation is triggered in background (non-blocking). The LLM receives an error JSON suggesting to retry in 30-60 seconds or use `web_fetch`
- **Sandbox restart**: The browse server may have stopped. `ensureServerRunning()` detects this via health check and restarts the server automatically
- **Browse fails (challenge, network error, timeout)**: Error JSON returned directly to LLM with `errorType` and `hint`
- **Non-sprites backend**: `createBrowseTools()` returns an empty `ToolSet`
- **Server health check race**: If server is starting, `ensureServerRunning()` polls up to 15 times (1s each). Fails after 15 seconds with server log included
- **Concurrent browse calls during startup**: Multiple parallel calls share the same startup promise via an in-memory lock, preventing redundant server writes and port conflicts
- **In-memory browseInstalled cache**: Only valid within the same `createBrowseTools()` closure. Across DO restarts or new requests, the marker file on disk is the source of truth

import { tool } from "ai";
import { z } from "zod";
import { extractReadableContent } from "./web-fetch-utils";

const MAX_RESPONSE_LENGTH = 50_000;
const FETCH_TIMEOUT_MS = 15_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const webFetchTool = tool({
  description:
    "Fetch a URL and return its content as clean, readable text. " +
    "Automatically converts HTML pages to markdown using content extraction. " +
    "Works for most websites, articles, docs, and API endpoints. " +
    "Does NOT execute JavaScript — for pages that require JS rendering " +
    "(SPAs, dynamic apps) or interaction (clicking, form filling), use browse instead.",
  inputSchema: z.object({
    url: z.string().describe("The URL to fetch"),
  }),
  execute: async ({ url }) => {
    const resp = await fetch(url, {
      headers: {
        "User-Agent": USER_AGENT,
        Accept:
          "text/markdown, text/html;q=0.9, application/json;q=0.8, */*;q=0.1",
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
    }

    const contentType = resp.headers.get("content-type") ?? "";
    const body = await resp.text();

    let content: string;

    if (contentType.includes("text/markdown")) {
      // Cloudflare Markdown for Agents — server returned pre-rendered markdown
      content = body;
    } else if (contentType.includes("text/html")) {
      // HTML — extract readable content
      const extracted = await extractReadableContent(body, url);
      const title = extracted.title ? `# ${extracted.title}\n\n` : "";
      content = title + extracted.content;
    } else if (contentType.includes("application/json")) {
      // JSON — pretty-print
      try {
        content = JSON.stringify(JSON.parse(body), null, 2);
      } catch (e) {
        console.warn("[web-fetch] JSON.parse failed, returning raw body:", e);
        content = body;
      }
    } else {
      // Everything else — return raw text
      content = body;
    }

    if (content.length > MAX_RESPONSE_LENGTH) {
      const remaining = content.length - MAX_RESPONSE_LENGTH;
      return (
        content.slice(0, MAX_RESPONSE_LENGTH) +
        `\n\n... (truncated, ${remaining} more chars)`
      );
    }
    return content;
  },
});

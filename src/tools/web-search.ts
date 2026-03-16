import { tool } from "ai";
import type { ToolSet } from "ai";
import { z } from "zod";

const MAX_RESULTS = 10;
const DEFAULT_COUNT = 5;
const TIMEOUT_MS = 10_000;

interface BraveWebResult {
  title?: string;
  url?: string;
  description?: string;
}

interface BraveSearchResponse {
  web?: { results?: BraveWebResult[] };
}

export function createWebSearchTool(apiKey: string): ToolSet {
  return {
    web_search: tool({
      description:
        "Search the web for information. Returns titles, URLs, and snippets. " +
        "Use for discovering information, finding URLs, or answering questions. " +
        "To read a specific URL's content, use web_fetch instead.",
      inputSchema: z.object({
        query: z.string().describe("Search query"),
        count: z
          .number()
          .int()
          .min(1)
          .max(MAX_RESULTS)
          .optional()
          .describe("Number of results (1-10, default 5)"),
      }),
      execute: async ({ query, count }) => {
        if (!apiKey) {
          throw new Error("BRAVE_API_KEY not configured");
        }

        const n = Math.min(Math.max(count ?? DEFAULT_COUNT, 1), MAX_RESULTS);

        try {
          const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${n}`;
          const resp = await fetch(url, {
            headers: {
              Accept: "application/json",
              "X-Subscription-Token": apiKey,
            },
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });

          if (!resp.ok) {
            throw new Error(`Brave Search API returned ${resp.status}`);
          }

          const data = (await resp.json()) as BraveSearchResponse;
          const results = data.web?.results ?? [];

          if (results.length === 0) {
            return `No results for: ${query}`;
          }

          const lines = results.map(
            (r, i) =>
              `${i + 1}. ${r.title ?? "(no title)"}\n   ${r.url ?? ""}\n   ${r.description ?? ""}`
          );

          return `Results for: ${query}\n\n${lines.join("\n")}`;
        } catch (e) {
          if (e instanceof Error && e.message.startsWith("Brave ")) throw e;
          throw e instanceof Error ? e : new Error(String(e));
        }
      },
    }),
  };
}

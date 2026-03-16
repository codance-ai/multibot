import { describe, it, expect, vi, beforeEach } from "vitest";
import { createWebSearchTool } from "./web-search";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

function executeTool(apiKey: string, args: Record<string, unknown>) {
  const tools = createWebSearchTool(apiKey);
  const t = tools.web_search as any;
  return t.execute(args, { toolCallId: "test", messages: [], abortSignal: new AbortController().signal });
}

describe("createWebSearchTool", () => {
  it("throws when API key is empty", async () => {
    await expect(executeTool("", { query: "test" })).rejects.toThrow(
      "BRAVE_API_KEY not configured"
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("calls Brave Search API with correct headers", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    });

    await executeTool("BSA-test-key", { query: "cloudflare workers" });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("api.search.brave.com");
    expect(url).toContain("q=cloudflare%20workers");
    expect(url).toContain("count=5");
    expect(opts.headers).toEqual({
      Accept: "application/json",
      "X-Subscription-Token": "BSA-test-key",
    });
  });

  it("uses custom count parameter", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    });

    await executeTool("BSA-key", { query: "test", count: 3 });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("count=3");
  });

  it("clamps count to 1-10 range", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    });

    await executeTool("BSA-key", { query: "test", count: 20 });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("count=10");
  });

  it("formats results with title, url, description", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        web: {
          results: [
            {
              title: "Cloudflare Workers",
              url: "https://workers.cloudflare.com",
              description: "Build serverless applications.",
            },
            {
              title: "Docs",
              url: "https://developers.cloudflare.com",
              description: "Developer documentation.",
            },
          ],
        },
      }),
    });

    const result = await executeTool("BSA-key", { query: "cloudflare" });
    expect(result).toContain("Results for: cloudflare");
    expect(result).toContain("1. Cloudflare Workers");
    expect(result).toContain("https://workers.cloudflare.com");
    expect(result).toContain("Build serverless applications.");
    expect(result).toContain("2. Docs");
  });

  it("returns no results message for empty response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    });

    const result = await executeTool("BSA-key", { query: "xyznonexistent" });
    expect(result).toBe("No results for: xyznonexistent");
  });

  it("throws on API error status", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 429 });

    await expect(executeTool("BSA-key", { query: "test" })).rejects.toThrow(
      "Brave Search API returned 429"
    );
  });

  it("throws on fetch exception", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    await expect(executeTool("BSA-key", { query: "test" })).rejects.toThrow(
      "Network error"
    );
  });

  it("handles missing web field in response", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const result = await executeTool("BSA-key", { query: "test" });
    expect(result).toBe("No results for: test");
  });
});

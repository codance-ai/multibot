import { describe, it, expect, vi, beforeEach } from "vitest";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

// Must import after mocking fetch
import { webFetchTool } from "./web-fetch";

function execute(args: Record<string, unknown>) {
  return (webFetchTool as any).execute(args, {
    toolCallId: "test",
    messages: [],
    abortSignal: new AbortController().signal,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("webFetchTool", () => {
  it("converts HTML responses to markdown", async () => {
    const html = `<html><head><title>Test</title></head><body>
      <article><h1>Hello</h1>
      <p>This is substantial article content for Readability to detect and extract properly from the page.</p>
      <p>More content here to ensure Readability has enough to work with for its heuristics.</p>
      <p>Even more paragraphs to make the content substantial enough for extraction.</p>
      </article></body></html>`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "text/html; charset=utf-8" }),
      text: async () => html,
    });

    const result = await execute({ url: "https://example.com" });
    expect(result).toContain("Hello");
    expect(result).toContain("article content");
    expect(result).not.toContain("<html>");
    expect(result).not.toContain("<article>");
  });

  it("returns markdown directly for text/markdown responses", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "text/markdown" }),
      text: async () => "# Hello\n\nWorld",
    });

    const result = await execute({ url: "https://example.com/doc.md" });
    expect(result).toContain("# Hello");
    expect(result).toContain("World");
  });

  it("formats JSON responses with pretty-print", async () => {
    const json = JSON.stringify({ name: "test", value: 42 });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => json,
    });

    const result = await execute({ url: "https://api.example.com/data" });
    expect(result).toContain('"name": "test"');
    expect(result).toContain('"value": 42');
  });

  it("returns raw text for non-HTML/JSON content types", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "plain text content",
    });

    const result = await execute({ url: "https://example.com/file.txt" });
    expect(result).toContain("plain text content");
  });

  it("truncates long responses", async () => {
    const longText = "x".repeat(60_000);
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => longText,
    });

    const result = await execute({ url: "https://example.com" });
    expect(result.length).toBeLessThan(55_000);
    expect(result).toContain("truncated");
  });

  it("throws on HTTP error", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: "Not Found",
    });

    await expect(
      execute({ url: "https://example.com/missing" }),
    ).rejects.toThrow("HTTP 404");
  });

  it("sends Accept header requesting markdown first", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "text/plain" }),
      text: async () => "ok",
    });

    await execute({ url: "https://example.com" });
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.headers["Accept"]).toContain("text/markdown");
  });

  it("handles invalid JSON gracefully", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      text: async () => "not valid json{",
    });

    const result = await execute({ url: "https://api.example.com" });
    expect(result).toContain("not valid json{");
  });

  it("throws on network errors", async () => {
    mockFetch.mockRejectedValueOnce(new Error("Network error"));

    await expect(
      execute({ url: "https://example.com" }),
    ).rejects.toThrow("Network error");
  });

  it("includes title prefix for HTML pages with title", async () => {
    const html = `<html><head><title>Page Title</title></head><body>
      <p>Some content that is long enough for extraction.</p>
      <p>More content for the page body.</p></body></html>`;
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers({ "content-type": "text/html" }),
      text: async () => html,
    });

    const result = await execute({ url: "https://example.com" });
    expect(result).toContain("Page Title");
  });
});

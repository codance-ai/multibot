import { describe, it, expect } from "vitest";
import { htmlToMarkdown, extractReadableContent } from "./web-fetch-utils";

describe("htmlToMarkdown", () => {
  it("extracts title from <title> tag", () => {
    const html =
      "<html><head><title>My Page</title></head><body><p>Hello</p></body></html>";
    const result = htmlToMarkdown(html);
    expect(result.title).toBe("My Page");
  });

  it("strips script and style tags", () => {
    const html =
      '<script>alert("x")</script><style>.x{}</style><p>Content</p>';
    const result = htmlToMarkdown(html);
    expect(result.text).not.toContain("alert");
    expect(result.text).not.toContain(".x{}");
    expect(result.text).toContain("Content");
  });

  it("converts headings to markdown", () => {
    const html = "<h1>Title</h1><h2>Subtitle</h2><h3>Section</h3>";
    const result = htmlToMarkdown(html);
    expect(result.text).toContain("# Title");
    expect(result.text).toContain("## Subtitle");
    expect(result.text).toContain("### Section");
  });

  it("converts links to markdown", () => {
    const html = '<a href="https://example.com">Example</a>';
    const result = htmlToMarkdown(html);
    expect(result.text).toContain("[Example](https://example.com)");
  });

  it("converts list items", () => {
    const html = "<ul><li>First</li><li>Second</li></ul>";
    const result = htmlToMarkdown(html);
    expect(result.text).toContain("- First");
    expect(result.text).toContain("- Second");
  });

  it("normalizes whitespace", () => {
    const html = "<p>Hello   \n\n\n\n  world</p>";
    const result = htmlToMarkdown(html);
    expect(result.text).not.toMatch(/\n{3,}/);
    expect(result.text).not.toMatch(/ {2,}/);
  });

  it("returns empty for empty input", () => {
    const result = htmlToMarkdown("");
    expect(result.text).toBe("");
  });

  it("decodes HTML entities", () => {
    const html = "<p>&amp; &lt;tag&gt; &quot;quoted&quot;</p>";
    const result = htmlToMarkdown(html);
    expect(result.text).toContain('& <tag> "quoted"');
  });

  it("strips noscript tags", () => {
    const html = "<noscript>Enable JS</noscript><p>Content</p>";
    const result = htmlToMarkdown(html);
    expect(result.text).not.toContain("Enable JS");
    expect(result.text).toContain("Content");
  });
});

describe("extractReadableContent", () => {
  it("extracts article content from well-structured HTML", async () => {
    const html = `
      <html><head><title>Test Article</title></head>
      <body>
        <nav>Navigation stuff</nav>
        <article>
          <h1>Article Title</h1>
          <p>This is the main content of the article. It contains enough text
          for Readability to identify it as the main content block of this page.
          We need sufficient text length for the heuristics to work properly.</p>
          <p>Another paragraph with more substantial content to help Readability's
          heuristics determine this is indeed the article body. The more content
          we have here, the more reliable the extraction becomes.</p>
          <p>A third paragraph adds even more weight to this article section,
          making it abundantly clear to the algorithm that this is the primary
          content area of the page.</p>
        </article>
        <footer>Footer stuff</footer>
      </body></html>`;
    const result = await extractReadableContent(html, "https://example.com");
    expect(result).not.toBeNull();
    expect(result.content).toContain("main content");
    expect(result.title).toBeTruthy();
  });

  it("falls back to htmlToMarkdown when Readability cannot parse", async () => {
    const html = "<p>Simple paragraph</p>";
    const result = await extractReadableContent(html, "https://example.com");
    expect(result).not.toBeNull();
    expect(result.content).toContain("Simple paragraph");
  });

  it("handles malformed HTML gracefully", async () => {
    const html = "<div><p>Unclosed tags <b>bold";
    const result = await extractReadableContent(html, "https://example.com");
    expect(result).not.toBeNull();
    expect(result.content).toContain("Unclosed tags");
  });

  it("truncates pathologically large HTML", async () => {
    const html = `<html><body><p>${"x".repeat(1_100_000)}</p></body></html>`;
    const result = await extractReadableContent(html, "https://example.com");
    expect(result).not.toBeNull();
    // Should not throw OOM — content is truncated before parsing
  });
});

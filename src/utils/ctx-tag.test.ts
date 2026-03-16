import { describe, it, expect } from "vitest";
import { buildCtxTag } from "./ctx-tag";

describe("buildCtxTag", () => {
  it("returns empty string when no metadata", () => {
    expect(buildCtxTag({})).toBe("");
  });

  it("builds tag with tools only", () => {
    expect(buildCtxTag({ tools: ["web_search"] })).toBe('<_ctx tools="web_search" />');
  });

  it("builds tag with multiple tools", () => {
    expect(buildCtxTag({ tools: ["gen", "browse"] })).toBe('<_ctx tools="gen, browse" />');
  });

  it("builds tag with media counts", () => {
    expect(buildCtxTag({ images: 2, files: 1 })).toBe('<_ctx media="2 images, 1 file" />');
  });

  it("builds tag with single image", () => {
    expect(buildCtxTag({ images: 1 })).toBe('<_ctx media="1 image" />');
  });

  it("builds tag with single file", () => {
    expect(buildCtxTag({ files: 1 })).toBe('<_ctx media="1 file" />');
  });

  it("builds tag with tools and media", () => {
    expect(buildCtxTag({ tools: ["gen"], images: 1 })).toBe('<_ctx tools="gen" media="1 image" />');
  });

  it("ignores zero counts", () => {
    expect(buildCtxTag({ images: 0, files: 0 })).toBe("");
  });

  it("builds tag with tools and no media", () => {
    expect(buildCtxTag({ tools: ["exec"], images: 0 })).toBe('<_ctx tools="exec" />');
  });

  it("escapes XML special characters in tool names", () => {
    expect(buildCtxTag({ tools: ['mcp_"test"'] })).toBe('<_ctx tools="mcp_&quot;test&quot;" />');
  });

  it("escapes ampersand in tool names", () => {
    expect(buildCtxTag({ tools: ["a&b"] })).toBe('<_ctx tools="a&amp;b" />');
  });

  it("escapes angle brackets in tool names", () => {
    expect(buildCtxTag({ tools: ["a<b>c"] })).toBe('<_ctx tools="a&lt;b&gt;c" />');
  });
});

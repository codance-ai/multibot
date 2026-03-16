import { describe, it, expect } from "vitest";
import { chunkText, formatTelegramMarkdown, formatSlackMarkdown, parseRetryAfterMs } from "./utils";

describe("chunkText", () => {
  it("returns single chunk for short text", () => {
    expect(chunkText("hello", 100)).toEqual(["hello"]);
  });

  it("splits text at maxLength boundaries", () => {
    const text = "a".repeat(5000);
    const chunks = chunkText(text, 2000);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(2000);
    expect(chunks[1]).toHaveLength(2000);
    expect(chunks[2]).toHaveLength(1000);
  });

  it("handles empty text", () => {
    expect(chunkText("", 100)).toEqual([""]);
  });

  it("handles text exactly at maxLength", () => {
    const text = "a".repeat(4096);
    expect(chunkText(text, 4096)).toEqual([text]);
  });

  it("does not split surrogate pairs (emoji)", () => {
    // 😀 is a surrogate pair (\uD83D\uDE00), 2 code units
    const text = "a".repeat(4095) + "😀"; // 4097 code units
    const chunks = chunkText(text, 4096);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("a".repeat(4095));
    expect(chunks[1]).toBe("😀");
  });

  it("handles maxLength=0 without infinite loop", () => {
    expect(chunkText("hello", 0)).toEqual(["hello"]);
  });

  it("handles maxLength < 0 without infinite loop", () => {
    expect(chunkText("test", -1)).toEqual(["test"]);
  });
});

describe("formatTelegramMarkdown", () => {
  it("converts **bold** to *bold*", () => {
    expect(formatTelegramMarkdown("Hello **world**")).toBe("Hello *world*");
  });

  it("converts ### heading to bold", () => {
    expect(formatTelegramMarkdown("### Title\nContent")).toBe("*Title*\nContent");
  });

  it("converts ## heading to bold", () => {
    expect(formatTelegramMarkdown("## Section")).toBe("*Section*");
  });

  it("converts # heading to bold", () => {
    expect(formatTelegramMarkdown("# Main Title")).toBe("*Main Title*");
  });

  it("preserves inline code", () => {
    expect(formatTelegramMarkdown("Use `**not bold**` here")).toBe("Use `**not bold**` here");
  });

  it("preserves code blocks", () => {
    const input = "Before\n```\n**not bold**\n```\nAfter **bold**";
    const expected = "Before\n```\n**not bold**\n```\nAfter *bold*";
    expect(formatTelegramMarkdown(input)).toBe(expected);
  });

  it("strips ~~strikethrough~~ markers", () => {
    expect(formatTelegramMarkdown("~~deleted~~")).toBe("deleted");
  });

  it("passes through plain text unchanged", () => {
    expect(formatTelegramMarkdown("plain text")).toBe("plain text");
  });

  it("converts - list items to bullet dots", () => {
    expect(formatTelegramMarkdown("- item one\n- item two")).toBe("• item one\n• item two");
  });

  it("handles bold inside heading without double asterisks", () => {
    expect(formatTelegramMarkdown("## Features **new**")).toBe("*Features new*");
  });

  it("handles unclosed backtick gracefully", () => {
    const input = "Use ` to denote code";
    expect(formatTelegramMarkdown(input)).toBe("Use ` to denote code");
  });

  it("preserves _italic_ unchanged", () => {
    expect(formatTelegramMarkdown("This is _italic_ text")).toBe("This is _italic_ text");
  });

  it("handles multiple code blocks", () => {
    const input = "A ```x``` B ```y``` C **bold**";
    expect(formatTelegramMarkdown(input)).toBe("A ```x``` B ```y``` C *bold*");
  });
});

describe("formatSlackMarkdown", () => {
  it("converts **bold** to *bold*", () => {
    expect(formatSlackMarkdown("Hello **world**")).toBe("Hello *world*");
  });

  it("converts [text](url) to <url|text>", () => {
    expect(formatSlackMarkdown("[click here](https://example.com)"))
      .toBe("<https://example.com|click here>");
  });

  it("converts ~~strike~~ to ~strike~", () => {
    expect(formatSlackMarkdown("~~deleted~~")).toBe("~deleted~");
  });

  it("converts heading markers to bold", () => {
    expect(formatSlackMarkdown("### Title")).toBe("*Title*");
  });

  it("preserves inline code", () => {
    expect(formatSlackMarkdown("Use `**not bold**`")).toBe("Use `**not bold**`");
  });

  it("preserves code blocks", () => {
    const input = "```\n**not bold**\n```";
    expect(formatSlackMarkdown(input)).toBe("```\n**not bold**\n```");
  });

  it("passes through plain text unchanged", () => {
    expect(formatSlackMarkdown("plain text")).toBe("plain text");
  });

  it("converts - list items to bullet dots", () => {
    expect(formatSlackMarkdown("- item one\n- item two")).toBe("• item one\n• item two");
  });

  it("handles bold inside heading without double asterisks", () => {
    expect(formatSlackMarkdown("## Features **new**")).toBe("*Features new*");
  });

  it("encodes pipe chars in URLs", () => {
    expect(formatSlackMarkdown("[link](https://x.com/a|b)")).toBe("<https://x.com/a%7Cb|link>");
  });

  it("handles unclosed backtick gracefully", () => {
    const input = "Use ` to denote code";
    expect(formatSlackMarkdown(input)).toBe("Use ` to denote code");
  });
});

describe("parseRetryAfterMs", () => {
  it("converts seconds to milliseconds", () => {
    expect(parseRetryAfterMs("2")).toBe(2000);
    expect(parseRetryAfterMs("0.5")).toBe(500);
  });

  it("returns undefined for null/undefined/empty", () => {
    expect(parseRetryAfterMs(null)).toBeUndefined();
    expect(parseRetryAfterMs(undefined)).toBeUndefined();
    expect(parseRetryAfterMs("")).toBeUndefined();
  });

  it("returns undefined for non-numeric values", () => {
    expect(parseRetryAfterMs("abc")).toBeUndefined();
    expect(parseRetryAfterMs("NaN")).toBeUndefined();
  });

  it("returns undefined for zero or negative values", () => {
    expect(parseRetryAfterMs("0")).toBeUndefined();
    expect(parseRetryAfterMs("-1")).toBeUndefined();
  });
});

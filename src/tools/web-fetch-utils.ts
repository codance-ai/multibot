import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";

const MAX_HTML_CHARS = 1_000_000;

/** Regex-based HTML→markdown converter. Used as fallback when Readability fails. */
export function htmlToMarkdown(html: string): { text: string; title?: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : undefined;

  let text = html
    .replace(/<head[\s\S]*?<\/head>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, "");

  // Convert links
  text = text.replace(
    /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, body) => {
      const label = normalizeWhitespace(stripTags(body));
      return label ? `[${label}](${href})` : href;
    },
  );

  // Convert headings
  text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, body) => {
    const prefix = "#".repeat(Math.max(1, Math.min(6, Number.parseInt(level, 10))));
    return `\n${prefix} ${normalizeWhitespace(stripTags(body))}\n`;
  });

  // Convert list items
  text = text.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_, body) => {
    const label = normalizeWhitespace(stripTags(body));
    return label ? `\n- ${label}` : "";
  });

  // Convert breaks and block elements
  text = text
    .replace(/<(br|hr)\s*\/?>/gi, "\n")
    .replace(
      /<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi,
      "\n",
    );

  text = stripTags(text);
  text = normalizeWhitespace(text);
  return { text, title };
}

/**
 * Extract readable content using Readability + linkedom.
 * Falls back to htmlToMarkdown if Readability cannot parse.
 */
export async function extractReadableContent(
  html: string,
  url: string,
): Promise<{ content: string; title?: string }> {
  // Guard against pathologically large HTML
  const safeHtml = html.length > MAX_HTML_CHARS ? html.slice(0, MAX_HTML_CHARS) : html;

  try {
    const { document } = parseHTML(safeHtml);
    // Set base URI so Readability resolves relative links correctly
    (document as any).documentURI = url;
    const reader = new Readability(document, { charThreshold: 0 });
    const parsed = reader.parse();

    if (parsed?.content) {
      const rendered = htmlToMarkdown(parsed.content);
      return {
        content: rendered.text,
        title: parsed.title || rendered.title,
      };
    }
  } catch (e) {
    console.warn("[web-fetch] Readability extraction failed, falling back to htmlToMarkdown:", e);
  }

  // Fallback: regex-based conversion
  const fallback = htmlToMarkdown(safeHtml);
  return { content: fallback.text, title: fallback.title };
}

function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ""));
}

function decodeEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

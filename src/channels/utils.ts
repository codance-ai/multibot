/**
 * Split text into chunks of at most maxLength characters.
 * Handles multi-byte Unicode (emoji, CJK) by splitting on code point boundaries.
 */
export function chunkText(text: string, maxLength: number): string[] {
  if (maxLength <= 0) return [text];
  if (text.length <= maxLength) return [text];
  const chunks: string[] = [];
  const codePoints = [...text]; // splits on code point boundaries (handles surrogate pairs)
  let start = 0;
  while (start < codePoints.length) {
    let end = start;
    let len = 0;
    while (end < codePoints.length) {
      const charLen = codePoints[end].length; // 1 for BMP, 2 for surrogate pairs
      if (len + charLen > maxLength) break;
      len += charLen;
      end++;
    }
    if (end === start) {
      // Single code point exceeds maxLength (e.g. surrogate pair with maxLength=1)
      chunks.push(codePoints[start]);
      start++;
    } else {
      chunks.push(codePoints.slice(start, end).join(""));
      start = end;
    }
  }
  return chunks;
}

/**
 * Apply a transform function only to text outside of code blocks and inline code.
 * Code blocks (``` ... ```) and inline code (` ... `) are preserved unchanged.
 * Inline code pattern is constrained to single-line, max 200 chars to avoid ReDoS.
 */
function transformOutsideCode(text: string, transform: (segment: string) => string): string {
  const parts = text.split(/(```[\s\S]*?```|`[^`\n]{1,200}`)/g);
  return parts
    .map((part, i) => {
      // Odd indices are captured code groups — preserve unchanged
      if (i % 2 === 1) return part;
      return transform(part);
    })
    .join("");
}

/**
 * Convert standard markdown to Telegram Markdown v1 compatible format.
 * - **bold** → *bold*
 * - ### Heading → *Heading* (headings rendered as bold)
 * - ~~strike~~ → stripped (not supported in v1)
 * - - list → • list
 * - Preserves code blocks and inline code
 */
export function formatTelegramMarkdown(text: string): string {
  return transformOutsideCode(text, (segment) => {
    let result = segment;
    // Strip ** inside heading captures before wrapping, so "## Title **bold**" → "*Title bold*"
    result = result.replace(/^#{1,6}\s+(.+)$/gm, (_match, content: string) => {
      const stripped = content.replace(/\*\*(.+?)\*\*/g, "$1");
      return `*${stripped}*`;
    });
    result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
    result = result.replace(/~~(.+?)~~/g, "$1");
    result = result.replace(/^- /gm, "• ");
    return result;
  });
}

/** Parse Retry-After header (seconds) into milliseconds. */
export function parseRetryAfterMs(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined;
}

/**
 * Convert standard markdown to Slack mrkdwn format.
 * - **bold** → *bold*
 * - [text](url) → <url|text>
 * - ~~strike~~ → ~strike~
 * - ### Heading → *Heading*
 * - - list → • list
 * - Preserves code blocks and inline code
 */
export function formatSlackMarkdown(text: string): string {
  return transformOutsideCode(text, (segment) => {
    let result = segment;
    // Strip ** inside heading captures before wrapping
    result = result.replace(/^#{1,6}\s+(.+)$/gm, (_match, content: string) => {
      const stripped = content.replace(/\*\*(.+?)\*\*/g, "$1");
      return `*${stripped}*`;
    });
    // Encode pipe chars in URLs to avoid breaking Slack's <url|text> format
    result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text: string, url: string) =>
      `<${url.replace(/\|/g, "%7C")}|${text}>`
    );
    result = result.replace(/\*\*(.+?)\*\*/g, "*$1*");
    result = result.replace(/~~(.+?)~~/g, "~$1~");
    result = result.replace(/^- /gm, "• ");
    return result;
  });
}

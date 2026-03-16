/**
 * Check if a reply is a [skip] or empty (bot chose silence in group chat).
 */
export function isSkipReply(reply: string): boolean {
  const trimmed = reply.trim().toLowerCase();
  return trimmed === "" || trimmed === "[skip]";
}

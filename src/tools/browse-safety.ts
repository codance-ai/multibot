/**
 * SSRF protection: validate that a URL is safe to navigate to.
 * Blocks private networks, metadata endpoints, and non-http(s) schemes.
 */
export function assertSafeUrl(url: string): void {
  const parsed = new URL(url); // throws on invalid URL

  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Only http/https URLs are allowed");
  }

  // Strip IPv6 brackets: URL.hostname returns "[::1]" for IPv6, normalize for regex matching
  const hostname = parsed.hostname.replace(/^\[|]$/g, "").toLowerCase();

  const blocked: RegExp[] = [
    // IPv4 private/reserved
    /^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
    /^169\.254\./, /^0\./, /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./,
    // IPv6
    /^::1$/, /^fe80:/i, /^fc00:/i, /^fd/i, /^fdaa:/i,
    // Special hostnames
    /^localhost$/i,
    /^metadata\.google/i,
    /^metadata\.aws/i,
    /\.internal$/i,
  ];

  if (blocked.some((re) => re.test(hostname))) {
    throw new Error("Access to internal/private network addresses is not allowed");
  }
}

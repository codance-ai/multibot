export interface CtxTagParams {
  tools?: string[];
  images?: number;
  files?: number;
}

/** Escape XML attribute value special characters */
function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Build a <_ctx /> XML self-closing tag for conversation history metadata.
 * Returns empty string if there's nothing to annotate.
 *
 * Examples:
 *   <_ctx tools="gen, browse" media="1 image" />
 *   <_ctx media="2 images, 1 file" />
 *   <_ctx tools="web_search" />
 */
export function buildCtxTag(params: CtxTagParams): string {
  const attrs: string[] = [];

  if (params.tools && params.tools.length > 0) {
    const val = escapeXmlAttr(params.tools.join(", "));
    attrs.push(`tools="${val}"`);
  }

  const mediaParts: string[] = [];
  if (params.images && params.images > 0) {
    mediaParts.push(`${params.images} image${params.images > 1 ? "s" : ""}`);
  }
  if (params.files && params.files > 0) {
    mediaParts.push(`${params.files} file${params.files > 1 ? "s" : ""}`);
  }
  if (mediaParts.length > 0) {
    attrs.push(`media="${mediaParts.join(", ")}"`);
  }

  if (attrs.length === 0) return "";
  return `<_ctx ${attrs.join(" ")} />`;
}

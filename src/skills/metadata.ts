/** Known metadata namespace keys used by skill registries. */
const METADATA_NAMESPACES = ["nanobot", "openclaw", "clawdbot"];

/**
 * Resolve the metadata object from a parsed JSON metadata block.
 * Checks known namespaces (nanobot, openclaw, clawdbot) in order,
 * returning the first matching sub-object.
 */
export function resolveMetadataNamespace(
  parsed: Record<string, unknown>,
): Record<string, unknown> {
  for (const ns of METADATA_NAMESPACES) {
    const candidate = parsed[ns];
    if (candidate && typeof candidate === "object") {
      return candidate as Record<string, unknown>;
    }
  }
  // Fallback: use raw object for unnamespaced metadata like {"emoji":"🔧"}
  return parsed;
}

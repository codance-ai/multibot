import type { AttachmentRef } from "../channels/registry";
import { mapWithConcurrency } from "./concurrency";

const IMAGE_MIME_TYPES = new Set([
  "image/jpeg",
  "image/jpg",
  "image/png",
  "image/gif",
  "image/webp",
]);
const FILE_PART_MIME_TYPES = new Set(["application/pdf"]);
export const MAX_INLINE_TEXT_SIZE = 50 * 1024; // 50 KB

export function isInlineTextType(mediaType: string): boolean {
  return (
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType === "application/xml"
  );
}

/** Sanitize filename for safe sandbox path: remove path separators, control chars, collapse whitespace. */
export function sanitizeFileName(name: string): string {
  return name
    .replace(/[/\\]/g, "_")         // path separators
    .replace(/[<>:"|?*]/g, "_")     // shell/OS-unsafe chars
    .replace(/[\x00-\x1f\x7f]/g, "") // control characters
    .replace(/\s+/g, "_")           // whitespace → underscore
    .replace(/_{2,}/g, "_")         // collapse multiple underscores
    .replace(/^[._]+/, "")          // strip leading dots/underscores (hidden files)
    .slice(0, 200)                  // cap length
    || "file";                      // fallback if empty after sanitization
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export type ContentPart =
  | { type: "image"; image: Uint8Array; mediaType: string }
  | { type: "file"; data: Uint8Array; mediaType: string }
  | { type: "text"; text: string };

export interface SandboxFile {
  /** Sandbox path, e.g. "/tmp/attachments/abc123_report.pdf" */
  path: string;
  /** Raw file bytes to write to sandbox */
  data: Uint8Array;
  /** Original filename (may be undefined) */
  fileName?: string;
  /** MIME type */
  mediaType: string;
  /** File size in bytes */
  sizeBytes: number;
}

export interface ResolvedAttachments {
  /** Content parts to include in the LLM user message. */
  contentParts: ContentPart[];
  /** Metadata text for unsupported/oversized files, e.g. "[Attached: report.xlsx (2.3 MB)]" */
  metadataText?: string;
  /** Files to materialize to sandbox filesystem for skill/exec access. */
  sandboxFiles: SandboxFile[];
}

/**
 * Generate metadata text for unsupported/oversized attachments without reading R2.
 * Used by the coordinator to build effectiveUserMessage for D1 persistence.
 */
export function getAttachmentMetadataText(attachments: AttachmentRef[]): string | undefined {
  const metadataLines: string[] = [];
  for (const att of attachments) {
    if (IMAGE_MIME_TYPES.has(att.mediaType) || FILE_PART_MIME_TYPES.has(att.mediaType)) {
      continue;
    }
    if (isInlineTextType(att.mediaType)) {
      // When sizeBytes is unknown, conservatively assume inline (small).
      // If the file is actually oversized, resolveAttachmentsForLLM handles it per-bot.
      if (!att.sizeBytes || att.sizeBytes <= MAX_INLINE_TEXT_SIZE) continue;
    }
    const name = att.fileName ?? att.mediaType;
    const size = att.sizeBytes ? ` (${formatSize(att.sizeBytes)})` : "";
    metadataLines.push(`[Attached: ${name}${size}, type: ${att.mediaType}]`);
  }
  return metadataLines.length > 0 ? metadataLines.join("\n") : undefined;
}

/**
 * Resolve AttachmentRefs into LLM content parts by fetching from R2.
 * - image/* → ImagePart
 * - application/pdf → FilePart
 * - text/* ≤ 50KB → inline TextPart
 * - other/oversized → metadata annotation only
 */
/** Per-attachment resolved result, used to reassemble in order after parallel processing. */
interface ResolvedItem {
  contentPart?: ContentPart;
  metadataLine?: string;
  sandboxFile?: SandboxFile;
}

export async function resolveAttachmentsForLLM(
  attachments: AttachmentRef[],
  bucket: R2Bucket,
): Promise<ResolvedAttachments> {
  const mapped = await mapWithConcurrency(
    attachments,
    async (att): Promise<ResolvedItem | null> => {
      try {
        const obj = await bucket.get(att.r2Key);
        if (!obj) return null;
        const bytes = new Uint8Array(await obj.arrayBuffer());

        const result: ResolvedItem = {};

        // Build sandbox path for every successfully-fetched file
        const safeId = sanitizeFileName(att.id);
        const safeName = sanitizeFileName(att.fileName ?? att.mediaType.replace("/", "_"));
        const sandboxPath = `/tmp/attachments/${safeId}_${safeName}`;
        result.sandboxFile = {
          path: sandboxPath,
          data: bytes,
          fileName: att.fileName,
          mediaType: att.mediaType,
          sizeBytes: bytes.byteLength,
        };

        if (IMAGE_MIME_TYPES.has(att.mediaType)) {
          result.contentPart = {
            type: "image",
            image: bytes,
            mediaType: att.mediaType,
          };
        } else if (FILE_PART_MIME_TYPES.has(att.mediaType)) {
          result.contentPart = {
            type: "file",
            data: bytes,
            mediaType: att.mediaType,
          };
        } else if (
          isInlineTextType(att.mediaType) &&
          bytes.byteLength <= MAX_INLINE_TEXT_SIZE
        ) {
          const text = new TextDecoder().decode(bytes);
          const label = att.fileName
            ? `[File: ${att.fileName}]`
            : `[File: ${att.mediaType}]`;
          result.contentPart = { type: "text", text: `${label}\n${text}` };
        } else {
          const name = att.fileName ?? att.mediaType;
          const size = att.sizeBytes
            ? ` (${formatSize(att.sizeBytes)})`
            : "";
          result.metadataLine = `[Attached: ${name}${size}, type: ${att.mediaType}]`;
        }

        return result;
      } catch (e) {
        // Skip failed R2 reads
        console.warn("[attachment] R2 read failed for:", att.r2Key, e);
        return null;
      }
    },
    3,
  );

  // Reassemble in input order, skipping nulls (failed/missing)
  const contentParts: ContentPart[] = [];
  const metadataLines: string[] = [];
  const sandboxFiles: SandboxFile[] = [];

  for (const item of mapped) {
    if (!item) continue;
    if (item.contentPart) contentParts.push(item.contentPart);
    if (item.metadataLine) metadataLines.push(item.metadataLine);
    if (item.sandboxFile) sandboxFiles.push(item.sandboxFile);
  }

  return {
    contentParts,
    metadataText:
      metadataLines.length > 0 ? metadataLines.join("\n") : undefined,
    sandboxFiles,
  };
}

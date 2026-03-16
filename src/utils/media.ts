import type { MediaItem } from "../channels/registry";

export interface ParsedImageRef {
  fullMatch: string;
  alt: string;
  path: string;
}

/**
 * Parse image references from text.
 * Matches patterns like: ![alt text](image:/media/xxx.png) or ![alt](image:https://url)
 */
export function parseImageReferences(text: string): ParsedImageRef[] {
  const re = /!\[([^\]]*)\]\(image:([^)]+)\)/g;
  const refs: ParsedImageRef[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    refs.push({ fullMatch: match[0], alt: match[1], path: match[2] });
  }
  return refs;
}

/**
 * Strip all `![...](image:...)` markdown references from text.
 * Useful for removing LLM-hallucinated image paths before appending authoritative refs.
 */
export function stripImageReferences(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\(image:([^)]+)\)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract image references from reply text for channel delivery.
 * Returns cleaned text (references removed) and MediaItem[] for attachments.
 * Relative paths are resolved against baseUrl.
 */
export function extractImageReferences(
  text: string,
  baseUrl?: string,
): { cleanedText: string; media: MediaItem[] } {
  const refs = parseImageReferences(text);

  let cleanedText = text;
  const media: MediaItem[] = [];

  for (const ref of refs) {
    cleanedText = cleanedText.replace(ref.fullMatch, "");
    const url = ref.path.startsWith("/") && baseUrl
      ? `${baseUrl}${ref.path}`
      : ref.path;
    media.push({ kind: "image", source: { type: "url", url } });
  }

  // Strip any references to /workspace/ paths (sandbox-local, unreachable outside).
  // Handles both markdown format ![...](/workspace/...) and bare references like
  // image:/workspace/... or plain /workspace/... regardless of LLM output format.
  cleanedText = cleanedText.replace(/!\[[^\]]*\]\([^)]*\/workspace\/[^)]+\)/g, "");
  cleanedText = cleanedText.replace(/(?<![/\w])(?:[a-zA-Z][-a-zA-Z]*:)?\/workspace\/[^\s)\]"']+/g, "");

  cleanedText = cleanedText.replace(/\n{3,}/g, "\n\n").trim();
  return { cleanedText, media };
}

export interface ImageAttachment {
  url: string;
  alt: string;
  mediaType: string;
}

export interface NormalizedReply {
  text: string;
  attachments: ImageAttachment[];
}

const EXT_TO_MIME: Record<string, string> = {
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};

function inferMediaType(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_MIME[ext] ?? "image/png";
}

function imagePlaceholder(): string {
  return "";
}

export function normalizeAssistantReply(
  text: string,
  baseUrl?: string,
): NormalizedReply {
  if (!text) return { text: "", attachments: [] };

  const attachments: ImageAttachment[] = [];
  let result = text;

  // 1. Extract image: protocol refs (authoritative — added to attachments array)
  const imageProtoRe = /!\[([^\]]*)\]\(image:([^)]+)\)/g;
  result = result.replace(imageProtoRe, (_match, alt: string, path: string) => {
    const url = path.startsWith("/") && baseUrl ? `${baseUrl}${path}` : path;
    attachments.push({ url, alt, mediaType: inferMediaType(path) });
    return imagePlaceholder();
  });

  // 2. Strip plain markdown refs pointing at /media/ (hallucinated — placeholder only)
  const mediaRe = /!\[([^\]]*)\]\(\/media\/[^)]+\)/g;
  result = result.replace(mediaRe, () => {
    return imagePlaceholder();
  });

  // 3. Strip /workspace/ refs entirely (unreachable sandbox paths).
  // Handles both markdown format and bare references regardless of LLM output format.
  result = result.replace(/!\[[^\]]*\]\([^)]*\/workspace\/[^)]+\)/g, "");
  result = result.replace(/(?<![/\w])(?:[a-zA-Z][-a-zA-Z]*:)?\/workspace\/[^\s)\]"']+/g, "");

  result = result.replace(/\n{3,}/g, "\n\n").trim();

  return { text: result, attachments };
}

/** Only allow safe filenames under /workspace/images/ — prevents shell injection. */
const SAFE_WORKSPACE_IMAGE = /^\/workspace\/images\/[a-zA-Z0-9._-]+$/;

/**
 * Resolve workspace image paths by uploading them via HTTP PUT to the internal upload endpoint.
 * Uses curl inside the sandbox to push the file directly to the upload URL.
 * Replaces image:/workspace/... references with image:/media/... references.
 *
 * Features:
 * - HTTP upload: avoids base64 encoding overhead and WebSocket size limits
 * - Deduplication: each unique path uploaded only once
 * - Graceful degradation: on curl failure or bad response, original ref is preserved
 */
export async function resolveWorkspaceImages(
  text: string,
  execFn: (command: string) => Promise<{ stdout: string }>,
  uploadUrl: string,
): Promise<string> {
  const refs = parseImageReferences(text).filter(
    (ref) => ref.path.startsWith("/workspace/"),
  );
  if (refs.length === 0) return text;

  // Validate paths and deduplicate
  const seenPaths = new Set<string>();
  const safePaths: string[] = [];
  for (const ref of refs) {
    if (!SAFE_WORKSPACE_IMAGE.test(ref.path)) {
      console.warn(JSON.stringify({ msg: "resolveWorkspaceImages: unsafe path skipped", path: ref.path }));
      continue;
    }
    if (!seenPaths.has(ref.path)) {
      seenPaths.add(ref.path);
      safePaths.push(ref.path);
    }
  }
  if (safePaths.length === 0) return text;

  // Guard: uploadUrl must not contain single quotes (would break shell command)
  // In practice, uploadUrl contains base64url JWT + encodeURIComponent params, so this is safe.
  if (uploadUrl.includes("'")) {
    console.warn(JSON.stringify({ msg: "resolveWorkspaceImages: unsafe uploadUrl, skipping" }));
    return text;
  }

  // Upload each image via curl inside the sandbox
  const uploadResults = await Promise.all(
    safePaths.map(async (wsPath) => {
      // Shell-quote the path (replace ' with '\'')
      const quotedPath = `'${wsPath.replace(/'/g, "'\\''")}'`;
      const cmd = `curl -sf --max-time 30 -X PUT --data-binary @${quotedPath} '${uploadUrl}'`;
      try {
        const result = await execFn(cmd);
        let parsed: { path?: string };
        try {
          parsed = JSON.parse(result.stdout);
        } catch {
          console.warn(JSON.stringify({
            msg: "resolveWorkspaceImages: non-JSON upload response",
            wsPath,
            stdout: result.stdout,
          }));
          return null;
        }
        if (typeof parsed.path !== "string" || !parsed.path.startsWith("/media/")) {
          console.warn(JSON.stringify({
            msg: "resolveWorkspaceImages: unexpected path in upload response",
            wsPath,
            path: parsed.path,
          }));
          return null;
        }
        const r2Path = parsed.path;
        console.log(JSON.stringify({ msg: "resolveWorkspaceImages: uploaded via HTTP", wsPath, r2Path }));
        return { wsPath, r2Path };
      } catch (e) {
        console.warn(JSON.stringify({
          msg: "resolveWorkspaceImages: upload failed",
          wsPath,
          error: e instanceof Error ? e.message : String(e),
        }));
        return null;
      }
    }),
  );

  let result = text;
  for (const entry of uploadResults) {
    if (entry) {
      result = result.replaceAll(`image:${entry.wsPath}`, `image:${entry.r2Path}`);
    }
  }
  return result;
}

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
};

/**
 * Upload image data to R2 and return the relative path.
 * Path format: /media/{botId}/{timestamp}_{randomId}.{ext}
 */
export async function uploadImageToR2(
  bucket: R2Bucket,
  botId: string,
  imageData: ArrayBuffer | Uint8Array,
  mediaType: string = "image/png",
): Promise<string> {
  const timestamp = Date.now();
  const randomId = crypto.randomUUID().slice(0, 8);
  const ext = MIME_TO_EXT[mediaType] ?? "png";
  const key = `media/${botId}/${timestamp}_${randomId}.${ext}`;

  await bucket.put(key, imageData, {
    httpMetadata: { contentType: mediaType },
  });

  return `/${key}`;
}

import type { AttachmentRef } from "../channels/registry";
import { mapWithConcurrency } from "./concurrency";

/** Channel-agnostic reference to a file that needs downloading. */
export interface ChannelFileRef {
  /** Direct download URL, or `__telegram_file_id__:<file_id>` for Telegram files. */
  downloadUrl: string;
  /** Optional Authorization header value (e.g. for Slack). */
  authHeader?: string;
  /** MIME type of the file. */
  mediaType: string;
  /** Original filename from the channel. */
  fileName?: string;
}

const TELEGRAM_FILE_ID_PREFIX = "__telegram_file_id__:";
const MAX_FILE_SIZE = 20 * 1024 * 1024; // 20 MB

const MIME_TO_EXT: Record<string, string> = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "application/pdf": "pdf",
  "text/plain": "txt",
  "text/csv": "csv",
  "text/html": "html",
  "text/markdown": "md",
  "application/json": "json",
  "application/xml": "xml",
};

function inferExtension(mediaType: string, fileName?: string): string {
  if (MIME_TO_EXT[mediaType]) return MIME_TO_EXT[mediaType];
  if (fileName) {
    const dot = fileName.lastIndexOf(".");
    if (dot >= 0) {
      const raw = fileName.slice(dot + 1).toLowerCase();
      if (/^[a-z0-9]+$/.test(raw)) return raw;
    }
  }
  return "bin";
}

/**
 * Resolve a Telegram file_id to a download URL via the Bot API.
 * Returns undefined if the resolution fails.
 */
async function resolveTelegramFileUrl(
  fileId: string,
  channelToken: string,
): Promise<string | undefined> {
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${channelToken}/getFile`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ file_id: fileId }),
      },
    );
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      ok: boolean;
      result?: { file_path?: string };
    };
    if (!data.ok || !data.result?.file_path) return undefined;
    return `https://api.telegram.org/file/bot${channelToken}/${data.result.file_path}`;
  } catch (e) {
    console.warn("[download] Telegram file resolution failed:", e);
    return undefined;
  }
}

/**
 * Download files from channel-specific references and upload them to R2.
 * Supports all file types. Files > 20 MB are skipped. Failed downloads are silently skipped.
 */
export async function downloadAndUploadFiles(
  refs: ChannelFileRef[],
  bucket: R2Bucket,
  botId: string,
  channelToken?: string,
): Promise<AttachmentRef[]> {
  const mapped = await mapWithConcurrency(
    refs,
    async (ref): Promise<AttachmentRef | null> => {
      try {
        let downloadUrl = ref.downloadUrl;

        // Resolve Telegram file_id to a download URL
        if (downloadUrl.startsWith(TELEGRAM_FILE_ID_PREFIX)) {
          if (!channelToken) return null;
          const fileId = downloadUrl.slice(TELEGRAM_FILE_ID_PREFIX.length);
          const resolved = await resolveTelegramFileUrl(fileId, channelToken);
          if (!resolved) return null;
          downloadUrl = resolved;
        }

        // Build fetch headers
        const headers: Record<string, string> = {};
        if (ref.authHeader) {
          headers["Authorization"] = ref.authHeader;
        }

        const response = await fetch(downloadUrl, { headers });
        if (!response.ok) return null;

        // Check Content-Length before consuming the body
        const contentLength = response.headers.get("Content-Length");
        if (contentLength && parseInt(contentLength, 10) > MAX_FILE_SIZE) {
          return null;
        }

        const arrayBuffer = await response.arrayBuffer();

        // Double-check actual size (Content-Length may be absent or wrong)
        if (arrayBuffer.byteLength > MAX_FILE_SIZE) return null;

        const id = crypto.randomUUID().slice(0, 8);
        const ext = inferExtension(ref.mediaType, ref.fileName);
        const r2Key = `media/${botId}/${Date.now()}_${id}.${ext}`;

        await bucket.put(r2Key, arrayBuffer, {
          httpMetadata: { contentType: ref.mediaType },
        });

        return {
          id,
          r2Key,
          fileName: ref.fileName,
          mediaType: ref.mediaType,
          sizeBytes: arrayBuffer.byteLength,
        };
      } catch (e) {
        // Silently skip failed downloads
        console.warn("[download] File download/upload failed:", e);
        return null;
      }
    },
    3,
  );

  // Filter nulls (skipped/failed) while preserving order of successful results
  return mapped.filter((r): r is AttachmentRef => r !== null);
}

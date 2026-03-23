import { parseImageReferences, resolveWorkspaceImages, stripImageReferences, normalizeAssistantReply } from "../utils/media";
import type { ParsedImageRef, ImageAttachment } from "../utils/media";
import type { SandboxClient } from "../tools/sandbox-types";
import type { MediaItem } from "../channels/registry";
import type { StoredMessage } from "./loop";
import { attachmentsToJson } from "./multibot-helpers";
import { generateUploadToken } from "../api/upload";

/** Resolve tool-output image refs, normalize reply, update last assistant message */
export async function resolveAndNormalizeReply(params: {
  reply: string;
  toolResults: string[];
  newMessages: StoredMessage[];
  sandboxClient: SandboxClient;
  botId: string;
  baseUrl?: string;
  webhookSecret: string;
}): Promise<{
  normalizedText: string;
  attachments: ImageAttachment[];
  media: MediaItem[];
}> {
  const { reply, toolResults, newMessages, sandboxClient, botId, baseUrl, webhookSecret } = params;

  // 1. Collect image refs from tool results (authoritative), dedup by path
  const toolImagePaths = new Set<string>();
  const toolImageRefs: ParsedImageRef[] = [];
  for (const tr of toolResults) {
    for (const ref of parseImageReferences(tr)) {
      if (!toolImagePaths.has(ref.path)) {
        toolImagePaths.add(ref.path);
        toolImageRefs.push(ref);
      }
    }
  }

  if (toolImageRefs.length > 0) {
    console.log(JSON.stringify({
      msg: "resolveAndNormalizeReply: tool image refs found",
      botId,
      count: toolImageRefs.length,
    }));
  }

  // 2. Strip ALL image: refs from LLM reply (may contain hallucinated paths)
  let fullReply = stripImageReferences(reply);

  // 3. Resolve workspace paths from tool results -> R2 via HTTP upload, append to reply
  if (baseUrl && toolImageRefs.length > 0) {
    const token = await generateUploadToken(botId, webhookSecret);
    const uploadUrl = `${baseUrl}/upload?token=${encodeURIComponent(token)}&botId=${encodeURIComponent(botId)}`;
    const toolRefText = toolImageRefs.map(r => r.fullMatch).join("\n");
    const resolved = await resolveWorkspaceImages(
      toolRefText,
      (cmd) => sandboxClient.exec(cmd, { timeout: 60_000 }),
      uploadUrl,
    );
    // Drop any refs that failed to resolve (still /workspace/ paths)
    const resolvedRefs = parseImageReferences(resolved)
      .filter(r => !r.path.startsWith("/workspace/"));
    if (resolvedRefs.length > 0) {
      const resolvedText = resolvedRefs.map(r => r.fullMatch).join("\n");
      fullReply = fullReply ? `${fullReply}\n${resolvedText}` : resolvedText;
    } else {
      console.warn(JSON.stringify({
        msg: "resolveAndNormalizeReply: all workspace refs failed to resolve",
        botId,
        attempted: toolImageRefs.length,
      }));
    }
  }

  // 4. Normalize WITHOUT baseUrl -- keeps /media/ paths relative for D1 storage
  const normalized = normalizeAssistantReply(fullReply);

  // 5. Update the last assistant message with normalized content + attachments
  if (newMessages.length > 0) {
    const lastAssistant = [...newMessages].reverse().find(m => m.role === "assistant");
    if (lastAssistant) {
      lastAssistant.content = normalized.text || lastAssistant.content;
      lastAssistant.attachments = attachmentsToJson(normalized.attachments);
    }
  }

  // 6. Build MediaItems with absolute URLs for channel send
  const media: MediaItem[] = normalized.attachments.map(img => ({
    kind: "image" as const,
    source: {
      type: "url" as const,
      url: img.url.startsWith("/") && baseUrl
        ? `${baseUrl}${img.url}`
        : img.url,
    },
  }));

  // Return normalized.text (not the preserved content) so callers don't re-send
  // text that was already streamed via onProgress in the same iteration.
  return {
    normalizedText: normalized.text,
    attachments: normalized.attachments,
    media,
  };
}

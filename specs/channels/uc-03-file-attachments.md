# UC-03: File Extraction, Upload, and Attachment Refs

## Trigger

A user sends a message with file attachments (photos, documents, PDFs, etc.) through a channel webhook.

## Expected Behavior

1. **Channel-specific file ref extraction**: After `parseWebhook()` produces a `ChannelPayload`, the webhook handler extracts file references using channel-specific functions:
   - **Telegram** (`extractTelegramFileRefs`):
     - Photos: picks the largest resolution from the `photo` array (last element) and creates a ref with `__telegram_file_id__:<file_id>` as the download URL. Media type is always `image/jpeg`.
     - Documents: extracts `file_id`, `mime_type` (defaults to `application/octet-stream`), and `file_name`.
   - **Slack** (`extractSlackFileRefs`):
     - Iterates `event.files`, filtering for files with `mimetype` and `url_private_download` (excluding `mode: "external"`).
     - Creates refs with direct download URL and `Bearer <token>` auth header.
     - Preserves original `name` as `fileName`.
   - **Discord**: File extraction handled in the WebSocket gateway path, not in the HTTP webhook handler.

2. **Download and upload pipeline** (`downloadAndUploadFiles`):
   - Resolves Telegram file IDs to download URLs via `getFile` Bot API call.
   - Downloads files with optional auth headers (Slack's `Bearer` token).
   - Enforces 20 MB size limit (checked via `Content-Length` header and actual buffer size).
   - Uploads to R2 with key format: `media/{botId}/{timestamp}_{shortId}.{ext}`.
   - Returns `AttachmentRef[]` with `id`, `r2Key`, `fileName`, `mediaType`, `sizeBytes`.
   - Concurrency limited to 3 parallel downloads via `mapWithConcurrency`.
   - Failed downloads are silently skipped (logged with `console.warn`), never block the message.

3. **Attachment refs on payload**: Successfully uploaded attachments are set on `parsed.attachments` and passed through to the bot/coordinator for inclusion in the AI conversation context.

4. **MIME type to extension mapping**: Common types are mapped explicitly (`image/jpeg` → `jpeg`, `application/pdf` → `pdf`, etc.). Unknown types fall back to the file's original extension, or `bin` as last resort.

## Example

```
Telegram user sends a photo with a PDF document:
  Body: { message: { photo: [{ file_id: "sm", ... }, { file_id: "lg", ... }], document: { file_id: "doc123", mime_type: "application/pdf", file_name: "report.pdf" }, ... } }

→ extractTelegramFileRefs(body):
    [
      { downloadUrl: "__telegram_file_id__:lg", mediaType: "image/jpeg" },
      { downloadUrl: "__telegram_file_id__:doc123", mediaType: "application/pdf", fileName: "report.pdf" }
    ]

→ downloadAndUploadFiles(refs, bucket, "d1ea9d49", "bot-token"):
    For each ref (concurrency=3):
      1. Resolve file_id "lg" → POST getFile → file_path → download URL
      2. Fetch image → 150 KB → upload to R2 as "media/d1ea9d49/1700000000_a1b2c3d4.jpeg"
      3. Resolve file_id "doc123" → download URL
      4. Fetch PDF → 2 MB → upload to R2 as "media/d1ea9d49/1700000001_e5f6g7h8.pdf"

→ attachments = [
    { id: "a1b2c3d4", r2Key: "media/d1ea9d49/1700000000_a1b2c3d4.jpeg", mediaType: "image/jpeg", sizeBytes: 153600 },
    { id: "e5f6g7h8", r2Key: "media/d1ea9d49/1700000001_e5f6g7h8.pdf", mediaType: "application/pdf", fileName: "report.pdf", sizeBytes: 2097152 }
  ]
→ Attached to ChannelPayload.attachments, passed to bot
```

## Key Code Path

- Telegram extraction: `extractTelegramFileRefs()` in `src/channels/telegram.ts`
- Slack extraction: `extractSlackFileRefs()` in `src/channels/slack.ts`
- Download + R2 upload: `downloadAndUploadFiles()` in `src/utils/file-download.ts`
- Telegram file_id resolution: `resolveTelegramFileUrl()` in `src/utils/file-download.ts`
- Webhook handler integration: `handleWebhook()` in `src/index.ts` (step 3b)
- Shared types: `AttachmentRef` in `src/channels/registry.ts`, `ChannelFileRef` in `src/utils/file-download.ts`

## Edge Cases

- **Telegram photo array**: Always picks the last element (highest resolution). If the array is empty or `file_id` is missing, no ref is produced.
- **Telegram file_id resolution failure**: If the `getFile` API call fails (network error, invalid file_id), the file is silently skipped — other files still process.
- **Slack external files**: Files with `mode: "external"` (e.g. Google Drive links) are excluded because `url_private_download` points to an external service, not a Slack-hosted file.
- **File size limit**: Files exceeding 20 MB are skipped. Size is checked twice — first via `Content-Length` header (to avoid downloading), then on the actual buffer (to handle missing/incorrect headers).
- **No ASSETS_BUCKET**: If `env.ASSETS_BUCKET` (R2 binding) is not configured, the entire file extraction step is skipped — no refs are extracted.
- **All downloads fail**: If every file fails to download, `attachments` is an empty array. The message still processes normally with just text.
- **Concurrent downloads**: Limited to 3 parallel downloads to avoid overwhelming upstream APIs or R2.
- **MIME type inference**: Falls back to file extension from `fileName` if the MIME type is not in the explicit mapping table. Falls back to `bin` if no extension can be determined.

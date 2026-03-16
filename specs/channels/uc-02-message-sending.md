# UC-02: Outgoing Message Sending (Text + Media)

## Trigger

The bot/coordinator calls `adapter.sendMessage(token, chatId, text, options?)` to deliver a response to the user. The `text` parameter is standard markdown; `options` may include `media` (images) and `meta` (username, avatar for webhook/proxy identity).

## Expected Behavior

1. **Markdown conversion** (`formatMessage`): Standard markdown is converted to the platform's native format before sending:
   - **Telegram**: `formatTelegramMarkdown()` — `**bold**` → `*bold*`, headings → bold, `~~strike~~` → stripped, `- ` → `• `. Preserves code blocks and inline code unchanged.
   - **Discord**: No conversion needed — Discord natively supports standard markdown.
   - **Slack**: `formatSlackMarkdown()` — `**bold**` → `*bold*`, `[text](url)` → `<url|text>`, `~~strike~~` → `~strike~`, headings → bold, `- ` → `• `. Preserves code blocks and inline code unchanged.

2. **Text chunking**: Messages exceeding the platform's limit are split into multiple chunks sent sequentially:
   - Telegram: 4096 characters
   - Discord: 2000 characters
   - Slack: 4000 characters
   - Chunking is Unicode-safe (splits on code point boundaries, handles surrogate pairs/emoji/CJK correctly).

3. **Media handling**: When `options.media` contains image items:
   - **Telegram single image**: Sends via `sendPhoto` with caption (if text <= 1024 chars). Falls back to separate text message if caption is too long.
   - **Telegram multiple images**: Uses `sendMediaGroup` to merge into a single visual group. Caption on first item.
   - **Discord webhook**: URL images sent as embeds; base64 images uploaded as file attachments via FormData.
   - **Discord bot API**: Same strategy — embeds for URL, FormData for base64.
   - **Slack**: URL images sent as `image` blocks appended to the last chunk. Base64 upload not yet supported (filtered out).

4. **Media failure fallback**: If media sending fails on any platform, the adapter falls back to text-only delivery with `[image unavailable]` appended.

5. **Parse mode fallback** (Telegram): Text is first sent with `parse_mode: "Markdown"`. If the API returns an error (e.g. unmatched `_` in tool names), retries without `parse_mode` to ensure delivery.

6. **Retry logic**: All API calls are wrapped in `withRetry()`. For Discord, `429` (rate limit) and `5xx` errors trigger retries via thrown errors; other failures are logged but not retried.

7. **Sender identity** (`options.meta`): In group chat proxy scenarios:
   - Discord webhook: sets `username` and `avatar_url` on the webhook payload.
   - Discord bot API: prepends `[username]` to message text.
   - Slack: sets `username` and `icon_url` on `chat.postMessage`.

## Example

```
Bot generates response with 1 image:
  text: "Here's the chart you requested:\n\n**Revenue by quarter**"
  media: [{ kind: "image", source: { type: "url", url: "https://example.com/chart.png" } }]

Telegram path:
→ formatTelegramMarkdown(text) → "Here's the chart you requested:\n\n*Revenue by quarter*"
→ formatted.length (54) <= 1024 → use as caption
→ sendPhoto(token, chatId, photo=url, caption=formatted, parse_mode="Markdown")
→ API returns ok → done

Discord webhook path:
→ formatMessage(text) → text unchanged (Discord supports markdown)
→ chunkText(text, 2000) → single chunk
→ Last chunk + media → JSON body with { content, embeds: [{ image: { url } }] }
→ POST webhookUrl?wait=true → done

Slack path:
→ formatSlackMarkdown(text) → "Here's the chart you requested:\n\n*Revenue by quarter*"
→ chunkText(text, 4000) → single chunk
→ Last chunk + urlImages → body with blocks: [section, image]
→ POST chat.postMessage → done
```

## Key Code Path

- Telegram text: `TelegramAdapter._sendTextMessage()` in `src/channels/telegram.ts`
- Telegram media: `TelegramAdapter._sendMediaItem()` / `_sendMediaGroup()` in `src/channels/telegram.ts`
- Discord webhook: `DiscordAdapter._sendViaWebhook()` → `_sendWebhookWithMedia()` / `_sendWebhookTextOnly()` in `src/channels/discord.ts`
- Discord bot API: `DiscordAdapter._sendViaBotApi()` → `_sendBotApiWithMedia()` / `_sendBotApiTextOnly()` in `src/channels/discord.ts`
- Slack: `SlackAdapter._sendChunks()` in `src/channels/slack.ts`
- Text chunking: `chunkText()` in `src/channels/utils.ts`
- Markdown conversion: `formatTelegramMarkdown()` / `formatSlackMarkdown()` in `src/channels/utils.ts`
- Retry wrapper: `withRetry()` in `src/utils/retry.ts`

## Edge Cases

- **Text exceeds caption limit (Telegram)**: If formatted text > 1024 chars, media is sent without caption, then text is sent as a separate message
- **Telegram Markdown parse failure**: Unmatched `_` or `*` in tool/function names causes API error. Fallback retries without `parse_mode`, delivering plain text
- **Slack base64 images**: Filtered out silently — only URL-sourced images are supported (Slack's `files.uploadV2` not yet implemented)
- **Discord dual send path**: If `token` starts with `https://` it is treated as a webhook URL; otherwise as a bot token for the REST API. Both paths support media.
- **Media group failure (Telegram)**: If `sendMediaGroup` fails with `parse_mode: "Markdown"`, retries without parse mode. If still fails, falls back to text + `[image unavailable]`
- **Single code point exceeds maxLength**: The chunker handles the degenerate case where a single code point (e.g. surrogate pair) exceeds the chunk size — it emits the code point as its own chunk rather than looping infinitely
- **Mixed media sources (Telegram)**: `sendMediaGroup` supports mixed URL and base64 sources using multipart form with `attach://` references
- **Rate limiting (Discord)**: `429` responses throw to trigger `withRetry()` backoff; non-retryable errors (4xx) are logged but do not retry

---

## Audio / Voice Message Sending

When a bot has voice mode enabled (`voiceMode: "always"` or `"mirror"`), the reply flow is handled by `sendFinalReply()`:

1. **Text is always sent first** via the normal `sendMessage()` path — text is never lost or truncated
2. **Audio is additive**: if TTS conditions are met, an audio message is sent in addition to text

### TTS Decision (`shouldSynthesize`)

Audio is synthesized when ALL conditions are met:
- `voiceMode` is `"always"`, OR `voiceMode` is `"mirror"` and user sent a voice message with successful STT
- Reply text length is between 10 and 4096 characters
- Reply has no media attachments (images)
- OpenAI API key is configured
- Adapter supports `sendAudio`

### TTS Synthesis

- Provider: OpenAI TTS API (`/v1/audio/speech`)
- Default model: `gpt-4o-mini-tts`
- Default voice: `alloy` (configurable via `ttsVoice`)
- Output format: Opus in Ogg container (`response_format: "opus"`)
- Markdown is stripped before synthesis (`stripMarkdownForTTS`)

### Channel-specific Audio Sending (`sendAudio`)

Each adapter implements `sendAudio()` as an optional method:

- **Telegram**: `POST /sendVoice` with OGG/Opus audio via FormData
- **Discord**: File attachment via webhook (with bot identity meta) or Bot API
- **Slack**: 3-step file upload: `files.getUploadURLExternal` → PUT bytes → `files.completeUploadExternal`

### Failure Handling

- TTS API failure → text already sent, log warning, skip audio
- `sendAudio` failure → text already sent, log warning
- No API key → skip TTS entirely, text-only reply
- Adapter doesn't support `sendAudio` → skip audio, text-only reply

### Key Code Path

- TTS policy construction: `buildTtsPolicy()` in `src/voice/send-reply.ts`
- Unified reply sender: `sendFinalReply()` in `src/voice/send-reply.ts`
- TTS decision: `shouldSynthesize()` in `src/voice/tts.ts`
- TTS synthesis: `synthesizeSpeech()` in `src/voice/tts.ts`
- Markdown stripping: `stripMarkdownForTTS()` in `src/voice/tts.ts`
- Telegram audio: `TelegramAdapter.sendAudio()` in `src/channels/telegram.ts`
- Discord audio: `DiscordAdapter.sendAudio()` in `src/channels/discord.ts`
- Slack audio: `SlackAdapter.sendAudio()` in `src/channels/slack.ts`

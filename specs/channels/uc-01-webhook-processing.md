# UC-01: Incoming Webhook Processing

## Trigger

An HTTP POST arrives at the webhook endpoint for a specific channel and bot token (e.g. `/webhook/telegram/:token`).

## Expected Behavior

1. **Adapter lookup**: `getAdapter(channel)` returns the registered `ChannelAdapter` for the channel. If the adapter has no `parseWebhook` method (e.g. Discord, which uses WebSocket gateway), return `200 OK` immediately.
2. **Pre-processing** (`preProcessWebhook`): Channel-specific validation runs before any token lookup or parsing:
   - **Telegram**: Checks `X-Telegram-Bot-Api-Secret-Token` header against `env.WEBHOOK_SECRET`. Returns `401 Unauthorized` if mismatch.
   - **Slack**: Detects `url_verification` event type and responds with `{ challenge }` to complete Slack's endpoint verification handshake.
   - If pre-processing returns a `Response`, it short-circuits the entire pipeline.
3. **Token mapping lookup**: The bot token from the URL is looked up in D1 to find the associated bot configuration.
4. **Payload parsing** (`parseWebhook`): The raw webhook body is parsed into a normalized `ChannelPayload`:
   - `chatId` — platform chat/channel identifier (string)
   - `userId` — sender's platform user ID (string)
   - `userName` — sender's display name
   - `userMessage` — text content (text field, or caption for photo messages)
   - `chatType` — platform-dependent chat type. Telegram passes raw values (`"private"`, `"group"`, `"supergroup"`, `"channel"`); Slack normalizes to `"private"` (for `im`) or `"group"` (all else)
   - `messageId` — platform message identifier (string)
   - `replyToName` — display name of the user/bot being replied to (optional)
   - `replyToText` — text content of the replied-to message (optional)
   - `messageDate` — Unix timestamp in seconds (optional)
   - `mentions` — array of mention identifiers (optional)
   - `attachments` — populated later by file extraction pipeline (optional)
5. **Null = ignore**: If `parseWebhook` returns `null`, the webhook is acknowledged with `200 OK` and no further processing occurs. This filters out non-message updates, messages with subtypes, and messages with no content.

## Example

```
Telegram webhook arrives:
  POST /webhook/telegram/abc123
  Header: X-Telegram-Bot-Api-Secret-Token: correct-secret
  Body: { message: { chat: { id: -100123, type: "group" }, from: { id: 42, first_name: "Alice" }, text: "@mybot hello", message_id: 789, date: 1700000000, entities: [{ type: "mention", offset: 0, length: 6 }] } }

→ getAdapter("telegram") → TelegramAdapter
→ preProcessWebhook(): header matches env.WEBHOOK_SECRET → null (continue)
→ D1 lookup: token "abc123" → { botId: "d1ea9d49", ... }
→ parseWebhook():
    chatId: "-100123"
    userId: "42"
    userName: "Alice"
    userMessage: "@mybot hello"
    chatType: "group"
    messageId: "789"
    messageDate: 1700000000
    mentions: ["@mybot"]
→ Proceeds to bot/coordinator processing
```

## Key Code Path

- Adapter registry: `getAdapter()` in `src/channels/registry.ts`
- Telegram auth: `TelegramAdapter.preProcessWebhook()` in `src/channels/telegram.ts`
- Slack URL verification: `SlackAdapter.preProcessWebhook()` in `src/channels/slack.ts`
- Telegram parsing: `TelegramAdapter.parseWebhook()` in `src/channels/telegram.ts` (uses `TelegramUpdateSchema` with raw fallbacks)
- Slack parsing: `SlackAdapter.parseWebhook()` in `src/channels/slack.ts`
- Webhook handler orchestration: `handleWebhook()` in `src/index.ts`

## Edge Cases

- **Telegram auth failure**: If the secret token header is missing or mismatched, returns `401` before any parsing or DB lookup occurs
- **Slack url_verification**: Must respond synchronously with `{ challenge }` — this happens before token mapping lookup
- **Discord has no parseWebhook**: Discord uses WebSocket gateway (not HTTP webhooks), so the webhook endpoint returns `200 OK` immediately. Discord message handling is in `src/channels/discord.ts` gateway logic.
- **Message with no text**: Telegram accepts messages that have only `photo` or `document` (no `text`/`caption`) — `userMessage` defaults to `""`. Slack requires either text or files.
- **Telegram caption as text**: For photo messages, `msg.caption` is used as `userMessage` when `msg.text` is absent
- **Mention extraction**: Telegram parses structured entities (`mention` and `text_mention` types) from both `entities` and `caption_entities`. Slack extracts `<@U12345>` patterns via regex. Both produce normalized `mentions[]` arrays.
- **Slack event subtypes**: Events with a `subtype` field (e.g. `message_changed`, `bot_message`) are filtered out and return `null`
- **Telegram reply-to fallback**: Reply-to name resolution uses both Zod-parsed and raw payload data, falling back through `first_name` → `username` to handle edge cases where Zod strips unknown fields

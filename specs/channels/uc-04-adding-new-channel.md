# UC-04: Adding a New Channel Adapter

## Trigger

A developer needs to add support for a new messaging platform (e.g. LINE, WhatsApp, Microsoft Teams).

## Expected Behavior

1. **Implement the `ChannelAdapter` interface**: Create a new file `src/channels/<channel>.ts` that exports a class implementing `ChannelAdapter`:
   - `name: string` — channel identifier (e.g. `"line"`, `"whatsapp"`), used as the registry key
   - `maxMessageLength: number` — platform's maximum message length for text chunking
   - `formatMessage(markdown: string): string` — convert standard markdown to the platform's native format. If the platform supports standard markdown natively (like Discord), return the input unchanged. Otherwise, implement code-block-preserving transformation (see `formatTelegramMarkdown()` and `formatSlackMarkdown()` in `utils.ts` for reference patterns).
   - `sendMessage(token, chatId, text, options?): Promise<void>` — deliver a message to the platform. Must handle:
     - Text chunking via `chunkText()` for messages exceeding `maxMessageLength`
     - Media items from `options.media` (URL and/or base64 sources)
     - Graceful media failure with `[image unavailable]` fallback
     - Sender identity from `options.meta` (username, avatar) if the platform supports it
     - Retry via `withRetry()` for transient errors
   - `sendTyping(token, chatId): Promise<void>` — send a typing indicator to the platform API

2. **Optional webhook methods**: If the channel receives messages via HTTP webhooks (not WebSocket):
   - `preProcessWebhook(request, body, env): Response | null` — any authentication or verification that must happen before token lookup. Return a `Response` to short-circuit, or `null` to continue.
   - `parseWebhook(body): ChannelPayload | null` — parse the platform's payload into a normalized `ChannelPayload`. Return `null` to ignore non-message events.

3. **File extraction** (if the platform supports file attachments): Export a standalone function `extract<Channel>FileRefs(body, ...): ChannelFileRef[]` that extracts file references from the webhook body. Each ref needs:
   - `downloadUrl` — direct download URL (or a special prefix for deferred resolution, like Telegram's `__telegram_file_id__:`)
   - `mediaType` — MIME type
   - `authHeader` (optional) — Authorization header for authenticated downloads
   - `fileName` (optional) — original filename

4. **Register the adapter**: Add the new adapter to the `initAdapters()` function in `src/channels/registry.ts`:
   ```typescript
   import { NewChannelAdapter } from "./new-channel";
   // ...
   adapters = {
     telegram: new TelegramAdapter(),
     discord: new DiscordAdapter(),
     slack: new SlackAdapter(),
     newchannel: new NewChannelAdapter(),
   };
   ```

5. **Wire up file extraction** (if applicable): Add the extraction call in `handleWebhook()` in `src/index.ts`:
   ```typescript
   } else if (channel === "newchannel") {
     refs = extractNewChannelFileRefs(body);
   }
   ```

6. **No hardcoded channel names in business logic**: The core platform (bot logic, coordinator, tools) must remain channel-agnostic. Channel-specific behavior is only in `src/channels/` and the webhook routing in `src/index.ts`.

## Example

```
Adding a hypothetical "line" channel:

1. Create src/channels/line.ts:
   export class LineAdapter implements ChannelAdapter {
     readonly name = "line";
     readonly maxMessageLength = 5000;

     preProcessWebhook(request, body, env) {
       // Verify LINE signature
       ...
     }

     parseWebhook(body) {
       // Parse LINE webhook event → ChannelPayload
       ...
     }

     formatMessage(markdown) { return markdown; }
     async sendMessage(token, chatId, text, options?) { ... }
     async sendTyping(token, chatId) { ... }
   }

2. Register in src/channels/registry.ts:
   import { LineAdapter } from "./line";
   adapters = { ..., line: new LineAdapter() };

3. Add file extraction in src/index.ts (if needed):
   } else if (channel === "line") {
     refs = extractLineFileRefs(body);
   }

4. Add webhook route for /webhook/line/:token
```

## Key Code Path

- Interface definition: `ChannelAdapter` in `src/channels/registry.ts`
- Shared types: `ChannelPayload`, `SenderOptions`, `MediaItem`, `AttachmentRef` in `src/channels/registry.ts`
- Adapter registry: `initAdapters()` in `src/channels/registry.ts`
- Utility functions: `chunkText()`, `formatTelegramMarkdown()`, `formatSlackMarkdown()` in `src/channels/utils.ts` (internal helper `transformOutsideCode()` is not exported)
- File ref type: `ChannelFileRef` in `src/utils/file-download.ts`
- Webhook handler: `handleWebhook()` in `src/index.ts`
- Existing adapters for reference: `src/channels/telegram.ts`, `src/channels/discord.ts`, `src/channels/slack.ts`

## Edge Cases

- **Channel without webhooks**: Discord demonstrates this pattern — it has no `parseWebhook` or `preProcessWebhook` methods. The adapter is still registered for outgoing message sending and typing indicators. Incoming messages arrive via a separate WebSocket gateway.
- **Platform-specific auth**: Each platform has its own verification mechanism (Telegram: secret token header, Slack: URL verification challenge, LINE: signature verification). These must be handled in `preProcessWebhook` before any shared logic runs.
- **No channel-specific code in core**: The `ChannelAdapter` interface is the contract boundary. Bot logic, coordinator, tools, and prompts must never check `if (channel === "xxx")` — all platform differences are encapsulated in the adapter.
- **Media support varies**: Not all platforms support all media features. Slack does not support base64 image upload. Discord supports both URL embeds and base64 file attachments. New adapters should document which media capabilities they support and handle unsupported types gracefully.
- **Markdown dialect differences**: Some platforms (Discord) use standard markdown. Others have custom formats (Telegram Markdown v1, Slack mrkdwn). The `formatMessage` method must handle the conversion. The internal helper `transformOutsideCode()` in `utils.ts` (not exported) preserves code blocks while applying transformations — new adapters should follow the same pattern.

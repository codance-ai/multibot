# Channels Module Use Cases

This directory documents the multi-channel abstraction layer for the multibot platform.
Each channel adapter normalizes platform-specific webhook payloads, message formatting, and file handling into a unified interface.

The goal is to serve as a regression reference — when modifying one channel or adding a new one, check that other channels and the shared contract are not broken.

## Use Case Index

| # | Use Case | Channels Involved | Key Concern |
|---|----------|-------------------|-------------|
| [UC-01](uc-01-webhook-processing.md) | Webhook processing | Telegram, Slack | Auth, validation, normalization |
| [UC-02](uc-02-message-sending.md) | Message sending (text + media) | All | Formatting, chunking, media fallback |
| [UC-03](uc-03-file-attachments.md) | File extraction & upload | Telegram, Slack | Channel-specific refs, R2 upload |
| [UC-04](uc-04-adding-new-channel.md) | Adding a new channel adapter | N/A | Interface contract, registration |

## Architecture Overview

```
Incoming Webhook
       │
       ▼
  getAdapter(channel)
       │
       ▼
  preProcessWebhook()          ← Auth check (Telegram secret token)
       │                         URL verification (Slack challenge)
       │                         Returns Response to short-circuit, or null to continue
       ▼
  parseWebhook()               ← Platform payload → normalized ChannelPayload
       │                         Returns null to ignore (e.g. no content, subtype)
       ▼
  extractXxxFileRefs()         ← Channel-specific file ref extraction
       │                         (Telegram file_id, Slack url_private_download)
       ▼
  downloadAndUploadFiles()     ← Download from channel → upload to R2
       │                         Returns AttachmentRef[] on ChannelPayload
       ▼
  Bot / Coordinator processes message
       │
       ▼
  sendMessage()                ← Markdown → platform-native format
       │                         Text chunking for length limits
       │                         Media: URL embeds, base64 upload, fallback
       ▼
  Platform API (Telegram Bot API, Discord API, Slack Web API)
```

## Key Files

- `src/channels/registry.ts` — ChannelAdapter interface, ChannelPayload type, lazy singleton registry, shared types (MediaItem, SenderOptions, AttachmentRef)
- `src/channels/telegram.ts` — Telegram webhook parsing, message sending (text/photo/media group), typing, file extraction
- `src/channels/discord.ts` — Discord message sending (embeds, reactions, bot API + webhook), typing
- `src/channels/slack.ts` — Slack webhook parsing (URL verification, mention parsing), message sending (blocks), file extraction
- `src/channels/utils.ts` — Text chunking (Unicode-safe), markdown format conversion (Telegram, Slack)
- `src/utils/file-download.ts` — Channel-agnostic file download + R2 upload pipeline
- `src/index.ts` — Webhook handler that orchestrates the adapter pipeline

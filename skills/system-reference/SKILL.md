---
name: system-reference
description: Platform configuration reference — providers, models, bot parameters, channels, API keys, and group settings.
metadata: {"nanobot":{"emoji":"📋"}}
---

# System Reference

Platform configuration reference. Consult this before answering questions about supported models, providers, bot parameters, or other platform settings. Do not rely on your own training knowledge for these — the information here reflects the current system state.

## Providers & Chat Models

| Provider | Model ID | Display Name |
|----------|----------|--------------|
| openai | gpt-5.4 | GPT-5.4 |
| openai | gpt-5.2 | GPT-5.2 |
| openai | gpt-5 | GPT-5 |
| anthropic | claude-opus-4-6 | Claude Opus 4.6 |
| anthropic | claude-sonnet-4-6 | Claude Sonnet 4.6 |
| anthropic | claude-haiku-4-5-20251001 | Claude Haiku 4.5 |
| google | gemini-3.1-pro-preview | Gemini 3.1 Pro (Preview) |
| google | gemini-3-flash-preview | Gemini 3 Flash (Preview) |
| google | gemini-3.1-flash-lite-preview | Gemini 3.1 Flash Lite (Preview) |
| deepseek | deepseek-chat | DeepSeek V3.2 |
| deepseek | deepseek-reasoner | DeepSeek R1 |
| moonshot | kimi-k2.5 | Kimi K2.5 |
| moonshot | kimi-k2-thinking | Kimi K2 Thinking |
| xai | grok-4.1 | Grok 4.1 |
| xai | grok-4.1-fast | Grok 4.1 Fast |

The `model` field is a free-form string — custom model IDs are allowed (e.g. for fine-tuned models or with a custom `baseUrl`). The table above lists the recommended/tested models.

### Provider Notes

- **openai**: Uses Responses API by default. When `baseUrl` is set, switches to Chat Completions API for compatibility with OpenAI-compatible providers.
- **anthropic**: Uses Anthropic SDK directly. Supports prompt caching (ephemeral cache control).
- **google**: Uses Google Generative AI SDK.
- **deepseek, moonshot, xai**: Use OpenAI-compatible Chat Completions API with provider-specific base URLs.

## Image Models

Only some providers support image generation:

| Provider | Model ID | Display Name |
|----------|----------|--------------|
| openai | gpt-image-1.5 | GPT Image 1.5 |
| openai | gpt-image-1-mini | GPT Image 1 Mini |
| xai | grok-imagine-image | Grok Imagine Image |
| xai | grok-imagine-image-pro | Grok Imagine Image Pro |
| google | gemini-3.1-flash-image-preview | Gemini 3.1 Flash Image (Preview) |
| google | gemini-3-pro-image-preview | Gemini 3 Pro Image (Preview) |

Set `imageProvider` and `imageModel` on a bot to enable image generation. These are separate from the chat provider/model.

Default image models (when `imageModel` is not specified): openai → `gpt-image-1.5`, xai → `grok-imagine-image`, google → `gemini-2.5-flash-image`.

## Bot Configuration

### Bootstrap Files

| Field | Purpose |
|-------|---------|
| `identity` | Who the bot is — persona definition |
| `soul` | Personality, values, communication style, core behavior rules |
| `agents` | Agent behavior rules, tool usage guidelines |
| `user` | User context — who the user is, preferences |
| `tools` | Tool-specific guidelines and constraints |

These are assembled into the system prompt in order: Identity → System context → Bootstrap (agents, soul, user, tools) → Memory → Skills.

### Parameters

| Field | Default | Description |
|-------|---------|-------------|
| `maxIterations` | 10 | Max agent loop iterations per turn. Higher = more tool calls allowed. Recommend 10-25. |
| `memoryWindow` | 50 | Number of recent messages loaded into context. Higher = more history but more tokens. |
| `contextWindow` | 128000 | Model's context window size in tokens. Used for context management. |
| `timezone` | UTC | IANA timezone string (e.g. `Asia/Shanghai`). Affects timestamps in system prompt and conversation history. |
| `allowedSenderIds` | [] | Channel-specific sender IDs allowed to interact. Empty = no restriction. |
| `baseUrl` | (none) | Custom API base URL. Useful for proxies or OpenAI-compatible endpoints. |

### MCP Servers

```json
{
  "server-name": {
    "url": "https://mcp-server.example.com/sse",
    "headers": { "Authorization": "Bearer ..." }
  }
}
```

Bots can connect to external MCP servers for additional tools.

## Channels

Supported channels: **telegram**, **discord**, **slack**.

Each channel binding requires:
- `token`: The channel bot token (Telegram bot token, Discord bot token, Slack bot token)
- `webhookUrl` (optional): For Discord and Slack integrations

Channel bindings are per-bot — each bot can be bound to multiple channels independently.

## API Keys

Configure via `update_api_keys`. Each key corresponds to a provider:

| Key | Used By |
|-----|---------|
| `openai` | OpenAI chat models + image generation |
| `anthropic` | Anthropic (Claude) models |
| `google` | Google (Gemini) models + image generation |
| `deepseek` | DeepSeek models |
| `moonshot` | Moonshot (Kimi) models |
| `xai` | xAI (Grok) models + image generation |
| `brave` | Brave web search tool |

A bot's provider requires the corresponding API key to be configured. Image generation requires the image provider's key.

## Groups & Orchestrator

Groups enable multi-bot conversations orchestrated by an LLM.

- **Orchestrator provider**: openai, anthropic, or google (default: anthropic)
- **Orchestrator model defaults by provider**: openai → `gpt-5`, anthropic → `claude-haiku-4-5-20251001`, google → `gemini-3-flash-preview`
- **note**: Context note for the group (e.g. who the user is, what the group is for)
- Admin bots cannot be added to groups
- Each group must have at least one bot

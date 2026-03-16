import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { UserKeys } from "../config/schema";

const DEFAULT_BASE_URLS: Partial<Record<string, string>> = {
  deepseek: "https://api.deepseek.com/v1",
  moonshot: "https://api.moonshot.cn/v1",
  xai: "https://api.x.ai/v1",
};

export const DEFAULT_MODELS: Record<string, string> = {
  openai: "gpt-5",
  anthropic: "claude-haiku-4-5-20251001",
  google: "gemini-3-flash-preview",
};

export function createModel(
  config: { provider: string; model: string; baseUrl?: string },
  userKeys: UserKeys
): LanguageModel {
  const { provider, model: modelId, baseUrl } = config;

  switch (provider) {
    case "openai": {
      if (!userKeys.openai) throw new Error("OpenAI API key not configured");
      const openai = createOpenAI({
        apiKey: userKeys.openai,
        ...(baseUrl && { baseURL: baseUrl }),
      });
      // Use .chat() for Chat Completions API (/v1/chat/completions).
      // The default openai() uses the Responses API (/v1/responses)
      // which is not supported by most OpenAI-compatible providers.
      return baseUrl ? openai.chat(modelId) : openai(modelId);
    }
    case "anthropic": {
      if (!userKeys.anthropic)
        throw new Error("Anthropic API key not configured");
      const anthropic = createAnthropic({
        apiKey: userKeys.anthropic,
        ...(baseUrl && { baseURL: baseUrl }),
      });
      return anthropic(modelId);
    }
    case "google": {
      if (!userKeys.google) throw new Error("Google API key not configured");
      const google = createGoogleGenerativeAI({
        apiKey: userKeys.google,
        ...(baseUrl && { baseURL: baseUrl }),
      });
      return google(modelId);
    }
    case "deepseek":
    case "moonshot":
    case "xai": {
      const apiKey = userKeys[provider];
      if (!apiKey)
        throw new Error(
          `${provider.charAt(0).toUpperCase() + provider.slice(1)} API key not configured`
        );
      const effectiveBaseUrl = baseUrl ?? DEFAULT_BASE_URLS[provider];
      const openai = createOpenAI({
        apiKey,
        baseURL: effectiveBaseUrl,
      });
      // Always use Chat Completions API for OpenAI-compatible providers
      return openai.chat(modelId);
    }
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}

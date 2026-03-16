import type { LanguageModel, ModelMessage } from "ai";

/**
 * Check if a model is from Anthropic (supports prompt caching).
 */
export function isAnthropicModel(model: LanguageModel): boolean {
  return (model as { provider?: string }).provider?.startsWith("anthropic") ?? false;
}

/**
 * Build a system message with optional Anthropic cache control.
 * Returns the system parameter for generateText/generateObject:
 * - For Anthropic: undefined (system embedded in messages with cacheControl)
 * - For others: the system prompt string
 *
 * Also returns additional messages to prepend (system message for Anthropic).
 */
export function buildCachedSystemPrompt(
  model: LanguageModel,
  systemPrompt: string,
): { system: string | undefined; systemMessages: ModelMessage[] } {
  if (isAnthropicModel(model)) {
    return {
      system: undefined,
      systemMessages: [
        {
          role: "system" as const,
          content: systemPrompt,
          providerOptions: {
            anthropic: { cacheControl: { type: "ephemeral" } },
          },
        },
      ],
    };
  }
  return { system: systemPrompt, systemMessages: [] };
}

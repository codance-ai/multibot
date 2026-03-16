import { describe, it, expect } from "vitest";
import { createModel, DEFAULT_MODELS } from "./gateway";

const baseConfig = {
  provider: "anthropic",
  model: "claude-haiku-4-5-20251001",
};

describe("createModel", () => {
  it("throws when OpenAI key is missing", () => {
    const config = { ...baseConfig, provider: "openai", model: "gpt-4o" };
    expect(() => createModel(config, {})).toThrow("OpenAI API key not configured");
  });

  it("throws when Anthropic key is missing", () => {
    const config = { ...baseConfig, provider: "anthropic" };
    expect(() => createModel(config, {})).toThrow("Anthropic API key not configured");
  });

  it("throws when Google key is missing", () => {
    const config = { ...baseConfig, provider: "google", model: "gemini-2.5-pro" };
    expect(() => createModel(config, {})).toThrow("Google API key not configured");
  });

  it("throws when DeepSeek key is missing", () => {
    const config = { ...baseConfig, provider: "deepseek", model: "deepseek-chat" };
    expect(() => createModel(config, {})).toThrow("Deepseek API key not configured");
  });

  it("throws when Moonshot key is missing", () => {
    const config = { ...baseConfig, provider: "moonshot", model: "moonshot-v1-auto" };
    expect(() => createModel(config, {})).toThrow("Moonshot API key not configured");
  });

  it("throws when xAI key is missing", () => {
    const config = { ...baseConfig, provider: "xai", model: "grok-3" };
    expect(() => createModel(config, {})).toThrow("Xai API key not configured");
  });

  it("throws for unsupported provider", () => {
    const config = { ...baseConfig, provider: "unknown" };
    expect(() => createModel(config, { anthropic: "key" })).toThrow(
      "Unsupported provider"
    );
  });

  it("creates Anthropic model with valid key", () => {
    const config = { ...baseConfig, provider: "anthropic" };
    const model = createModel(config, { anthropic: "sk-ant-test" });
    expect(model).toBeDefined();
    expect((model as any).modelId).toContain("claude-haiku");
  });

  it("creates OpenAI model with valid key", () => {
    const config = { ...baseConfig, provider: "openai", model: "gpt-4o-mini" };
    const model = createModel(config, { openai: "sk-test" });
    expect(model).toBeDefined();
  });

  it("creates OpenAI-compatible model with baseUrl", () => {
    const config = { ...baseConfig, provider: "openai", model: "custom-model", baseUrl: "https://api.example.com/v1" };
    const model = createModel(config, { openai: "sk-test" });
    expect(model).toBeDefined();
  });

  it("creates Google model with valid key", () => {
    const config = { ...baseConfig, provider: "google", model: "gemini-2.5-pro" };
    const model = createModel(config, { google: "test-key" });
    expect(model).toBeDefined();
  });

  it("creates DeepSeek model with valid key", () => {
    const config = { ...baseConfig, provider: "deepseek", model: "deepseek-chat" };
    const model = createModel(config, { deepseek: "sk-ds-test" });
    expect(model).toBeDefined();
  });

  it("creates Moonshot model with valid key", () => {
    const config = { ...baseConfig, provider: "moonshot", model: "moonshot-v1-auto" };
    const model = createModel(config, { moonshot: "sk-ms-test" });
    expect(model).toBeDefined();
  });

  it("creates xAI model with valid key", () => {
    const config = { ...baseConfig, provider: "xai", model: "grok-3" };
    const model = createModel(config, { xai: "xai-test-key" });
    expect(model).toBeDefined();
  });
});

describe("DEFAULT_MODELS", () => {
  it("has defaults for major providers", () => {
    expect(DEFAULT_MODELS.openai).toBeDefined();
    expect(DEFAULT_MODELS.anthropic).toBeDefined();
    expect(DEFAULT_MODELS.google).toBeDefined();
  });
});

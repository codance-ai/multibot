import { describe, it, expect } from "vitest";
import { getAdapter } from "./registry";

describe("getAdapter", () => {
  it("returns TelegramAdapter for 'telegram'", () => {
    const adapter = getAdapter("telegram");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("telegram");
    expect(adapter!.maxMessageLength).toBe(4096);
  });

  it("returns DiscordAdapter for 'discord'", () => {
    const adapter = getAdapter("discord");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("discord");
    expect(adapter!.maxMessageLength).toBe(2000);
  });

  it("returns SlackAdapter for 'slack'", () => {
    const adapter = getAdapter("slack");
    expect(adapter).toBeDefined();
    expect(adapter!.name).toBe("slack");
    expect(adapter!.maxMessageLength).toBe(4000);
  });

  it("returns undefined for unknown channel", () => {
    expect(getAdapter("teams")).toBeUndefined();
  });

  it("all adapters have sendMessage and sendTyping", () => {
    for (const channel of ["telegram", "discord", "slack"]) {
      const adapter = getAdapter(channel)!;
      expect(typeof adapter.sendMessage).toBe("function");
      expect(typeof adapter.sendTyping).toBe("function");
      expect(typeof adapter.formatMessage).toBe("function");
    }
  });
});

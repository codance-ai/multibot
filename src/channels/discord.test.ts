import { describe, it, expect, vi, beforeEach } from "vitest";
import { DiscordAdapter } from "./discord";
import type { MediaItem } from "./registry";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

function urlMedia(url: string): MediaItem {
  return { kind: "image", source: { type: "url", url } };
}

function base64Media(data: string, mimeType = "image/png"): MediaItem {
  return { kind: "image", source: { type: "base64", data, mimeType } };
}

const _adapter = new DiscordAdapter();
const sendDiscordTyping = _adapter.sendTyping.bind(_adapter);
const sendDiscordMessage = _adapter.sendMessage.bind(_adapter);

describe("sendDiscordTyping", () => {
  it("calls POST /channels/{id}/typing with Bot header", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendDiscordTyping("test-token", "chan-123");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://discord.com/api/v10/channels/chan-123/typing");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual({ Authorization: "Bot test-token" });
  });
});

describe("sendDiscordMessage", () => {
  it("sends a short message in a single request", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendDiscordMessage("tok", "ch-1", "Hello");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://discord.com/api/v10/channels/ch-1/messages");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual({
      Authorization: "Bot tok",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(opts.body)).toEqual({ content: "Hello" });
  });

  it("splits messages exceeding 2000 characters into multiple chunks", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });

    const longText = "A".repeat(4500);
    await sendDiscordMessage("tok", "ch-1", longText);

    // 4500 / 2000 = 3 chunks (2000 + 2000 + 500)
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const chunks = mockFetch.mock.calls.map(
      ([, opts]: [string, RequestInit]) => JSON.parse(opts.body as string).content
    );
    expect(chunks[0].length).toBe(2000);
    expect(chunks[1].length).toBe(2000);
    expect(chunks[2].length).toBe(500);
    expect(chunks.join("")).toBe(longText);
  });

  it("logs error but does not throw on 4xx API failure", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    });

    // 4xx (non-429) should not throw, just log
    await sendDiscordMessage("tok", "ch-1", "Hi");

    expect(consoleSpy).toHaveBeenCalledOnce();
    expect(consoleSpy.mock.calls[0][0]).toContain("Discord sendMessage failed");
    consoleSpy.mockRestore();
  });

  it("retries on 5xx and succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 502, text: async () => "Bad Gateway" })
      .mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendDiscordMessage("tok", "ch-1", "Hi");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 5000);

  it("retries on network error and succeeds", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendDiscordMessage("tok", "ch-1", "Hi");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 5000);

  it("throws after max retries on persistent 5xx", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => "Server Error" });

    await expect(sendDiscordMessage("tok", "ch-1", "Hi")).rejects.toThrow(
      "Discord sendMessage failed"
    );
    expect(mockFetch).toHaveBeenCalledTimes(3);
  }, 10000);

  it("includes embeds when URL media is provided via Bot API", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendDiscordMessage("tok", "ch-1", "Look at this", {
      media: [urlMedia("https://example.com/img.png")],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.content).toBe("Look at this");
    expect(payload.embeds).toEqual([{ image: { url: "https://example.com/img.png" } }]);
  });

  it("includes multiple embeds for multiple URL media", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendDiscordMessage("tok", "ch-1", "Two images", {
      media: [urlMedia("https://example.com/a.png"), urlMedia("https://example.com/b.png")],
    });

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.embeds).toHaveLength(2);
    expect(payload.embeds[0].image.url).toBe("https://example.com/a.png");
    expect(payload.embeds[1].image.url).toBe("https://example.com/b.png");
  });

  it("includes embeds when URL media is provided via webhook", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendDiscordMessage("https://discord.com/api/webhooks/123/abc", "", "Hello", {
      meta: { username: "TestBot" },
      media: [urlMedia("https://example.com/img.png")],
    });

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.username).toBe("TestBot");
    expect(payload.embeds).toEqual([{ image: { url: "https://example.com/img.png" } }]);
  });

  it("attaches embeds only to last chunk when message is split", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });

    const longText = "A".repeat(2500);
    await sendDiscordMessage("tok", "ch-1", longText, {
      media: [urlMedia("https://example.com/img.png")],
    });

    // 2500 / 2000 = 2 chunks
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstPayload = JSON.parse(mockFetch.mock.calls[0][1].body);
    const lastPayload = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(firstPayload.embeds).toBeUndefined();
    expect(lastPayload.embeds).toHaveLength(1);
  });

  it("does not include embeds when media array is empty", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendDiscordMessage("tok", "ch-1", "No media", { media: [] });

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.embeds).toBeUndefined();
  });

  it("sends base64 media via FormData in Bot API", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendDiscordMessage("tok", "ch-1", "Generated image", {
      media: [base64Media("aGVsbG8=", "image/png")],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://discord.com/api/v10/channels/ch-1/messages");
    expect(opts.body).toBeInstanceOf(FormData);
    const form = opts.body as FormData;
    expect(form.get("files[0]")).toBeInstanceOf(Blob);
    const payloadJson = JSON.parse(form.get("payload_json") as string);
    expect(payloadJson.content).toBe("Generated image");
    expect(payloadJson.attachments).toEqual([{ id: 0, filename: "image_0.png" }]);
  });

  it("sends base64 media via FormData in webhook", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendDiscordMessage("https://discord.com/api/webhooks/123/abc", "", "Hello", {
      meta: { username: "TestBot" },
      media: [base64Media("aGVsbG8=")],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [, opts] = mockFetch.mock.calls[0];
    expect(opts.body).toBeInstanceOf(FormData);
    const form = opts.body as FormData;
    const payloadJson = JSON.parse(form.get("payload_json") as string);
    expect(payloadJson.username).toBe("TestBot");
    expect(payloadJson.attachments).toHaveLength(1);
  });
});

describe("DiscordAdapter", () => {
  it("has name 'discord' and maxMessageLength 2000", () => {
    const adapter = new DiscordAdapter();
    expect(adapter.name).toBe("discord");
    expect(adapter.maxMessageLength).toBe(2000);
  });

  it("formatMessage passes through standard markdown unchanged", () => {
    const adapter = new DiscordAdapter();
    const markdown = "# Hello\n\n**bold** and *italic*\n\n```js\ncode\n```\n\n- list item\n- [link](https://example.com)";
    expect(adapter.formatMessage(markdown)).toBe(markdown);
  });

  it("formatMessage passes through empty string", () => {
    const adapter = new DiscordAdapter();
    expect(adapter.formatMessage("")).toBe("");
  });

  it("does not define parseWebhook on the prototype", () => {
    const adapter = new DiscordAdapter();
    expect("parseWebhook" in adapter).toBe(false);
  });

  it("does not define preProcessWebhook on the prototype", () => {
    const adapter = new DiscordAdapter();
    expect("preProcessWebhook" in adapter).toBe(false);
  });
});

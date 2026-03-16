import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelegramAdapter } from "./telegram";
import { DiscordAdapter } from "./discord";
import { SlackAdapter } from "./slack";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
  vi.clearAllMocks();
});

const fakeAudio = new ArrayBuffer(100);

describe("TelegramAdapter.sendAudio", () => {
  const adapter = new TelegramAdapter();

  it("calls sendVoice with FormData", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    const result = await adapter.sendAudio!("tok", "chat1", fakeAudio);

    expect(result).toEqual({ captionSent: false });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bottok/sendVoice");
    expect(opts.method).toBe("POST");
    expect(opts.body).toBeInstanceOf(FormData);
  });

  it("includes caption when provided and within limit", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    const result = await adapter.sendAudio!("tok", "chat1", fakeAudio, { caption: "Hello world" });

    expect(result).toEqual({ captionSent: true });
    const form = mockFetch.mock.calls[0][1].body as FormData;
    expect(form.get("caption")).toBeTruthy();
    expect(form.get("parse_mode")).toBe("Markdown");
  });

  it("skips caption when too long (>1024 chars)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    const longCaption = "x".repeat(1025);
    const result = await adapter.sendAudio!("tok", "chat1", fakeAudio, { caption: longCaption });

    expect(result).toEqual({ captionSent: false });
    const form = mockFetch.mock.calls[0][1].body as FormData;
    expect(form.get("caption")).toBeNull();
  });

  it("retries without parse_mode on markdown failure", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "Bad Request: can't parse" })
      .mockResolvedValueOnce({ ok: true, text: async () => "" });

    const result = await adapter.sendAudio!("tok", "chat1", fakeAudio, { caption: "**bold**" });

    expect(result).toEqual({ captionSent: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // Second call should not have parse_mode
    const form2 = mockFetch.mock.calls[1][1].body as FormData;
    expect(form2.get("parse_mode")).toBeNull();
    expect(form2.get("caption")).toBe("**bold**");
  });

  it("throws on failure without caption (enables fallback in sendFinalReply)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: false, status: 400, text: async () => "Bad Request" });

    await expect(adapter.sendAudio!("tok", "chat1", fakeAudio)).rejects.toThrow("Telegram sendVoice failed");
  });

  it("throws on 429/5xx for retry", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 429, text: async () => "Too Many Requests" });

    await expect(adapter.sendAudio!("tok", "chat1", fakeAudio)).rejects.toThrow("Telegram sendVoice failed");
  });
});

describe("DiscordAdapter.sendAudio", () => {
  const adapter = new DiscordAdapter();

  it("sends via bot API with file attachment", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await adapter.sendAudio!("bot-token", "ch1", fakeAudio);

    expect(result).toEqual({ captionSent: false });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://discord.com/api/v10/channels/ch1/messages");
    expect(opts.method).toBe("POST");
    expect(opts.headers.Authorization).toBe("Bot bot-token");
    expect(opts.body).toBeInstanceOf(FormData);
  });

  it("includes content when caption provided (bot API with username prefix)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await adapter.sendAudio!("bot-token", "ch1", fakeAudio, {
      caption: "Hello",
      meta: { username: "TestBot" },
    });

    expect(result).toEqual({ captionSent: true });
    const form = mockFetch.mock.calls[0][1].body as FormData;
    const payload = JSON.parse(form.get("payload_json") as string);
    expect(payload.content).toBe("[TestBot]\nHello");
  });

  it("sends via webhook with meta and caption", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const result = await adapter.sendAudio!(
      "https://discord.com/api/webhooks/123/abc",
      "ch1",
      fakeAudio,
      { caption: "Hi there", meta: { username: "TestBot", avatarUrl: "https://example.com/avatar.png" } },
    );

    expect(result).toEqual({ captionSent: true });
    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://discord.com/api/webhooks/123/abc?wait=true");
    const form = opts.body as FormData;
    const payload = JSON.parse(form.get("payload_json") as string);
    // Webhook mode: no prefix, caption as-is
    expect(payload.content).toBe("Hi there");
    expect(payload.username).toBe("TestBot");
  });

  it("skips caption when too long for Discord (>2000 chars)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true });

    const longCaption = "x".repeat(2001);
    const result = await adapter.sendAudio!("bot-token", "ch1", fakeAudio, { caption: longCaption });

    expect(result).toEqual({ captionSent: false });
    const form = mockFetch.mock.calls[0][1].body as FormData;
    const payload = JSON.parse(form.get("payload_json") as string);
    expect(payload.content).toBeUndefined();
  });

  it("throws on 429 for webhook (retryable)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
      headers: new Headers({ "Retry-After": "1" }),
    });

    await expect(
      adapter.sendAudio!("https://discord.com/api/webhooks/123/abc", "ch1", fakeAudio),
    ).rejects.toThrow("Discord webhook audio failed");
  });

  it("throws on 429 for bot API (retryable)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "rate limited",
      headers: new Headers({ "Retry-After": "1" }),
    });

    await expect(
      adapter.sendAudio!("bot-token", "ch1", fakeAudio),
    ).rejects.toThrow("Discord sendAudio failed");
  });

  it("throws on 4xx for bot API (enables fallback)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 400,
      text: async () => "Bad Request",
      headers: new Headers(),
    });

    await expect(
      adapter.sendAudio!("bot-token", "ch1", fakeAudio),
    ).rejects.toThrow("Discord sendAudio failed");
  });
});

describe("SlackAdapter.sendAudio", () => {
  const adapter = new SlackAdapter();

  it("uses 3-step upload flow with caption", async () => {
    const urls: string[] = [];
    mockFetch.mockImplementation((url: string) => {
      urls.push(typeof url === "string" ? url : "unknown");
      if (typeof url === "string" && url.includes("getUploadURLExternal")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            ok: true,
            upload_url: "https://files.slack.com/upload/1234",
            file_id: "F123",
          }),
        });
      }
      if (typeof url === "string" && url.includes("files.slack.com/upload")) {
        return Promise.resolve({ ok: true });
      }
      if (typeof url === "string" && url.includes("completeUploadExternal")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        });
      }
      return Promise.resolve({ ok: true, text: async () => "" });
    });

    const result = await adapter.sendAudio!("xoxb-tok", "C123", fakeAudio, { caption: "Hello" });

    expect(result).toEqual({ captionSent: true });
    expect(urls).toEqual([
      expect.stringContaining("getUploadURLExternal"),
      expect.stringContaining("files.slack.com/upload"),
      expect.stringContaining("completeUploadExternal"),
    ]);

    // Verify initial_comment was passed
    const completeCall = mockFetch.mock.calls[2];
    const body = JSON.parse(completeCall[1].body);
    expect(body.initial_comment).toBeTruthy();
  });

  it("sends without caption when not provided", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.includes("getUploadURLExternal")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, upload_url: "https://files.slack.com/upload/1234", file_id: "F123" }),
        });
      }
      if (typeof url === "string" && url.includes("files.slack.com/upload")) {
        return Promise.resolve({ ok: true });
      }
      if (typeof url === "string" && url.includes("completeUploadExternal")) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      return Promise.resolve({ ok: true, text: async () => "" });
    });

    const result = await adapter.sendAudio!("xoxb-tok", "C123", fakeAudio);

    expect(result).toEqual({ captionSent: false });
    const completeCall = mockFetch.mock.calls[2];
    const body = JSON.parse(completeCall[1].body);
    expect(body.initial_comment).toBeUndefined();
  });

  it("throws if getUploadURLExternal fails", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: "invalid_auth" }),
    });

    await expect(adapter.sendAudio!("xoxb-tok", "C123", fakeAudio)).rejects.toThrow("Slack getUploadURLExternal failed");
    expect(mockFetch).toHaveBeenCalledOnce();
  });

  it("throws if file upload fails", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          ok: true,
          upload_url: "https://files.slack.com/upload/1234",
          file_id: "F123",
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

    await expect(adapter.sendAudio!("xoxb-tok", "C123", fakeAudio)).rejects.toThrow("Slack file upload failed");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });
});

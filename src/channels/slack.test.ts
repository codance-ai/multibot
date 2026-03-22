import { describe, it, expect, vi, beforeEach } from "vitest";
import { SlackAdapter, extractSlackFileRefs } from "./slack";
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

const _adapter = new SlackAdapter();
const sendSlackMessage = _adapter.sendMessage.bind(_adapter);

describe("sendSlackMessage", () => {
  it("sends a message with correct URL and Bearer header", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendSlackMessage("xoxb-token", "C123", "Hello Slack");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://slack.com/api/chat.postMessage");
    expect(opts.method).toBe("POST");
    expect(opts.headers).toEqual({
      Authorization: "Bearer xoxb-token",
      "Content-Type": "application/json",
    });
    expect(JSON.parse(opts.body)).toEqual({
      channel: "C123",
      text: "Hello Slack",
    });
  });

  it("splits messages exceeding 4000 characters into multiple chunks", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });

    const longText = "B".repeat(9000);
    await sendSlackMessage("tok", "C1", longText);

    // 9000 / 4000 = 3 chunks (4000 + 4000 + 1000)
    expect(mockFetch).toHaveBeenCalledTimes(3);

    const chunks = mockFetch.mock.calls.map(
      ([, opts]: [string, RequestInit]) => JSON.parse(opts.body as string).text
    );
    expect(chunks[0].length).toBe(4000);
    expect(chunks[1].length).toBe(4000);
    expect(chunks[2].length).toBe(1000);
    expect(chunks.join("")).toBe(longText);
  });

  it("throws on non-retryable 4xx API failure", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      text: async () => "Forbidden",
    });

    await expect(sendSlackMessage("tok", "C1", "Hi")).rejects.toThrow(
      "Slack sendMessage failed"
    );
  });

  it("retries on 5xx and succeeds", async () => {
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "Internal Server Error" })
      .mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendSlackMessage("tok", "C1", "Hi");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 5000);

  it("retries on network error and succeeds", async () => {
    mockFetch
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendSlackMessage("tok", "C1", "Hi");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 5000);

  it("throws after max retries on persistent 5xx", async () => {
    mockFetch.mockResolvedValue({ ok: false, status: 500, text: async () => "Server Error" });

    await expect(sendSlackMessage("tok", "C1", "Hi")).rejects.toThrow(
      "Slack sendMessage failed"
    );
    expect(mockFetch).toHaveBeenCalledTimes(3);
  }, 10000);

  it("includes image blocks when URL media is provided", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendSlackMessage("tok", "C1", "Check this", {
      media: [urlMedia("https://example.com/img.png")],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.text).toBe("Check this");
    expect(payload.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Check this" } },
      { type: "image", image_url: "https://example.com/img.png", alt_text: "image" },
    ]);
  });

  it("includes multiple image blocks for multiple URL media", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendSlackMessage("tok", "C1", "Two pics", {
      media: [urlMedia("https://example.com/a.png"), urlMedia("https://example.com/b.png")],
    });

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.blocks).toHaveLength(3); // 1 section + 2 images
    expect(payload.blocks[0].type).toBe("section");
    expect(payload.blocks[1]).toEqual({
      type: "image",
      image_url: "https://example.com/a.png",
      alt_text: "image",
    });
    expect(payload.blocks[2]).toEqual({
      type: "image",
      image_url: "https://example.com/b.png",
      alt_text: "image",
    });
  });

  it("attaches blocks only to last chunk when message is split", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });

    const longText = "A".repeat(5000);
    await sendSlackMessage("tok", "C1", longText, {
      media: [urlMedia("https://example.com/img.png")],
    });

    // 5000 / 4000 = 2 chunks
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const firstPayload = JSON.parse(mockFetch.mock.calls[0][1].body);
    const lastPayload = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(firstPayload.blocks).toBeUndefined();
    expect(lastPayload.blocks).toBeDefined();
    expect(lastPayload.blocks[0].type).toBe("section");
  });

  it("does not include blocks when media array is empty", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendSlackMessage("tok", "C1", "No media", { media: [] });

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.blocks).toBeUndefined();
  });

  it("includes meta (username/icon) alongside media blocks", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendSlackMessage("tok", "C1", "Hello", {
      meta: { username: "TestBot", avatarUrl: "https://example.com/avatar.png" },
      media: [urlMedia("https://example.com/img.png")],
    });

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(payload.username).toBe("TestBot");
    expect(payload.icon_url).toBe("https://example.com/avatar.png");
    expect(payload.blocks).toBeDefined();
  });

  it("ignores base64 media (not yet supported in Slack)", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendSlackMessage("tok", "C1", "Has base64", {
      media: [base64Media("aGVsbG8=")],
    });

    const payload = JSON.parse(mockFetch.mock.calls[0][1].body);
    // base64 media filtered out, no blocks attached
    expect(payload.blocks).toBeUndefined();
  });
});

describe("SlackAdapter", () => {
  const adapter = new SlackAdapter();

  describe("name and maxMessageLength", () => {
    it("has name 'slack'", () => {
      expect(adapter.name).toBe("slack");
    });

    it("has maxMessageLength 4000", () => {
      expect(adapter.maxMessageLength).toBe(4000);
    });
  });

  describe("preProcessWebhook", () => {
    it("returns challenge Response for url_verification", () => {
      const body = { type: "url_verification", challenge: "test-challenge-token" };
      const result = adapter.preProcessWebhook(new Request("https://example.com"), body, {} as any);

      expect(result).toBeInstanceOf(Response);
      expect(result).not.toBeNull();
    });

    it("responds with the correct challenge value", async () => {
      const body = { type: "url_verification", challenge: "abc123xyz" };
      const result = adapter.preProcessWebhook(new Request("https://example.com"), body, {} as any);

      const json = await result!.json();
      expect(json).toEqual({ challenge: "abc123xyz" });
    });

    it("returns null for non-url_verification events", () => {
      const body = { type: "event_callback", event: { type: "message" } };
      const result = adapter.preProcessWebhook(new Request("https://example.com"), body, {} as any);

      expect(result).toBeNull();
    });

    it("returns null for body without type", () => {
      const body = { event: { type: "message" } };
      const result = adapter.preProcessWebhook(new Request("https://example.com"), body, {} as any);

      expect(result).toBeNull();
    });
  });

  describe("parseWebhook", () => {
    it("parses a valid DM event", () => {
      const body = {
        event: {
          type: "message",
          channel: "D123",
          user: "U456",
          text: "Hello bot",
          channel_type: "im",
          ts: "1234567890.123456",
        },
      };

      const result = adapter.parseWebhook(body);
      expect(result).toEqual({
        chatId: "D123",
        userId: "U456",
        userName: "U456",
        userMessage: "Hello bot",
        chatType: "private",
        messageId: "1234567890.123456",
        messageDate: 1234567890,
        mentions: [],
      });
    });

    it("parses a valid group channel event", () => {
      const body = {
        event: {
          type: "message",
          channel: "C789",
          user: "U456",
          text: "Hello channel",
          channel_type: "channel",
          ts: "1234567890.654321",
        },
      };

      const result = adapter.parseWebhook(body);
      expect(result).toEqual({
        chatId: "C789",
        userId: "U456",
        userName: "U456",
        userMessage: "Hello channel",
        chatType: "group",
        messageId: "1234567890.654321",
        messageDate: 1234567890,
        mentions: [],
      });
    });

    it("returns null for events with a subtype", () => {
      const body = {
        event: {
          type: "message",
          subtype: "bot_message",
          channel: "C123",
          text: "Bot reply",
          ts: "123",
        },
      };

      expect(adapter.parseWebhook(body)).toBeNull();
    });

    it("returns null for events without text and without image files", () => {
      const body = {
        event: {
          type: "message",
          channel: "C123",
          user: "U456",
          ts: "123",
        },
      };

      expect(adapter.parseWebhook(body)).toBeNull();
    });

    it("returns null when event is missing", () => {
      expect(adapter.parseWebhook({})).toBeNull();
      expect(adapter.parseWebhook({ type: "event_callback" })).toBeNull();
    });

    it("returns null for null/undefined body", () => {
      expect(adapter.parseWebhook(null)).toBeNull();
      expect(adapter.parseWebhook(undefined)).toBeNull();
    });

    it("maps mpim and group channel_type to 'group'", () => {
      const body = {
        event: {
          type: "message",
          channel: "G123",
          user: "U456",
          text: "Group msg",
          channel_type: "mpim",
          ts: "123",
        },
      };

      const result = adapter.parseWebhook(body);
      expect(result?.chatType).toBe("group");
    });

    it("returns messageDate from event.ts (integer part)", () => {
      const body = {
        event: {
          channel: "C123",
          user: "U456",
          text: "hello",
          ts: "1700000000.123456",
          channel_type: "im",
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.messageDate).toBe(1700000000);
    });

    it("detects audio file as voice message", () => {
      const body = {
        event: {
          type: "message",
          channel: "C123",
          user: "U456",
          text: "",
          ts: "1700000000.123456",
          channel_type: "im",
          files: [
            { mimetype: "audio/webm", url_private_download: "https://files.slack.com/audio.webm", name: "audio.webm" },
          ],
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.isVoiceMessage).toBe(true);
    });

    it("does not set isVoiceMessage for non-audio files", () => {
      const body = {
        event: {
          type: "message",
          channel: "C123",
          user: "U456",
          text: "here is a file",
          ts: "1700000000.123456",
          channel_type: "im",
          files: [
            { mimetype: "application/pdf", url_private_download: "https://files.slack.com/doc.pdf", name: "doc.pdf" },
          ],
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.isVoiceMessage).toBeUndefined();
    });
  });

  describe("parseWebhook with files", () => {
    it("accepts message with image file and no text", () => {
      const body = {
        event: {
          channel: "C123",
          user: "U456",
          ts: "1700000000.123456",
          channel_type: "im",
          files: [{ url_private_download: "https://files.slack.com/img.png", mimetype: "image/png" }],
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.userMessage).toBe("");
    });

    it("accepts message with non-image file and no text (e.g. PDF)", () => {
      const body = {
        event: {
          channel: "C123",
          user: "U456",
          ts: "1700000000.123456",
          channel_type: "im",
          files: [{ url_private_download: "https://files.slack.com/report.pdf", mimetype: "application/pdf" }],
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.userMessage).toBe("");
    });

    it("still parses normal text messages", () => {
      const body = {
        event: {
          channel: "C123",
          user: "U456",
          text: "hello",
          ts: "1700000000.123456",
          channel_type: "im",
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.userMessage).toBe("hello");
    });
  });

  describe("parseWebhook mention extraction", () => {
    it("extracts Slack user mentions", () => {
      const body = {
        event: {
          type: "message",
          text: "Hey <@U12345> what do you think?",
          channel: "C123",
          user: "U999",
          ts: "1700000000.123456",
          channel_type: "group",
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result?.mentions).toEqual(["U12345"]);
    });

    it("extracts mentions with display name", () => {
      const body = {
        event: {
          type: "message",
          text: "Hey <@U12345|alice> and <@U67890>",
          channel: "C123",
          user: "U999",
          ts: "1700000000.123456",
          channel_type: "group",
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result?.mentions).toEqual(["U12345", "U67890"]);
    });

    it("extracts W-prefixed enterprise grid user mentions", () => {
      const body = {
        event: {
          type: "message",
          text: "Hey <@W12345ABC> check this",
          channel: "C123",
          user: "U999",
          ts: "1700000000.123456",
          channel_type: "group",
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result?.mentions).toEqual(["W12345ABC"]);
    });

    it("returns empty mentions when no user mentions", () => {
      const body = {
        event: {
          type: "message",
          text: "Hello everyone",
          channel: "C123",
          user: "U999",
          ts: "1700000000.123456",
          channel_type: "group",
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result?.mentions).toEqual([]);
    });
  });

  describe("formatMessage", () => {
    it("converts **bold** to *bold*", () => {
      expect(adapter.formatMessage("This is **bold** text")).toBe("This is *bold* text");
    });

    it("converts markdown links to Slack format", () => {
      expect(adapter.formatMessage("[Google](https://google.com)")).toBe("<https://google.com|Google>");
    });

    it("converts ~~strike~~ to ~strike~", () => {
      expect(adapter.formatMessage("~~deleted~~")).toBe("~deleted~");
    });

    it("converts headings to bold", () => {
      expect(adapter.formatMessage("## Heading")).toBe("*Heading*");
    });

    it("converts list markers", () => {
      expect(adapter.formatMessage("- item one\n- item two")).toBe("• item one\n• item two");
    });

    it("preserves code blocks unchanged", () => {
      expect(adapter.formatMessage("```\n**not bold**\n```")).toBe("```\n**not bold**\n```");
    });

    it("preserves inline code unchanged", () => {
      expect(adapter.formatMessage("Use `**code**` here")).toBe("Use `**code**` here");
    });
  });
});

describe("Slack API ok:false handling", () => {
  it("retries on Slack ratelimited error (ok:false with ratelimited)", async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: false, error: "ratelimited" }),
        headers: new Headers({ "Retry-After": "2" }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ ok: true }),
      });

    await sendSlackMessage("tok", "C1", "Hi");

    expect(mockFetch).toHaveBeenCalledTimes(2);
  }, 10000);

  it("throws on non-retryable Slack API error (ok:false)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: false, error: "channel_not_found" }),
    });

    await expect(sendSlackMessage("tok", "C1", "Hi")).rejects.toThrow(
      "Slack API error: channel_not_found"
    );
  });

  it("passes through when Slack returns ok:true", async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ ok: true, ts: "123" }),
    });

    await sendSlackMessage("tok", "C1", "Hi");

    expect(mockFetch).toHaveBeenCalledOnce();
  });
});

describe("extractSlackFileRefs", () => {
  it("extracts all files with auth header", () => {
    const body = {
      event: {
        files: [
          { url_private_download: "https://files.slack.com/img.png", mimetype: "image/png", name: "img.png" },
          { url_private_download: "https://files.slack.com/doc.pdf", mimetype: "application/pdf", name: "doc.pdf" },
        ],
      },
    };
    const refs = extractSlackFileRefs(body, "xoxb-token");
    expect(refs).toHaveLength(2);
    expect(refs[0].authHeader).toBe("Bearer xoxb-token");
    expect(refs[0].mediaType).toBe("image/png");
    expect(refs[0].fileName).toBe("img.png");
    expect(refs[1].mediaType).toBe("application/pdf");
    expect(refs[1].fileName).toBe("doc.pdf");
  });

  it("skips external files (mode=external)", () => {
    const body = {
      event: {
        files: [
          { url_private_download: "https://files.slack.com/img.png", mimetype: "image/png", name: "img.png" },
          { url_private_download: "https://external.com/file.pdf", mimetype: "application/pdf", name: "ext.pdf", mode: "external" },
        ],
      },
    };
    const refs = extractSlackFileRefs(body, "xoxb-token");
    expect(refs).toHaveLength(1);
    expect(refs[0].mediaType).toBe("image/png");
  });

  it("preserves fileName from file name field", () => {
    const body = {
      event: {
        files: [
          { url_private_download: "https://files.slack.com/data.csv", mimetype: "text/csv", name: "data.csv" },
        ],
      },
    };
    const refs = extractSlackFileRefs(body, "xoxb-token");
    expect(refs).toHaveLength(1);
    expect(refs[0].fileName).toBe("data.csv");
  });

  it("returns empty when no files", () => {
    const body = { event: { text: "hello" } };
    const refs = extractSlackFileRefs(body, "xoxb-token");
    expect(refs).toHaveLength(0);
  });
});

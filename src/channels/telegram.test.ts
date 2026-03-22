import { describe, it, expect, vi, beforeEach } from "vitest";
import { TelegramAdapter, extractTelegramFileRefs } from "./telegram";
import type { MediaItem } from "./registry";
import type { Env } from "../config/schema";

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

const _adapter = new TelegramAdapter();
const sendTelegramMessage = _adapter.sendMessage.bind(_adapter);

describe("sendTelegramMessage", () => {
  it("sends a short text message without media", async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendTelegramMessage("tok", "chat-1", "Hello");

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bottok/sendMessage");
    expect(JSON.parse(opts.body)).toEqual({
      chat_id: "chat-1",
      text: "Hello",
      parse_mode: "Markdown",
    });
  });

  it("sends photo via sendPhoto when URL media is provided", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });

    await sendTelegramMessage("tok", "chat-1", "Check this out", {
      media: [urlMedia("https://example.com/img.png")],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bottok/sendPhoto");
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe("chat-1");
    expect(body.photo).toBe("https://example.com/img.png");
    expect(body.caption).toBe("Check this out");
    expect(body.parse_mode).toBe("Markdown");
  });

  it("sends multiple URL photos via sendMediaGroup", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });

    await sendTelegramMessage("tok", "chat-1", "Two pics", {
      media: [urlMedia("https://example.com/a.png"), urlMedia("https://example.com/b.png")],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bottok/sendMediaGroup");
    const body = JSON.parse(opts.body);
    expect(body.chat_id).toBe("chat-1");
    expect(body.media).toHaveLength(2);
    expect(body.media[0]).toEqual({
      type: "photo",
      media: "https://example.com/a.png",
      caption: "Two pics",
      parse_mode: "Markdown",
    });
    expect(body.media[1]).toEqual({
      type: "photo",
      media: "https://example.com/b.png",
    });
  });

  it("sends multiple base64 photos via sendMediaGroup with FormData", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });

    await sendTelegramMessage("tok", "chat-1", "Two pics", {
      media: [base64Media("aGVsbG8=", "image/png"), base64Media("d29ybGQ=", "image/jpeg")],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bottok/sendMediaGroup");
    expect(opts.body).toBeInstanceOf(FormData);
    const form = opts.body as FormData;
    expect(form.get("chat_id")).toBe("chat-1");
    const mediaArr = JSON.parse(form.get("media") as string);
    expect(mediaArr).toHaveLength(2);
    expect(mediaArr[0].media).toBe("attach://file0");
    expect(mediaArr[0].caption).toBe("Two pics");
    expect(mediaArr[1].media).toBe("attach://file1");
    expect(form.get("file0")).toBeInstanceOf(Blob);
    expect(form.get("file1")).toBeInstanceOf(Blob);
  });

  it("sends text separately when multiple photos and caption exceeds limit", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });

    const longText = "A".repeat(1025);
    await sendTelegramMessage("tok", "chat-1", longText, {
      media: [urlMedia("https://example.com/a.png"), urlMedia("https://example.com/b.png")],
    });

    // 1 sendMediaGroup (no caption) + 1 sendMessage (text)
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [groupUrl, groupOpts] = mockFetch.mock.calls[0];
    expect(groupUrl).toContain("/sendMediaGroup");
    const body = JSON.parse(groupOpts.body);
    expect(body.media[0].caption).toBeUndefined();

    const [textUrl] = mockFetch.mock.calls[1];
    expect(textUrl).toContain("/sendMessage");
  });

  it("sends text separately when caption exceeds 1024 chars", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });

    const longText = "A".repeat(1025);
    await sendTelegramMessage("tok", "chat-1", longText, {
      media: [urlMedia("https://example.com/img.png")],
    });

    // 1 sendPhoto (no caption) + 1 sendMessage (text)
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const [photoUrl] = mockFetch.mock.calls[0];
    expect(photoUrl).toContain("/sendPhoto");

    const [textUrl] = mockFetch.mock.calls[1];
    expect(textUrl).toContain("/sendMessage");
  });

  it("falls back to plain caption when Markdown parsing fails", async () => {
    // First sendPhoto with Markdown fails, second without parse_mode succeeds
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "Bad Request" })
      .mockResolvedValueOnce({ ok: true, text: async () => "" });

    await sendTelegramMessage("tok", "chat-1", "some *broken* _text", {
      media: [urlMedia("https://example.com/img.png")],
    });

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does not use sendPhoto when media array is empty", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });

    await sendTelegramMessage("tok", "chat-1", "No media", { media: [] });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/sendMessage");
  });

  it("throws when both Markdown and plain-text sends fail", async () => {
    // Markdown send fails (400), plain-text fallback also fails (400)
    mockFetch
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "Bad Request" })
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "Bad Request" });

    await expect(sendTelegramMessage("tok", "chat-1", "Hello")).rejects.toThrow(
      "Telegram sendMessage failed"
    );
  });

  it("splits long text messages into chunks", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });

    const longText = "X".repeat(5000);
    await sendTelegramMessage("tok", "chat-1", longText);

    // 5000 / 4096 = 2 chunks
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("sends base64 image via FormData", async () => {
    mockFetch.mockResolvedValue({ ok: true, text: async () => "" });

    await sendTelegramMessage("tok", "chat-1", "Generated image", {
      media: [base64Media("aGVsbG8=", "image/png")],
    });

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe("https://api.telegram.org/bottok/sendPhoto");
    // Should use FormData (no Content-Type header — browser sets multipart boundary)
    expect(opts.body).toBeInstanceOf(FormData);
    const form = opts.body as FormData;
    expect(form.get("chat_id")).toBe("chat-1");
    expect(form.get("caption")).toBe("Generated image");
    expect(form.get("photo")).toBeInstanceOf(Blob);
  });
});

describe("TelegramAdapter", () => {
  const adapter = new TelegramAdapter();

  describe("name and maxMessageLength", () => {
    it("has correct name", () => {
      expect(adapter.name).toBe("telegram");
    });

    it("has correct maxMessageLength", () => {
      expect(adapter.maxMessageLength).toBe(4096);
    });
  });

  describe("preProcessWebhook", () => {
    function makeRequest(secret?: string): Request {
      const headers = new Headers();
      if (secret !== undefined) {
        headers.set("X-Telegram-Bot-Api-Secret-Token", secret);
      }
      return new Request("https://example.com/webhook/telegram/tok", {
        method: "POST",
        headers,
      });
    }

    const env = { WEBHOOK_SECRET: "my-secret" } as unknown as Env;

    it("returns 401 when secret is missing", () => {
      const result = adapter.preProcessWebhook(makeRequest(), {}, env);
      expect(result).toBeInstanceOf(Response);
      expect(result!.status).toBe(401);
    });

    it("returns 401 when secret is wrong", () => {
      const result = adapter.preProcessWebhook(makeRequest("wrong-secret"), {}, env);
      expect(result).toBeInstanceOf(Response);
      expect(result!.status).toBe(401);
    });

    it("returns null when secret is correct", () => {
      const result = adapter.preProcessWebhook(makeRequest("my-secret"), {}, env);
      expect(result).toBeNull();
    });
  });

  describe("parseWebhook", () => {
    it("parses a valid Telegram update", () => {
      const body = {
        update_id: 123,
        message: {
          message_id: 456,
          chat: { id: 789, type: "private" as const },
          from: { id: 111, first_name: "Alice", username: "alice" },
          text: "Hello bot",
          date: 1700000000,
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).toEqual({
        chatId: "789",
        userId: "111",
        userName: "Alice",
        userMessage: "Hello bot",
        chatType: "private",
        messageId: "456",
        messageDate: 1700000000,
        mentions: [],
      });
    });

    it("returns null when there is no text, caption, photo, or document (e.g. sticker)", () => {
      const body = {
        update_id: 123,
        message: {
          message_id: 456,
          chat: { id: 789, type: "private" as const },
          from: { id: 111, first_name: "Alice" },
          date: 1700000000,
          // no text, caption, photo, or document
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).toBeNull();
    });

    it("parses photo message with caption", () => {
      const body = {
        update_id: 123,
        message: {
          message_id: 456,
          chat: { id: 789, type: "private" as const },
          from: { id: 111, first_name: "Alice" },
          date: 1700000000,
          caption: "Look at this!",
          photo: [
            { file_id: "small_id", file_size: 1000, width: 90, height: 90 },
            { file_id: "large_id", file_size: 5000, width: 800, height: 600 },
          ],
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.userMessage).toBe("Look at this!");
      expect(result!.chatId).toBe("789");
      expect(result!.userName).toBe("Alice");
    });

    it("parses photo message without caption (userMessage = empty string)", () => {
      const body = {
        update_id: 123,
        message: {
          message_id: 456,
          chat: { id: 789, type: "private" as const },
          from: { id: 111, first_name: "Alice" },
          date: 1700000000,
          photo: [
            { file_id: "small_id", file_size: 1000, width: 90, height: 90 },
            { file_id: "large_id", file_size: 5000, width: 800, height: 600 },
          ],
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.userMessage).toBe("");
    });

    it("parses document message with image mime type", () => {
      const body = {
        update_id: 123,
        message: {
          message_id: 456,
          chat: { id: 789, type: "private" as const },
          from: { id: 111, first_name: "Alice" },
          date: 1700000000,
          caption: "A PNG file",
          document: {
            file_id: "doc_file_id",
            file_name: "screenshot.png",
            mime_type: "image/png",
            file_size: 12345,
          },
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.userMessage).toBe("A PNG file");
    });

    it("returns null when there is no message", () => {
      const body = { update_id: 123 };
      const result = adapter.parseWebhook(body);
      expect(result).toBeNull();
    });

    it("returns null for completely invalid payload (safeParse)", () => {
      expect(adapter.parseWebhook("not-an-object")).toBeNull();
      expect(adapter.parseWebhook(null)).toBeNull();
      expect(adapter.parseWebhook(42)).toBeNull();
      expect(adapter.parseWebhook({})).toBeNull();
    });

    it("returns replyToName when replying to a message", () => {
      const body = {
        update_id: 123,
        message: {
          message_id: 456,
          chat: { id: 789, type: "supergroup" as const },
          from: { id: 111, first_name: "Bob" },
          text: "I agree",
          date: 1700000000,
          reply_to_message: {
            from: { first_name: "Alice", username: "alice" },
            text: "What do you think?",
          },
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.userMessage).toBe("I agree");
      expect(result!.replyToName).toBe("Alice");
      expect(result!.replyToText).toBe("What do you think?");
      expect(result!.chatType).toBe("supergroup");
    });

    it("returns undefined replyToName when reply has no from name", () => {
      const body = {
        update_id: 123,
        message: {
          message_id: 456,
          chat: { id: 789, type: "private" as const },
          from: { id: 111, first_name: "Bob" },
          text: "I agree",
          date: 1700000000,
          reply_to_message: {
            text: "Some text",
          },
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.userMessage).toBe("I agree");
      expect(result!.replyToName).toBeUndefined();
    });

    it("defaults userName to 'User' when from is missing", () => {
      const body = {
        update_id: 123,
        message: {
          message_id: 456,
          chat: { id: 789, type: "private" as const },
          text: "Hello",
          date: 1700000000,
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.userName).toBe("User");
      expect(result!.userId).toBe("0");
    });

    it("returns messageDate from message.date", () => {
      const body = {
        update_id: 123,
        message: {
          message_id: 456,
          chat: { id: 789, type: "private" as const },
          from: { id: 111, first_name: "Alice" },
          text: "Hello",
          date: 1700000000,
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.messageDate).toBe(1700000000);
    });

    it("returns replyToText from reply_to_message.text", () => {
      const body = {
        update_id: 123,
        message: {
          message_id: 456,
          chat: { id: 789, type: "supergroup" as const },
          from: { id: 111, first_name: "Bob" },
          text: "I agree",
          date: 1700000000,
          reply_to_message: {
            from: { first_name: "Alice" },
            text: "What do you think?",
          },
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result!.replyToText).toBe("What do you think?");
    });

    it("returns replyToText from reply_to_message.caption when text is absent", () => {
      const body = {
        update_id: 123,
        message: {
          message_id: 456,
          chat: { id: 789, type: "group" as const },
          from: { id: 111, first_name: "Bob" },
          text: "Nice photo",
          date: 1700000000,
          reply_to_message: {
            from: { first_name: "Alice" },
            caption: "Check this out",
          },
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result!.replyToText).toBe("Check this out");
    });

    it("returns undefined replyToText when reply has no text or caption", () => {
      const body = {
        update_id: 123,
        message: {
          message_id: 456,
          chat: { id: 789, type: "group" as const },
          from: { id: 111, first_name: "Bob" },
          text: "Nice",
          date: 1700000000,
          reply_to_message: {
            from: { first_name: "Alice" },
          },
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result!.replyToText).toBeUndefined();
    });

    it("parses voice message with isVoiceMessage flag", () => {
      const body = {
        update_id: 1,
        message: {
          message_id: 100,
          chat: { id: 123, type: "private" as const },
          from: { id: 456, first_name: "Alice" },
          voice: { file_id: "voice_file_1", duration: 5, file_size: 12000 },
          date: 1700000000,
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.isVoiceMessage).toBe(true);
      expect(result!.userMessage).toBe("");
    });

    it("parses voice message with caption", () => {
      const body = {
        update_id: 1,
        message: {
          message_id: 101,
          chat: { id: 123, type: "private" as const },
          from: { id: 456, first_name: "Alice" },
          voice: { file_id: "voice_file_2", duration: 10 },
          caption: "Check this voice note",
          date: 1700000000,
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.isVoiceMessage).toBe(true);
      expect(result!.userMessage).toBe("Check this voice note");
    });

    it("parses audio message with isVoiceMessage flag", () => {
      const body = {
        update_id: 1,
        message: {
          message_id: 102,
          chat: { id: 123, type: "private" as const },
          from: { id: 456, first_name: "Alice" },
          audio: { file_id: "audio_file_1", duration: 180, mime_type: "audio/mpeg", file_name: "song.mp3" },
          date: 1700000000,
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.isVoiceMessage).toBe(true);
    });

    it("does not set isVoiceMessage for text-only messages", () => {
      const body = {
        update_id: 1,
        message: {
          message_id: 103,
          chat: { id: 123, type: "private" as const },
          from: { id: 456, first_name: "Alice" },
          text: "hello",
          date: 1700000000,
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result).not.toBeNull();
      expect(result!.isVoiceMessage).toBeUndefined();
    });
  });

  describe("parseWebhook mention extraction", () => {
    it("extracts @username mentions from entities", () => {
      const body = {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 100, type: "supergroup" as const },
          from: { id: 1, first_name: "User" },
          text: "Hey @xiaomian_bot what do you think?",
          date: 1700000000,
          entities: [{ type: "mention", offset: 4, length: 13 }],
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result?.mentions).toEqual(["@xiaomian_bot"]);
    });

    it("extracts text_mention entities", () => {
      const body = {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 100, type: "supergroup" as const },
          from: { id: 1, first_name: "User" },
          text: "Hey BotName what do you think?",
          date: 1700000000,
          entities: [{ type: "text_mention", offset: 4, length: 7, user: { id: 999, first_name: "BotName", username: "botname_bot" } }],
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result?.mentions).toEqual(["@botname_bot"]);
    });

    it("extracts mentions from caption_entities", () => {
      const body = {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 100, type: "supergroup" as const },
          from: { id: 1, first_name: "User" },
          caption: "Check this @bot_name",
          date: 1700000000,
          photo: [{ file_id: "abc", width: 100, height: 100 }],
          caption_entities: [{ type: "mention", offset: 11, length: 9 }],
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result?.mentions).toEqual(["@bot_name"]);
    });

    it("returns empty mentions when no entities", () => {
      const body = {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 100, type: "supergroup" as const },
          from: { id: 1, first_name: "User" },
          text: "Hello everyone",
          date: 1700000000,
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result?.mentions).toEqual([]);
    });

    it("deduplicates mentions", () => {
      const body = {
        update_id: 1,
        message: {
          message_id: 1,
          chat: { id: 100, type: "supergroup" as const },
          from: { id: 1, first_name: "User" },
          text: "@bot_x hello @bot_x",
          date: 1700000000,
          entities: [
            { type: "mention", offset: 0, length: 6 },
            { type: "mention", offset: 13, length: 6 },
          ],
        },
      };
      const result = adapter.parseWebhook(body);
      expect(result?.mentions).toEqual(["@bot_x"]);
    });
  });

  describe("formatMessage", () => {
    it("converts **bold** to *bold*", () => {
      expect(adapter.formatMessage("Hello **world**")).toBe("Hello *world*");
    });

    it("converts headings to bold text", () => {
      expect(adapter.formatMessage("## My Heading")).toBe("*My Heading*");
      expect(adapter.formatMessage("### Sub Heading")).toBe("*Sub Heading*");
    });

    it("converts list markers to bullets", () => {
      expect(adapter.formatMessage("- item one\n- item two")).toBe("• item one\n• item two");
    });

    it("strips strikethrough markers", () => {
      expect(adapter.formatMessage("~~deleted~~")).toBe("deleted");
    });

    it("preserves code blocks", () => {
      const input = "```\n**not bold**\n```";
      expect(adapter.formatMessage(input)).toBe("```\n**not bold**\n```");
    });

    it("preserves inline code", () => {
      expect(adapter.formatMessage("Use `**this**` please")).toBe("Use `**this**` please");
    });

    it("passes plain text through unchanged", () => {
      expect(adapter.formatMessage("Hello world")).toBe("Hello world");
    });
  });

  describe("sendTyping", () => {
    it("sends typing action to Telegram API", async () => {
      mockFetch.mockResolvedValueOnce({ ok: true, text: async () => "" });

      await adapter.sendTyping("tok", "chat-1");

      expect(mockFetch).toHaveBeenCalledOnce();
      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe("https://api.telegram.org/bottok/sendChatAction");
      expect(JSON.parse(opts.body)).toEqual({
        chat_id: "chat-1",
        action: "typing",
      });
    });
  });
});

describe("extractTelegramFileRefs", () => {
  it("extracts largest photo file_id", () => {
    const body = {
      message: {
        photo: [
          { file_id: "small", file_size: 1000, width: 90, height: 90 },
          { file_id: "medium", file_size: 3000, width: 320, height: 240 },
          { file_id: "large", file_size: 8000, width: 800, height: 600 },
        ],
      },
    };
    const refs = extractTelegramFileRefs(body);
    expect(refs).toHaveLength(1);
    expect(refs[0].downloadUrl).toBe("__telegram_file_id__:large");
    expect(refs[0].mediaType).toBe("image/jpeg");
  });

  it("extracts document with image mime type", () => {
    const body = {
      message: {
        document: {
          file_id: "doc_id",
          file_name: "screenshot.png",
          mime_type: "image/png",
          file_size: 12345,
        },
      },
    };
    const refs = extractTelegramFileRefs(body);
    expect(refs).toHaveLength(1);
    expect(refs[0].downloadUrl).toBe("__telegram_file_id__:doc_id");
    expect(refs[0].mediaType).toBe("image/png");
    expect(refs[0].fileName).toBe("screenshot.png");
  });

  it("extracts non-image documents (e.g. PDF)", () => {
    const body = {
      message: {
        document: {
          file_id: "doc_id",
          file_name: "report.pdf",
          mime_type: "application/pdf",
          file_size: 99999,
        },
      },
    };
    const refs = extractTelegramFileRefs(body);
    expect(refs).toHaveLength(1);
    expect(refs[0].downloadUrl).toBe("__telegram_file_id__:doc_id");
    expect(refs[0].mediaType).toBe("application/pdf");
    expect(refs[0].fileName).toBe("report.pdf");
  });

  it("defaults mediaType to application/octet-stream when mime_type is absent", () => {
    const body = {
      message: {
        document: {
          file_id: "doc_id",
          file_name: "unknown_file",
        },
      },
    };
    const refs = extractTelegramFileRefs(body);
    expect(refs).toHaveLength(1);
    expect(refs[0].mediaType).toBe("application/octet-stream");
  });

  it("extracts both photo and document when present", () => {
    const body = {
      message: {
        photo: [
          { file_id: "photo_id", file_size: 5000, width: 800, height: 600 },
        ],
        document: {
          file_id: "doc_id",
          mime_type: "image/webp",
        },
      },
    };
    const refs = extractTelegramFileRefs(body);
    expect(refs).toHaveLength(2);
    expect(refs[0].downloadUrl).toBe("__telegram_file_id__:photo_id");
    expect(refs[1].downloadUrl).toBe("__telegram_file_id__:doc_id");
  });

  it("preserves fileName from document", () => {
    const body = {
      message: {
        document: {
          file_id: "doc_id",
          file_name: "data.csv",
          mime_type: "text/csv",
        },
      },
    };
    const refs = extractTelegramFileRefs(body);
    expect(refs).toHaveLength(1);
    expect(refs[0].fileName).toBe("data.csv");
  });

  it("returns empty array when no message", () => {
    expect(extractTelegramFileRefs({})).toEqual([]);
    expect(extractTelegramFileRefs(null)).toEqual([]);
    expect(extractTelegramFileRefs(undefined)).toEqual([]);
  });

  it("returns empty array when message has no photo or document", () => {
    const body = { message: { text: "Hello" } };
    expect(extractTelegramFileRefs(body)).toEqual([]);
  });

  it("extracts voice message file ref", () => {
    const body = {
      message: {
        voice: { file_id: "voice_id_1", duration: 5, file_size: 8000 },
      },
    };
    const refs = extractTelegramFileRefs(body);
    expect(refs).toHaveLength(1);
    expect(refs[0].downloadUrl).toBe("__telegram_file_id__:voice_id_1");
    expect(refs[0].mediaType).toBe("audio/ogg");
    expect(refs[0].fileName).toBe("voice.ogg");
  });

  it("extracts audio message file ref with mime_type", () => {
    const body = {
      message: {
        audio: {
          file_id: "audio_id_1",
          duration: 200,
          mime_type: "audio/mpeg",
          file_name: "song.mp3",
        },
      },
    };
    const refs = extractTelegramFileRefs(body);
    expect(refs).toHaveLength(1);
    expect(refs[0].downloadUrl).toBe("__telegram_file_id__:audio_id_1");
    expect(refs[0].mediaType).toBe("audio/mpeg");
    expect(refs[0].fileName).toBe("song.mp3");
  });

  it("extracts both photo and voice when present", () => {
    const body = {
      message: {
        photo: [{ file_id: "photo_id", file_size: 5000, width: 800, height: 600 }],
        voice: { file_id: "voice_id", duration: 10 },
      },
    };
    const refs = extractTelegramFileRefs(body);
    expect(refs).toHaveLength(2);
    expect(refs[0].mediaType).toBe("image/jpeg");
    expect(refs[1].mediaType).toBe("audio/ogg");
  });
});

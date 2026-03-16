import { describe, it, expect, vi } from "vitest";

// Mock Cloudflare Workers runtime modules before importing gateway
vi.mock("cloudflare:workers", () => ({
  DurableObject: class {},
}));
vi.mock("agents", () => ({
  getAgentByName: vi.fn(),
}));

import {
  parseGatewayPayload,
  shouldHandleMessage,
  buildIdentifyPayload,
  extractDiscordFileRefs,
  NON_RECOVERABLE_CLOSE_CODES,
  isAudioAttachment,
} from "./gateway";
import type { DiscordMessage } from "./gateway";

describe("parseGatewayPayload", () => {
  it("parses valid JSON into a GatewayPayload", () => {
    const raw = JSON.stringify({ op: 10, d: { heartbeat_interval: 41250 }, s: null, t: null });
    const result = parseGatewayPayload(raw);
    expect(result).toEqual({
      op: 10,
      d: { heartbeat_interval: 41250 },
      s: null,
      t: null,
    });
  });

  it("returns null for invalid JSON", () => {
    expect(parseGatewayPayload("not json")).toBeNull();
    expect(parseGatewayPayload("{broken")).toBeNull();
    expect(parseGatewayPayload("")).toBeNull();
  });
});

describe("shouldHandleMessage", () => {
  const baseMsg: DiscordMessage = {
    id: "1",
    channel_id: "ch-1",
    content: "Hello",
    author: { id: "u1", username: "alice" },
  };

  it("returns true for normal user messages", () => {
    expect(shouldHandleMessage(baseMsg)).toBe(true);
  });

  it("returns false for bot messages", () => {
    const botMsg = { ...baseMsg, author: { ...baseMsg.author, bot: true } };
    expect(shouldHandleMessage(botMsg)).toBe(false);
  });

  it("returns false for empty content", () => {
    const emptyMsg = { ...baseMsg, content: "" };
    expect(shouldHandleMessage(emptyMsg)).toBe(false);
  });

  it("accepts message with image attachment and no text", () => {
    const msg: DiscordMessage = {
      ...baseMsg,
      content: "",
      attachments: [
        { id: "a1", url: "https://cdn.discord.com/img.png", content_type: "image/png", size: 1024 },
      ],
    };
    expect(shouldHandleMessage(msg)).toBe(true);
  });

  it("accepts message with non-image attachment and no text (e.g. PDF)", () => {
    const msg: DiscordMessage = {
      ...baseMsg,
      content: "",
      attachments: [
        { id: "a2", url: "https://cdn.discord.com/file.pdf", content_type: "application/pdf", size: 2048 },
      ],
    };
    expect(shouldHandleMessage(msg)).toBe(true);
  });
});

describe("extractDiscordFileRefs", () => {
  it("extracts all attachments with content_type", () => {
    const msg: DiscordMessage = {
      id: "1",
      channel_id: "ch-1",
      content: "check these out",
      author: { id: "u1", username: "alice" },
      attachments: [
        { id: "a1", url: "https://cdn.discord.com/img.png", content_type: "image/png", size: 1024, filename: "img.png" },
        { id: "a2", url: "https://cdn.discord.com/doc.pdf", content_type: "application/pdf", size: 2048, filename: "doc.pdf" },
        { id: "a3", url: "https://cdn.discord.com/photo.jpg", content_type: "image/jpeg", size: 512 },
      ],
    };
    const refs = extractDiscordFileRefs(msg);
    expect(refs).toEqual([
      { downloadUrl: "https://cdn.discord.com/img.png", mediaType: "image/png", fileName: "img.png" },
      { downloadUrl: "https://cdn.discord.com/doc.pdf", mediaType: "application/pdf", fileName: "doc.pdf" },
      { downloadUrl: "https://cdn.discord.com/photo.jpg", mediaType: "image/jpeg", fileName: undefined },
    ]);
  });

  it("skips attachments without content_type", () => {
    const msg: DiscordMessage = {
      id: "1",
      channel_id: "ch-1",
      content: "file",
      author: { id: "u1", username: "alice" },
      attachments: [
        { id: "a1", url: "https://cdn.discord.com/unknown", size: 100 },
      ],
    };
    expect(extractDiscordFileRefs(msg)).toEqual([]);
  });

  it("preserves filename", () => {
    const msg: DiscordMessage = {
      id: "1",
      channel_id: "ch-1",
      content: "",
      author: { id: "u1", username: "alice" },
      attachments: [
        { id: "a1", url: "https://cdn.discord.com/report.pdf", content_type: "application/pdf", filename: "report.pdf" },
      ],
    };
    const refs = extractDiscordFileRefs(msg);
    expect(refs).toHaveLength(1);
    expect(refs[0].fileName).toBe("report.pdf");
  });

  it("returns empty for no attachments", () => {
    const msg: DiscordMessage = {
      id: "1",
      channel_id: "ch-1",
      content: "just text",
      author: { id: "u1", username: "alice" },
    };
    expect(extractDiscordFileRefs(msg)).toEqual([]);
  });
});

describe("buildIdentifyPayload", () => {
  it("builds an op:2 IDENTIFY payload with correct structure", () => {
    const payload = buildIdentifyPayload("my-bot-token");
    expect(payload.op).toBe(2);
    expect(payload.d.token).toBe("my-bot-token");
    expect(payload.d.intents).toBe(37377);
    expect(payload.d.properties).toEqual({
      os: "multibot",
      browser: "multibot",
      device: "multibot",
    });
  });
});

describe("NON_RECOVERABLE_CLOSE_CODES", () => {
  it("contains authentication failure codes", () => {
    expect(NON_RECOVERABLE_CLOSE_CODES.has(4004)).toBe(true); // Auth failed
    expect(NON_RECOVERABLE_CLOSE_CODES.has(4014)).toBe(true); // Disallowed intents
  });

  it("does not contain recoverable codes", () => {
    expect(NON_RECOVERABLE_CLOSE_CODES.has(4000)).toBe(false); // Unknown error (recoverable)
    expect(NON_RECOVERABLE_CLOSE_CODES.has(4001)).toBe(false); // Unknown opcode
    expect(NON_RECOVERABLE_CLOSE_CODES.has(4009)).toBe(false); // Session timed out (resume)
    expect(NON_RECOVERABLE_CLOSE_CODES.has(1000)).toBe(false); // Normal closure
  });
});

describe("isAudioAttachment", () => {
  it("returns true for audio content types", () => {
    expect(isAudioAttachment({ content_type: "audio/ogg" })).toBe(true);
    expect(isAudioAttachment({ content_type: "audio/webm" })).toBe(true);
    expect(isAudioAttachment({ content_type: "audio/mpeg" })).toBe(true);
  });

  it("returns false for non-audio content types", () => {
    expect(isAudioAttachment({ content_type: "image/png" })).toBe(false);
    expect(isAudioAttachment({ content_type: "application/pdf" })).toBe(false);
  });

  it("returns false when content_type is undefined", () => {
    expect(isAudioAttachment({ content_type: undefined })).toBe(false);
    expect(isAudioAttachment({})).toBe(false);
  });
});

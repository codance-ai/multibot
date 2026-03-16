import { describe, it, expect, vi, beforeEach } from "vitest";
import { sendFinalReply, buildTtsPolicy, type SendReplyParams, type SendReplyAdapterFns } from "./send-reply";

function makeParams(overrides: Partial<SendReplyParams> = {}): SendReplyParams {
  return {
    text: "Hello, this is a test reply message!",
    channelToken: "tok",
    chatId: "chat1",
    ttsPolicy: {
      ttsProvider: "elevenlabs" as const,
      voiceMode: "always" as const,
      ttsVoice: "21m00Tcm4TlvDq8ikWAM",
      ttsModel: "eleven_multilingual_v2",
      apiKey: "sk-test",
    },
    isVoiceMessage: false,
    ...overrides,
  };
}

function makeAdapter(overrides: Partial<SendReplyAdapterFns> = {}): SendReplyAdapterFns {
  return {
    sendMessage: vi.fn().mockResolvedValue(undefined),
    sendAudio: vi.fn().mockResolvedValue({ captionSent: true }),
    ...overrides,
  };
}

describe("sendFinalReply", () => {
  beforeEach(() => { vi.restoreAllMocks(); });

  it("sends text-only when voiceMode is off", async () => {
    const adapter = makeAdapter();
    const params = makeParams({ ttsPolicy: { ttsProvider: "elevenlabs", voiceMode: "off", ttsVoice: "alloy", ttsModel: "m", apiKey: "k" } });
    const result = await sendFinalReply(params, adapter);
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
    expect(adapter.sendAudio).not.toHaveBeenCalled();
    expect(result.voiceSent).toBe(false);
  });

  it("sends voice-only (no text) when TTS succeeds with caption", async () => {
    const fakeAudio = new ArrayBuffer(50);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, arrayBuffer: () => Promise.resolve(fakeAudio),
    }));
    const adapter = makeAdapter();
    const result = await sendFinalReply(makeParams(), adapter);
    // Voice sent with caption — no separate text message
    expect(adapter.sendAudio).toHaveBeenCalledOnce();
    expect(adapter.sendMessage).not.toHaveBeenCalled();
    // Verify caption was passed
    const audioOpts = (adapter.sendAudio as any).mock.calls[0][3];
    expect(audioOpts.caption).toBe("Hello, this is a test reply message!");
    expect(result.voiceSent).toBe(true);
    vi.unstubAllGlobals();
  });

  it("sends voice + text when captionSent is false (too long)", async () => {
    const fakeAudio = new ArrayBuffer(50);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, arrayBuffer: () => Promise.resolve(fakeAudio),
    }));
    const adapter = makeAdapter({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendAudio: vi.fn().mockResolvedValue({ captionSent: false }),
    });
    const result = await sendFinalReply(makeParams(), adapter);
    expect(adapter.sendAudio).toHaveBeenCalledOnce();
    // Caption didn't fit — text sent separately
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
    expect(result.voiceSent).toBe(true);
    vi.unstubAllGlobals();
  });

  it("falls back to text on TTS synthesis failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false, status: 500, text: () => Promise.resolve("Server error"),
    }));
    const adapter = makeAdapter();
    const result = await sendFinalReply(makeParams(), adapter);
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
    expect(adapter.sendAudio).not.toHaveBeenCalled();
    expect(result.voiceSent).toBe(false);
    vi.unstubAllGlobals();
  });

  it("sends text only when adapter has no sendAudio", async () => {
    const adapter = makeAdapter({ sendAudio: undefined });
    await sendFinalReply(makeParams(), adapter);
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
  });

  it("sends text only when no API key", async () => {
    const adapter = makeAdapter();
    const params = makeParams({ ttsPolicy: { ttsProvider: "elevenlabs", voiceMode: "always", ttsVoice: "alloy", ttsModel: "m", apiKey: undefined } });
    await sendFinalReply(params, adapter);
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
    expect(adapter.sendAudio).not.toHaveBeenCalled();
  });

  it("falls back to text when sendAudio throws", async () => {
    const fakeAudio = new ArrayBuffer(50);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, arrayBuffer: () => Promise.resolve(fakeAudio),
    }));
    const adapter = makeAdapter({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendAudio: vi.fn().mockRejectedValue(new Error("network error")),
    });
    const result = await sendFinalReply(makeParams(), adapter);
    // sendAudio failed — fell back to sendMessage
    expect(adapter.sendAudio).toHaveBeenCalledOnce();
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
    expect(result.voiceSent).toBe(false);
    vi.unstubAllGlobals();
  });

  it("includes media in sendMessage options (non-TTS path)", async () => {
    const adapter = makeAdapter();
    const media = [{ kind: "image" as const, source: { type: "url" as const, url: "https://example.com/img.png" } }];
    const params = makeParams({
      media,
      ttsPolicy: { ttsProvider: "elevenlabs" as const, voiceMode: "off", ttsVoice: "alloy", ttsModel: "m", apiKey: "k" },
    });
    await sendFinalReply(params, adapter);
    expect(adapter.sendMessage).toHaveBeenCalledWith("tok", "chat1", expect.any(String), expect.objectContaining({ media }));
  });

  it("sends audio + media separately when TTS succeeds with media", async () => {
    const fakeAudio = new ArrayBuffer(50);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, arrayBuffer: () => Promise.resolve(fakeAudio),
    }));
    const adapter = makeAdapter();
    const media = [{ kind: "image" as const, source: { type: "url" as const, url: "https://example.com/img.png" } }];
    await sendFinalReply(makeParams({ media }), adapter);
    // Audio sent with caption
    expect(adapter.sendAudio).toHaveBeenCalledOnce();
    // Media sent separately
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
    expect(adapter.sendMessage).toHaveBeenCalledWith("tok", "chat1", "", expect.objectContaining({ media }));
    vi.unstubAllGlobals();
  });

  it("sends audio + text with media when caption too long and media present", async () => {
    const fakeAudio = new ArrayBuffer(50);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, arrayBuffer: () => Promise.resolve(fakeAudio),
    }));
    const adapter = makeAdapter({
      sendMessage: vi.fn().mockResolvedValue(undefined),
      sendAudio: vi.fn().mockResolvedValue({ captionSent: false }),
    });
    const media = [{ kind: "image" as const, source: { type: "url" as const, url: "https://example.com/img.png" } }];
    await sendFinalReply(makeParams({ media }), adapter);
    expect(adapter.sendAudio).toHaveBeenCalledOnce();
    // Caption didn't fit — text + media sent together
    expect(adapter.sendMessage).toHaveBeenCalledOnce();
    expect(adapter.sendMessage).toHaveBeenCalledWith("tok", "chat1", expect.any(String), expect.objectContaining({ media }));
    vi.unstubAllGlobals();
  });
});

describe("buildTtsPolicy", () => {
  it("builds policy from bot config and user keys (elevenlabs)", () => {
    const policy = buildTtsPolicy(
      { ttsProvider: "elevenlabs", voiceMode: "always", ttsVoice: "nova", ttsModel: "eleven_multilingual_v2" } as any,
      { elevenlabs: "sk-test" },
    );
    expect(policy).toEqual({
      ttsProvider: "elevenlabs",
      voiceMode: "always",
      ttsVoice: "nova",
      ttsModel: "eleven_multilingual_v2",
      apiKey: "sk-test",
    });
  });

  it("builds policy for fish provider", () => {
    const policy = buildTtsPolicy(
      { ttsProvider: "fish", voiceMode: "mirror", ttsVoice: "fish-voice-id", ttsModel: "fish-model" } as any,
      { elevenlabs: "el-key", fish: "fish-key" },
    );
    expect(policy).toEqual({
      ttsProvider: "fish",
      voiceMode: "mirror",
      ttsVoice: "fish-voice-id",
      ttsModel: "fish-model",
      apiKey: "fish-key",
    });
  });

  it("uses defaults when config fields missing", () => {
    const policy = buildTtsPolicy({} as any, {});
    expect(policy).toEqual({
      ttsProvider: "fish",
      voiceMode: "off",
      ttsVoice: "",
      ttsModel: "s2-pro",
      apiKey: undefined,
    });
  });
});

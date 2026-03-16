import { describe, it, expect, vi, afterEach } from "vitest";
import { shouldSynthesize, stripMarkdownForTTS, synthesizeSpeech } from "./tts";
import type { TTSContext } from "./tts";

describe("shouldSynthesize", () => {
  const baseCtx: TTSContext = { isVoiceMessage: false };
  const voiceCtx: TTSContext = { isVoiceMessage: true };
  const validText = "Hello, this is a test message.";

  it("returns false when voiceMode is off", () => {
    expect(shouldSynthesize(validText, "off", voiceCtx)).toBe(false);
  });

  it("returns true when voiceMode is always and text is valid", () => {
    expect(shouldSynthesize(validText, "always", baseCtx)).toBe(true);
  });

  it("returns true when voiceMode is mirror and message is voice", () => {
    expect(shouldSynthesize(validText, "mirror", voiceCtx)).toBe(true);
  });

  it("returns false when voiceMode is mirror and message is text", () => {
    expect(shouldSynthesize(validText, "mirror", baseCtx)).toBe(false);
  });

  it("returns false when voiceMode is mirror and sttFailed", () => {
    const ctx: TTSContext = { isVoiceMessage: true, sttFailed: true };
    expect(shouldSynthesize(validText, "mirror", ctx)).toBe(false);
  });

  it("returns true for short text", () => {
    expect(shouldSynthesize("Hi", "always", baseCtx)).toBe(true);
  });

  it("returns false when text is too long", () => {
    const longText = "a".repeat(4097);
    expect(shouldSynthesize(longText, "always", baseCtx)).toBe(false);
  });

  it("returns true when text is exactly at MAX_TTS_LENGTH", () => {
    const text = "a".repeat(4096);
    expect(shouldSynthesize(text, "always", baseCtx)).toBe(true);
  });

  it("returns true when voiceMode is always regardless of media presence", () => {
    expect(shouldSynthesize(validText, "always", baseCtx)).toBe(true);
  });

  it("returns true when voiceMode is mirror with voice regardless of media presence", () => {
    expect(shouldSynthesize(validText, "mirror", voiceCtx)).toBe(true);
  });
});

describe("stripMarkdownForTTS", () => {
  it("strips bold markers", () => {
    expect(stripMarkdownForTTS("This is **bold** text")).toBe("This is bold text");
  });

  it("strips italic markers with asterisks", () => {
    expect(stripMarkdownForTTS("This is *italic* text")).toBe("This is italic text");
  });

  it("strips bold italic markers", () => {
    expect(stripMarkdownForTTS("This is ***bold italic*** text")).toBe(
      "This is bold italic text",
    );
  });

  it("strips bold markers with underscores", () => {
    expect(stripMarkdownForTTS("This is __bold__ text")).toBe("This is bold text");
  });

  it("strips italic markers with underscores", () => {
    expect(stripMarkdownForTTS("This is _italic_ text")).toBe("This is italic text");
  });

  it("removes code blocks entirely", () => {
    const input = "Before\n```js\nconsole.log('hi');\n```\nAfter";
    expect(stripMarkdownForTTS(input)).toBe("Before\n\nAfter");
  });

  it("strips inline code markers but keeps content", () => {
    expect(stripMarkdownForTTS("Use `npm install` to install")).toBe(
      "Use npm install to install",
    );
  });

  it("strips links but keeps display text", () => {
    expect(stripMarkdownForTTS("Visit [Google](https://google.com) now")).toBe(
      "Visit Google now",
    );
  });

  it("strips heading markers", () => {
    expect(stripMarkdownForTTS("## Introduction\nSome text")).toBe(
      "Introduction\nSome text",
    );
  });

  it("strips multiple heading levels", () => {
    expect(stripMarkdownForTTS("# H1\n## H2\n### H3")).toBe("H1\nH2\nH3");
  });

  it("collapses excessive newlines", () => {
    expect(stripMarkdownForTTS("Line 1\n\n\n\nLine 2")).toBe("Line 1\n\nLine 2");
  });

  it("trims leading and trailing whitespace", () => {
    expect(stripMarkdownForTTS("  Hello world  ")).toBe("Hello world");
  });

  it("handles combined markdown", () => {
    const input = "# Title\n\nThis is **bold** and *italic* with `code` and [link](url).";
    const expected = "Title\n\nThis is bold and italic with code and link.";
    expect(stripMarkdownForTTS(input)).toBe(expected);
  });
});

describe("synthesizeSpeech", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("ElevenLabs provider", () => {
    it("returns AudioResult on success", async () => {
      const fakeAudio = new ArrayBuffer(1024);
      const mockResponse = {
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(fakeAudio),
      } as unknown as Response;

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const result = await synthesizeSpeech("Hello world, this is a test.", "el-test-key", {
        provider: "elevenlabs",
        model: "eleven_multilingual_v2",
        voice: "voice123",
      });

      expect("audio" in result).toBe(true);
      const audioResult = result as { audio: ArrayBuffer; mimeType: string; filename: string };
      expect(audioResult.audio).toBe(fakeAudio);
      expect(audioResult.mimeType).toBe("audio/mpeg");
      expect(audioResult.filename).toBe("voice.mp3");

      expect(fetch).toHaveBeenCalledWith(
        "https://api.elevenlabs.io/v1/text-to-speech/voice123?output_format=mp3_44100_128",
        {
          method: "POST",
          headers: {
            "xi-api-key": "el-test-key",
            "Content-Type": "application/json",
          },
          body: expect.any(String),
        },
      );

      const callBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(callBody.text).toBe("Hello world, this is a test.");
      expect(callBody.model_id).toBe("eleven_multilingual_v2");
    });

    it("strips markdown from input text before sending", async () => {
      const fakeAudio = new ArrayBuffer(512);
      const mockResponse = {
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(fakeAudio),
      } as unknown as Response;

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      await synthesizeSpeech("This is **bold** and *italic*", "el-key", {
        provider: "elevenlabs",
        model: "eleven_multilingual_v2",
        voice: "voice123",
      });

      const callBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(callBody.text).toBe("This is bold and italic");
    });

    it("returns error on non-ok response", async () => {
      const mockResponse = {
        ok: false,
        status: 429,
        text: vi.fn().mockResolvedValue("rate limited"),
      } as unknown as Response;

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const result = await synthesizeSpeech("Hello world, testing.", "el-key", {
        provider: "elevenlabs",
        model: "eleven_multilingual_v2",
        voice: "voice123",
      });

      expect("error" in result).toBe(true);
      expect((result as { error: string }).error).toContain("TTS API error: 429");
      expect((result as { error: string }).error).toContain("rate limited");
    });
  });

  describe("Fish Audio provider", () => {
    it("returns AudioResult on success", async () => {
      const fakeAudio = new ArrayBuffer(1024);
      const mockResponse = {
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(fakeAudio),
      } as unknown as Response;

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const result = await synthesizeSpeech("Hello world, this is a test.", "fish-test-key", {
        provider: "fish",
        model: "s2-pro",
        voice: "ref456",
      });

      expect("audio" in result).toBe(true);
      const audioResult = result as { audio: ArrayBuffer; mimeType: string; filename: string };
      expect(audioResult.audio).toBe(fakeAudio);
      expect(audioResult.mimeType).toBe("audio/mpeg");
      expect(audioResult.filename).toBe("voice.mp3");

      expect(fetch).toHaveBeenCalledWith("https://api.fish.audio/v1/tts", {
        method: "POST",
        headers: {
          Authorization: "Bearer fish-test-key",
          "Content-Type": "application/json",
          model: "s2-pro",
        },
        body: expect.any(String),
      });

      const callBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(callBody.text).toBe("Hello world, this is a test.");
      expect(callBody.reference_id).toBe("ref456");
      expect(callBody.format).toBe("mp3");
    });

    it("strips markdown from input text before sending", async () => {
      const fakeAudio = new ArrayBuffer(512);
      const mockResponse = {
        ok: true,
        arrayBuffer: vi.fn().mockResolvedValue(fakeAudio),
      } as unknown as Response;

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      await synthesizeSpeech("This is **bold** and *italic*", "fish-key", {
        provider: "fish",
        model: "s2-pro",
        voice: "ref456",
      });

      const callBody = JSON.parse((fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body);
      expect(callBody.text).toBe("This is bold and italic");
    });

    it("returns error on non-ok response", async () => {
      const mockResponse = {
        ok: false,
        status: 500,
        text: vi.fn().mockResolvedValue("internal server error"),
      } as unknown as Response;

      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

      const result = await synthesizeSpeech("Hello world, testing.", "fish-key", {
        provider: "fish",
        model: "s2-pro",
        voice: "ref456",
      });

      expect("error" in result).toBe(true);
      expect((result as { error: string }).error).toContain("TTS API error: 500");
      expect((result as { error: string }).error).toContain("internal server error");
    });
  });

  it("returns error when fetch throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const result = await synthesizeSpeech("Hello world, testing.", "key", {
      provider: "elevenlabs",
      model: "eleven_multilingual_v2",
      voice: "voice123",
    });

    expect(result).toEqual({ error: "network error" });
  });

  it("returns error when stripped text is empty", async () => {
    const result = await synthesizeSpeech("```\nconsole.log('hello')\n```", "key", {
      provider: "elevenlabs",
      model: "eleven_multilingual_v2",
      voice: "voice123",
    });
    expect(result).toEqual({ error: "empty_after_strip" });
  });

  it("returns 'unknown' error for non-Error throws", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue("something went wrong"));

    const result = await synthesizeSpeech("Hello world, testing.", "key", {
      provider: "fish",
      model: "s2-pro",
      voice: "ref456",
    });

    expect(result).toEqual({ error: "unknown" });
  });
});

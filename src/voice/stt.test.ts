import { describe, it, expect, vi } from "vitest";
import { transcribeAudio, transcribeFromR2 } from "./stt";

describe("transcribeAudio", () => {
  it("returns transcript text on success", async () => {
    const mockAi = {
      run: vi.fn().mockResolvedValue({ text: "Hello world" }),
    } as unknown as Ai;

    const buffer = new ArrayBuffer(100);
    const result = await transcribeAudio(mockAi, buffer);

    expect(result).toEqual({ text: "Hello world" });
    expect(mockAi.run).toHaveBeenCalledWith(
      "@cf/openai/whisper-large-v3-turbo",
      expect.objectContaining({ audio: expect.any(Array) }),
    );
  });

  it("returns error when transcript is empty", async () => {
    const mockAi = {
      run: vi.fn().mockResolvedValue({ text: "  " }),
    } as unknown as Ai;

    const buffer = new ArrayBuffer(100);
    const result = await transcribeAudio(mockAi, buffer);

    expect(result).toEqual({ error: "empty_transcript" });
  });

  it("returns error when AI.run throws", async () => {
    const mockAi = {
      run: vi.fn().mockRejectedValue(new Error("model unavailable")),
    } as unknown as Ai;

    const buffer = new ArrayBuffer(100);
    const result = await transcribeAudio(mockAi, buffer);

    expect(result).toEqual({ error: "model unavailable" });
  });

  it("returns error when result has no text property", async () => {
    const mockAi = {
      run: vi.fn().mockResolvedValue({}),
    } as unknown as Ai;

    const buffer = new ArrayBuffer(100);
    const result = await transcribeAudio(mockAi, buffer);

    expect(result).toEqual({ error: "empty_transcript" });
  });
});

describe("transcribeFromR2", () => {
  it("reads audio from R2 and transcribes", async () => {
    const audioBuffer = new ArrayBuffer(50);
    const mockR2Object = {
      arrayBuffer: vi.fn().mockResolvedValue(audioBuffer),
    };
    const mockBucket = {
      get: vi.fn().mockResolvedValue(mockR2Object),
    } as unknown as R2Bucket;
    const mockAi = {
      run: vi.fn().mockResolvedValue({ text: "transcribed text" }),
    } as unknown as Ai;

    const ref = { id: "abc", r2Key: "media/bot1/voice.ogg", mediaType: "audio/ogg" };
    const result = await transcribeFromR2(mockAi, mockBucket, ref);

    expect(result).toEqual({ text: "transcribed text" });
    expect(mockBucket.get).toHaveBeenCalledWith("media/bot1/voice.ogg");
  });

  it("returns error when R2 object not found", async () => {
    const mockBucket = {
      get: vi.fn().mockResolvedValue(null),
    } as unknown as R2Bucket;
    const mockAi = { run: vi.fn() } as unknown as Ai;

    const ref = { id: "abc", r2Key: "media/bot1/voice.ogg", mediaType: "audio/ogg" };
    const result = await transcribeFromR2(mockAi, mockBucket, ref);

    expect(result).toEqual({ error: "audio_not_found_in_r2" });
    expect(mockAi.run).not.toHaveBeenCalled();
  });

  it("returns error when R2 bucket.get throws", async () => {
    const mockBucket = {
      get: vi.fn().mockRejectedValue(new Error("R2 service unavailable")),
    } as unknown as R2Bucket;
    const mockAi = { run: vi.fn() } as unknown as Ai;

    const ref = { id: "abc", r2Key: "media/bot1/voice.ogg", mediaType: "audio/ogg" };
    const result = await transcribeFromR2(mockAi, mockBucket, ref);

    expect(result).toEqual({ error: "R2 service unavailable" });
    expect(mockAi.run).not.toHaveBeenCalled();
  });

  it("returns error when audio exceeds max duration", async () => {
    const mockBucket = { get: vi.fn() } as unknown as R2Bucket;
    const mockAi = { run: vi.fn() } as unknown as Ai;

    const ref = { id: "abc", r2Key: "media/bot1/voice.ogg", mediaType: "audio/ogg" };
    const result = await transcribeFromR2(mockAi, mockBucket, ref, 130);

    expect(result).toEqual({ error: "audio_too_long" });
    expect(mockBucket.get).not.toHaveBeenCalled();
  });
});

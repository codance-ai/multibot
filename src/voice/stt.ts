import type { AttachmentRef } from "../channels/registry";

const STT_MODEL = "@cf/openai/whisper-large-v3-turbo";
const MAX_AUDIO_DURATION_SEC = 120;

/**
 * Transcribe audio buffer using Cloudflare Workers AI Whisper.
 */
export async function transcribeAudio(
  ai: Ai,
  audioBuffer: ArrayBuffer,
): Promise<{ text: string } | { error: string }> {
  try {
    const result = await ai.run(STT_MODEL, {
      audio: [...new Uint8Array(audioBuffer)],
    });
    const text = (result as { text?: string }).text?.trim();
    if (!text) {
      return { error: "empty_transcript" };
    }
    return { text };
  } catch (e) {
    console.error("[stt] Transcription failed:", e);
    return { error: e instanceof Error ? e.message : "unknown" };
  }
}

/**
 * Read audio from R2 and transcribe.
 * Validates duration before downloading.
 */
export async function transcribeFromR2(
  ai: Ai,
  bucket: R2Bucket,
  audioRef: AttachmentRef,
  durationSec?: number,
): Promise<{ text: string } | { error: string }> {
  if (durationSec !== undefined && durationSec > MAX_AUDIO_DURATION_SEC) {
    return { error: "audio_too_long" };
  }

  try {
    const r2Obj = await bucket.get(audioRef.r2Key);
    if (!r2Obj) {
      return { error: "audio_not_found_in_r2" };
    }

    const buffer = await r2Obj.arrayBuffer();
    return transcribeAudio(ai, buffer);
  } catch (e) {
    console.error("[stt] R2 read failed:", e);
    return { error: e instanceof Error ? e.message : "r2_read_error" };
  }
}

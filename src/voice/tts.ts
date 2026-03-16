const MAX_TTS_LENGTH = 4096;

export interface TTSContext {
  isVoiceMessage: boolean;
  sttFailed?: boolean;
}

export interface AudioResult {
  audio: ArrayBuffer;
  mimeType: string;
  filename: string;
}

/**
 * Determine whether to synthesize speech for this reply.
 */
export function shouldSynthesize(
  text: string,
  voiceMode: "off" | "always" | "mirror",
  ctx: TTSContext,
): boolean {
  if (voiceMode === "off") return false;
  if (voiceMode === "mirror") {
    if (!ctx.isVoiceMessage) return false;
    if (ctx.sttFailed) return false;
  }
  if (text.length > MAX_TTS_LENGTH) return false;
  return true;
}

/**
 * Strip markdown formatting for speech-friendly plain text.
 */
export function stripMarkdownForTTS(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, "") // code blocks
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // links
    .replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1") // bold/italic
    .replace(/_{1,3}([^_]+)_{1,3}/g, "$1") // bold/italic underscores
    .replace(/^#{1,6}\s+/gm, "") // headings
    .replace(/\n{3,}/g, "\n\n") // collapse newlines
    .trim();
}

/**
 * Synthesize speech using ElevenLabs or Fish Audio.
 * Returns MP3 audio.
 */
export async function synthesizeSpeech(
  text: string,
  apiKey: string,
  config: { provider: "elevenlabs" | "fish"; model: string; voice: string },
): Promise<AudioResult | { error: string }> {
  try {
    const plainText = stripMarkdownForTTS(text);
    if (!plainText) {
      return { error: "empty_after_strip" };
    }

    let res: Response;

    if (config.provider === "elevenlabs") {
      res = await fetch(
        `https://api.elevenlabs.io/v1/text-to-speech/${config.voice}?output_format=mp3_44100_128`,
        {
          method: "POST",
          headers: {
            "xi-api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: plainText,
            model_id: config.model,
          }),
        },
      );
    } else {
      res = await fetch("https://api.fish.audio/v1/tts", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          model: config.model,
        },
        body: JSON.stringify({
          text: plainText,
          reference_id: config.voice,
          format: "mp3",
        }),
      });
    }

    if (!res.ok) {
      const body = await res.text();
      console.error(`[tts] ${config.provider} TTS failed:`, res.status, body);
      return { error: `TTS API error: ${res.status} ${body.slice(0, 200)}` };
    }

    const audio = await res.arrayBuffer();
    return { audio, mimeType: "audio/mpeg", filename: "voice.mp3" };
  } catch (e) {
    console.error("[tts] TTS synthesis failed:", e);
    return { error: e instanceof Error ? e.message : "unknown" };
  }
}

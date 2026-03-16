import type { SenderOptions, SendAudioOptions, MediaItem } from "../channels/registry";
import { shouldSynthesize, synthesizeSpeech } from "./tts";
import type { BotConfig } from "../config/schema";

export interface TtsPolicy {
  ttsProvider: "elevenlabs" | "fish";
  voiceMode: "off" | "always" | "mirror";
  ttsVoice: string;
  ttsModel: string;
  apiKey: string | undefined;
}

export interface SendReplyParams {
  text: string;
  media?: MediaItem[];
  channelToken: string;
  chatId: string;
  ttsPolicy: TtsPolicy;
  isVoiceMessage: boolean;
  sttFailed?: boolean;
  senderOptions?: SenderOptions;
}

/** Adapter methods injected for testability */
export interface SendReplyAdapterFns {
  sendMessage: (token: string, chatId: string, text: string, options?: SenderOptions) => Promise<void>;
  sendAudio?: (token: string, chatId: string, audio: ArrayBuffer, options?: SendAudioOptions) => Promise<{ captionSent: boolean }>;
}

/**
 * Build TtsPolicy from BotConfig + UserKeys.
 * Keeps the sendFinalReply interface lean.
 */
export function buildTtsPolicy(botConfig: BotConfig, userKeys: { elevenlabs?: string; fish?: string }): TtsPolicy {
  const provider = botConfig.ttsProvider ?? "fish";
  return {
    ttsProvider: provider,
    voiceMode: botConfig.voiceMode ?? "off",
    ttsVoice: botConfig.ttsVoice ?? "",
    ttsModel: botConfig.ttsModel ?? "s2-pro",
    apiKey: provider === "elevenlabs" ? userKeys.elevenlabs : userKeys.fish,
  };
}

export interface SendReplyResult {
  voiceSent: boolean;
}

/**
 * Unified reply sender. Voice-first: TTS success → voice with caption only.
 * Fallback to text on TTS failure or when TTS is disabled.
 */
export async function sendFinalReply(
  params: SendReplyParams,
  adapter: SendReplyAdapterFns,
): Promise<SendReplyResult> {
  const { text, media, channelToken, chatId, ttsPolicy, senderOptions } = params;

  const doSynthesize = shouldSynthesize(text, ttsPolicy.voiceMode, {
    isVoiceMessage: params.isVoiceMessage,
    sttFailed: params.sttFailed,
  }) && !!ttsPolicy.apiKey && !!adapter.sendAudio;

  if (doSynthesize) {
    const result = await synthesizeSpeech(text, ttsPolicy.apiKey!, {
      provider: ttsPolicy.ttsProvider,
      model: ttsPolicy.ttsModel,
      voice: ttsPolicy.ttsVoice,
    });

    if ("audio" in result) {
      try {
        const audioOpts: SendAudioOptions = { ...senderOptions, caption: text };
        const { captionSent } = await adapter.sendAudio!(channelToken, chatId, result.audio, audioOpts);
        if (!captionSent) {
          // Caption too long — send text (+ media if any) together
          const fallbackOpts: SenderOptions = {
            ...senderOptions,
            ...(media && media.length > 0 && { media }),
          };
          await adapter.sendMessage(channelToken, chatId, text, fallbackOpts);
        } else if (media && media.length > 0) {
          // Caption sent with audio — send media separately
          await adapter.sendMessage(channelToken, chatId, "", { ...senderOptions, media });
        }
        return { voiceSent: true };
      } catch (e) {
        console.warn("[voice] sendAudio failed, falling back to text:", e);
      }
    } else {
      console.warn("[voice] TTS synthesis failed, falling back to text:", result.error);
    }
  }

  // Fallback: send text + media via sendMessage
  const messageOptions: SenderOptions = {
    ...senderOptions,
    ...(media && media.length > 0 && { media }),
  };
  await adapter.sendMessage(channelToken, chatId, text, messageOptions);
  return { voiceSent: false };
}

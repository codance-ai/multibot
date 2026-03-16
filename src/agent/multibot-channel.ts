import { getAdapter } from "../channels/registry";
import type { SenderOptions, SendAudioOptions } from "../channels/registry";
import { createLogger } from "../utils/logger";

export function startTypingLoop(
  channel: string,
  token: string,
  chatId: string,
  signal: AbortSignal,
  deadline?: number,
): void {
  const adapter = getAdapter(channel);
  if (!adapter) return;
  const loop = async () => {
    while (!signal.aborted) {
      if (deadline && Date.now() > deadline) break;
      await adapter.sendTyping(token, chatId).catch((e) => console.warn("[typing] sendTyping failed:", e));
      await new Promise((r) => setTimeout(r, 4000));
    }
  };
  loop(); // fire-and-forget, controlled by AbortController
}

export async function sendChannelMessage(
  channel: string,
  channelToken: string,
  chatId: string,
  text: string,
  options?: SenderOptions,
): Promise<void> {
  const adapter = getAdapter(channel);
  if (adapter) {
    await adapter.sendMessage(channelToken, chatId, text, options);
  } else {
    createLogger({ channel }).error("Unsupported channel");
  }
}

export async function sendChannelAudio(
  channel: string,
  channelToken: string,
  chatId: string,
  audio: ArrayBuffer,
  options?: SendAudioOptions,
): Promise<{ captionSent: boolean }> {
  const adapter = getAdapter(channel);
  if (adapter?.sendAudio) {
    return adapter.sendAudio(channelToken, chatId, audio, options);
  }
  createLogger({ channel }).error("Audio sending not supported on channel");
  throw new Error(`Audio sending not supported for channel: ${channel}`);
}

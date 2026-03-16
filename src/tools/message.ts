import type { SenderOptions } from "../channels/registry";

export type ChannelSender = (
  channel: string,
  channelToken: string,
  chatId: string,
  text: string,
  options?: SenderOptions,
) => Promise<void>;

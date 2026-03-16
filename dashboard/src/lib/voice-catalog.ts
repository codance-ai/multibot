export interface VoiceOption {
  id: string;
  label: string;
  gender: "female" | "male";
}

export interface ModelOption {
  id: string;
  label: string;
}

export interface ProviderConfig {
  label: string;
  defaultVoice: string;
  defaultModel: string;
  models: ModelOption[];
  voices: VoiceOption[];
  /** Allow custom voice ID in addition to presets */
  allowCustomVoice?: boolean;
  /** URL for browsing more voices */
  voiceLibraryUrl?: string;
  keyName: string;
}

export const CUSTOM_VOICE_ID = "__custom__";

export const TTS_PROVIDERS: Record<"elevenlabs" | "fish", ProviderConfig> = {
  elevenlabs: {
    label: "ElevenLabs",
    defaultVoice: "21m00Tcm4TlvDq8ikWAM",
    defaultModel: "eleven_multilingual_v2",
    keyName: "elevenlabs",
    models: [
      { id: "eleven_multilingual_v2", label: "Multilingual v2 (Best quality)" },
      { id: "eleven_turbo_v2_5", label: "Turbo v2.5 (Low latency)" },
      { id: "eleven_flash_v2_5", label: "Flash v2.5 (Fastest)" },
    ],
    voices: [
      // Female
      { id: "21m00Tcm4TlvDq8ikWAM", label: "Rachel", gender: "female" },
      { id: "EXAVITQu4vr4xnSDxMaL", label: "Sarah", gender: "female" },
      { id: "XB0fDUnXU5powFXDhCwa", label: "Charlotte", gender: "female" },
      { id: "XrExE9yKIg1WjnnlVkGX", label: "Matilda", gender: "female" },
      { id: "pFZP5JQG7iQjIQuC4Bku", label: "Lily", gender: "female" },
      { id: "Xb7hH8MSUJpSbSDYk0k2", label: "Alice", gender: "female" },
      // Male
      { id: "nPczCjzI2devNBz1zQrb", label: "Brian", gender: "male" },
      { id: "onwK4e9ZLuTAKqWW03F9", label: "Daniel", gender: "male" },
      { id: "TxGEqnHWrfWFTfGW9XjX", label: "Josh", gender: "male" },
      { id: "JBFqnCBsd6RMkjVDRZzb", label: "George", gender: "male" },
      { id: "ErXwobaYiN019PkySvjV", label: "Antoni", gender: "male" },
      { id: "iP95p4xoKVk53GoZ742B", label: "Chris", gender: "male" },
    ],
  },
  fish: {
    label: "Fish Audio",
    defaultVoice: "b347db033a6549378b48d00acb0d06cd",
    defaultModel: "s2-pro",
    keyName: "fish",
    allowCustomVoice: true,
    voiceLibraryUrl: "https://fish.audio/discovery/",
    models: [
      { id: "s2-pro", label: "S2 Pro (80+ languages)" },
    ],
    voices: [
      // Female
      { id: "b347db033a6549378b48d00acb0d06cd", label: "Selene", gender: "female" },
      { id: "933563129e564b19a115bedd57b7406a", label: "Sarah", gender: "female" },
      { id: "e3cd384158934cc9a01029cd7d278634", label: "Laura", gender: "female" },
      { id: "fbe02f8306fc4d3d915e9871722a39d5", label: "Jialan", gender: "female" },
      // Male
      { id: "bf322df2096a46f18c579d0baa36f41d", label: "Adrian", gender: "male" },
      { id: "536d3a5e000945adb7038665781a4aca", label: "Ethan", gender: "male" },
      { id: "79d0bd3e4e5444b18f7b6d89b5927bf1", label: "Jordan", gender: "male" },
      { id: "54a5170264694bfc8e9ad98df7bd89c3", label: "Dingzhen", gender: "male" },
    ],
  },
};

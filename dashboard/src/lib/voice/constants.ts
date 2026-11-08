/** Build-time STT path (spike runner updates after Phase 0 gate). */
export const VOICE_STT_MODE = "server_stt" as const;

export type VoiceSttMode = typeof VOICE_STT_MODE | "server_stt";

export const VOICE_CAPTURE_RATE = 16_000;
export const VOICE_PLAYBACK_RATE = 24_000;
export const VOICE_DEFAULT_VOICE = "juno";
export const VOICE_DEFAULT_STT = "shruti-en";
export const VOICE_TAMIL_STT = "shruti-tamil";

/** Sustained speech energy before barge-in fires (spec 173 §F). */
export const BARGE_IN_MS = 250;

export const PREP_STEP_LABELS: Record<string, string> = {
  tts: "Text-to-speech engine",
  stt: "Speech recognition",
  vad: "Voice activity detector",
  audio: "Opening audio channel",
};

export const PREP_STEPS = ["tts", "stt", "vad", "audio"] as const;

/** Bounds every network/model/mic step in the activation chain (spec 174). */
export const VOICE_WS_OPEN_TIMEOUT_MS = 15_000;
export const VOICE_CLIENT_STT_TIMEOUT_MS = 120_000;
export const VOICE_CAPTURE_TIMEOUT_MS = 30_000;

import { getToken } from "@/lib/api";
import { VOICE_DEFAULT_STT } from "@/lib/voice/constants";
import { sttModelAssetName } from "@/lib/voice/sttModels";

/** Same-origin API root for model fetch (no trailing slash). */
export function voiceApiBase(origin?: string): string {
  if (origin) return origin.replace(/\/$/, "");
  if (typeof window !== "undefined") return window.location.origin;
  return "http://127.0.0.1";
}

export function shrutiModelUrl(base?: string, sttModel: string = VOICE_DEFAULT_STT): string {
  const name = sttModelAssetName(sttModel);
  return `${voiceApiBase(base)}/api/voice/model/${name}`;
}

export type VoiceWsUrlParts = {
  protocol?: "ws:" | "wss:";
  host?: string;
  token?: string;
};

/** Authenticated `/ws/voice` upgrade URL (spec 173 §A). */
export function buildVoiceWsUrl(parts: VoiceWsUrlParts = {}): string {
  const protocol =
    parts.protocol ??
    (typeof window !== "undefined" && window.location.protocol === "https:" ? "wss:" : "ws:");
  const host = parts.host ?? (typeof window !== "undefined" ? window.location.host : "127.0.0.1");
  const token = parts.token ?? getToken();
  const q = token ? `?token=${encodeURIComponent(token)}` : "";
  return `${protocol}//${host}/ws/voice${q}`;
}

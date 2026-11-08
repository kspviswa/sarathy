import { VOICE_DEFAULT_STT, VOICE_TAMIL_STT } from "@/lib/voice/constants";

/** Logical model ids → on-disk asset basename (spec 174 §N1). */
const STT_ASSETS: Record<string, string> = {
  [VOICE_DEFAULT_STT]: "shruti.cact",
  [VOICE_TAMIL_STT]: "shruti-tamil.cact",
};

export function normalizeSttModelId(value: string | undefined): string {
  const raw = (value ?? "").trim();
  if (raw in STT_ASSETS) return raw;
  return VOICE_DEFAULT_STT;
}

export function sttModelAssetName(modelId: string): string {
  const id = normalizeSttModelId(modelId);
  const file = STT_ASSETS[id];
  // Server falls back to tamil weights with an English language hint when shruti.cact is absent.
  return file ?? "shruti.cact";
}

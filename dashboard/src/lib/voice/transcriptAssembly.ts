/**
 * Live voice transcript from `partial` frames (spec 173 §E).
 *
 * Phrase commitment: each `is_final` partial appends; the open partial is the
 * in-flight phrase while the user is still speaking.
 */

export interface VoicePartial {
  text: string;
  is_final?: boolean;
}

export function commitPartial(
  committed: readonly string[],
  partial: VoicePartial,
): { committed: string[]; current: string } {
  const t = partial.text.trim();
  if (partial.is_final && t) {
    return { committed: [...committed, t], current: "" };
  }
  return { committed: [...committed], current: partial.text };
}

export function assembleVoiceTranscript(
  committed: readonly string[],
  currentPartial: string,
  trailing = "",
): string {
  return [...committed, currentPartial, trailing].map((s) => s.trim()).filter(Boolean).join(" ");
}

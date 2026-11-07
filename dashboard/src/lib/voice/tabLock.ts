export type VoiceNavPhase = "idle" | "preparing" | "live" | "ending";

export function isVoiceNavLocked(phase: VoiceNavPhase): boolean {
  return phase === "preparing" || phase === "live";
}

export type NavAttemptHandler = (targetSection: string) => boolean;

/**
 * Returns true when navigation may proceed. While locked, only `voice` is
 * allowed — the caller shows the shake + hint.
 */
export function attemptVoiceAwareNav(
  phase: VoiceNavPhase,
  targetSection: string,
): boolean {
  if (!isVoiceNavLocked(phase)) return true;
  return targetSection === "voice";
}

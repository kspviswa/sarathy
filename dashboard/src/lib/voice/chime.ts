/** Rising two-note chime on `ready` — WebAudio only, no assets (spec 173 §C). */
export async function playVoiceReadyChime(ctx: AudioContext): Promise<void> {
  const t0 = ctx.currentTime;
  const gain = ctx.createGain();
  gain.connect(ctx.destination);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.45);

  const playTone = (freq: number, start: number, dur: number) => {
    const osc = ctx.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(freq, start);
    osc.connect(gain);
    osc.start(start);
    osc.stop(start + dur);
  };

  playTone(523.25, t0, 0.18);
  playTone(659.25, t0 + 0.14, 0.22);
  await new Promise<void>((resolve) => {
    window.setTimeout(resolve, 480);
  });
}

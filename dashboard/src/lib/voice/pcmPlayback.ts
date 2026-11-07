import { VOICE_PLAYBACK_RATE } from "@/lib/voice/constants";

/**
 * Gapless PCM playback at 24 kHz mono Int16 (spec 173 §A).
 */
export class PcmPlaybackScheduler {
  private ctx: AudioContext;
  private cursor = 0;
  private sources = new Set<AudioBufferSourceNode>();
  private playing = false;

  constructor(ctx: AudioContext) {
    this.ctx = ctx;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  enqueueInt16(pcm: ArrayBuffer): void {
    const samples = new Int16Array(pcm);
    if (samples.length === 0) return;
    const floats = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      floats[i] = samples[i]! / 32768;
    }
    const buffer = this.ctx.createBuffer(1, floats.length, VOICE_PLAYBACK_RATE);
    buffer.copyToChannel(floats, 0);

    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.ctx.destination);
    const startAt = Math.max(this.ctx.currentTime, this.cursor);
    src.start(startAt);
    this.cursor = startAt + buffer.duration;
    this.playing = true;
    this.sources.add(src);
    src.onended = () => {
      this.sources.delete(src);
      if (this.sources.size === 0) {
        this.playing = false;
        this.cursor = this.ctx.currentTime;
      }
    };
  }

  stopAll(): void {
    for (const src of this.sources) {
      try {
        src.stop();
      } catch {
        /* already ended */
      }
    }
    this.sources.clear();
    this.playing = false;
    this.cursor = this.ctx.currentTime;
  }
}

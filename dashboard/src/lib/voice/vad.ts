import { BARGE_IN_MS } from "@/lib/voice/constants";

/**
 * Energy-based VAD (interim until Silero ONNX bundles cleanly).
 *
 * TODO(spec 173): replace with Silero VAD via onnxruntime-web when model size
 * and worker CSP are verified in production builds.
 */

export type VadSpeechEvent = "speech_start" | "speech_end";

export interface EnergyVadOptions {
  /** RMS threshold for speech onset (0–1). */
  speechThreshold?: number;
  /** Ms of silence before `speech_end`. */
  endSilenceMs?: number;
  /** Ms of sustained energy during playback for barge-in. */
  bargeInMs?: number;
  bargeThreshold?: number;
  frameMs?: number;
  now?: () => number;
}

const DEFAULTS: Required<EnergyVadOptions> = {
  speechThreshold: 0.012,
  endSilenceMs: 350,
  bargeInMs: BARGE_IN_MS,
  bargeThreshold: 0.018,
  frameMs: 20,
  now: () => performance.now(),
};

export class EnergyVad {
  private opts: Required<EnergyVadOptions>;
  private speaking = false;
  private silenceMs = 0;
  private bargeMs = 0;
  private onSpeech?: (ev: VadSpeechEvent, ts: number) => void;
  private onBargeIn?: (ts: number) => void;

  constructor(options: EnergyVadOptions = {}) {
    this.opts = { ...DEFAULTS, ...options };
  }

  setHandlers(handlers: {
    onSpeech?: (ev: VadSpeechEvent, ts: number) => void;
    onBargeIn?: (ts: number) => void;
  }): void {
    this.onSpeech = handlers.onSpeech;
    this.onBargeIn = handlers.onBargeIn;
  }

  reset(): void {
    this.speaking = false;
    this.silenceMs = 0;
    this.bargeMs = 0;
  }

  /** Process one RMS frame (0–1) from the capture analyser. */
  processRms(rms: number, playbackActive: boolean): void {
    const ts = Math.round(this.opts.now());
    const frameMs = this.opts.frameMs;

    if (playbackActive) {
      if (rms >= this.opts.bargeThreshold) {
        this.bargeMs += frameMs;
        if (this.bargeMs >= this.opts.bargeInMs) {
          this.bargeMs = 0;
          this.onBargeIn?.(ts);
        }
      } else {
        this.bargeMs = 0;
      }
    } else {
      this.bargeMs = 0;
    }

    if (!this.speaking) {
      if (rms >= this.opts.speechThreshold) {
        this.speaking = true;
        this.silenceMs = 0;
        this.onSpeech?.("speech_start", ts);
      }
      return;
    }

    if (rms < this.opts.speechThreshold) {
      this.silenceMs += frameMs;
      if (this.silenceMs >= this.opts.endSilenceMs) {
        this.speaking = false;
        this.silenceMs = 0;
        this.onSpeech?.("speech_end", ts);
      }
    } else {
      this.silenceMs = 0;
    }
  }
}

/** RMS of a float32 mono buffer. */
export function bufferRms(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i]!;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

import { VOICE_CAPTURE_RATE } from "@/lib/voice/constants";

export type CaptureHandlers = {
  onPcm?: (pcm: Int16Array) => void;
  onRms?: (rms: number) => void;
};

declare global {
  interface Navigator {
    audioSession?: { type: string };
  }
}

export function setIosPlayAndRecord(enabled: boolean): void {
  if (navigator.audioSession) {
    navigator.audioSession.type = enabled ? "play-and-record" : "auto";
  }
}

/**
 * Mic capture via `AudioWorklet` → 16 kHz Int16 (spec 173 §D).
 */
export class VoiceCapture {
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private analyser: AnalyserNode | null = null;
  private worklet: AudioWorkletNode | null = null;
  private handlers: CaptureHandlers = {};
  private raf = 0;

  get audioContext(): AudioContext | null {
    return this.ctx;
  }

  get waveformAnalyser(): AnalyserNode | null {
    return this.analyser;
  }

  setHandlers(handlers: CaptureHandlers): void {
    this.handlers = handlers;
  }

  async start(): Promise<AudioContext> {
    if (this.ctx) return this.ctx;

    setIosPlayAndRecord(true);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    this.stream = stream;

    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.resume();

    const source = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    this.analyser = analyser;

    const workletUrl = new URL("voice-capture-processor.js", window.location.href).href;
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, "voice-capture-processor");
    source.connect(node);
    node.port.onmessage = (ev: MessageEvent<{ pcm?: ArrayBuffer; rms?: number }>) => {
      if (typeof ev.data.rms === "number") {
        this.handlers.onRms?.(ev.data.rms);
      }
      if (ev.data.pcm) {
        this.handlers.onPcm?.(new Int16Array(ev.data.pcm));
      }
    };
    this.worklet = node;
    return ctx;
  }

  startWaveformLoop(onLevel: (level: number) => void): void {
    const tick = () => {
      const an = this.analyser;
      if (an) {
        const data = new Uint8Array(an.frequencyBinCount);
        an.getByteTimeDomainData(data);
        let peak = 0;
        for (let i = 0; i < data.length; i += 1) {
          const v = (data[i]! - 128) / 128;
          peak = Math.max(peak, Math.abs(v));
        }
        onLevel(peak);
      }
      this.raf = requestAnimationFrame(tick);
    };
    cancelAnimationFrame(this.raf);
    this.raf = requestAnimationFrame(tick);
  }

  stopWaveformLoop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  async stop(): Promise<void> {
    this.stopWaveformLoop();
    this.worklet?.disconnect();
    this.worklet = null;
    this.analyser = null;
    if (this.stream) {
      for (const t of this.stream.getTracks()) t.stop();
    }
    this.stream = null;
    if (this.ctx) {
      await this.ctx.close().catch(() => undefined);
    }
    this.ctx = null;
    setIosPlayAndRecord(false);
  }

  static captureRate(): number {
    return VOICE_CAPTURE_RATE;
  }
}

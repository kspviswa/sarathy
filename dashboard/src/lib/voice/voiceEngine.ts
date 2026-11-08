import {
  VOICE_CAPTURE_TIMEOUT_MS,
  VOICE_CLIENT_STT_TIMEOUT_MS,
  VOICE_DEFAULT_STT,
  VOICE_DEFAULT_VOICE,
  VOICE_STT_MODE,
  VOICE_WS_OPEN_TIMEOUT_MS,
  type VoiceSttMode,
} from "@/lib/voice/constants";
import { playVoiceReadyChime } from "@/lib/voice/chime";
import { VoiceCapture } from "@/lib/voice/capture";
import { PcmPlaybackScheduler } from "@/lib/voice/pcmPlayback";
import { commitPartial } from "@/lib/voice/transcriptAssembly";
import { EnergyVad } from "@/lib/voice/vad";
import { VoiceSocket } from "@/lib/voice/voiceSocket";
import { shrutiModelUrl } from "@/lib/voice/urls";

export type VoiceUiPhase = "idle" | "preparing" | "live" | "ending";

export type PrepStepStatus = "pending" | "running" | "done" | "failed";

export type VoiceEngineCallbacks = {
  onPhase?: (phase: VoiceUiPhase) => void;
  onPrep?: (step: string, status: PrepStepStatus, ms?: number) => void;
  onTranscript?: (text: string) => void;
  onAnswer?: (delta: string) => void;
  onSessionState?: (state: string) => void;
  onTool?: (name: string, hint: string) => void;
  onSpeakingLine?: (seq: number) => void;
  onTurnDone?: () => void;
  onError?: (message: string) => void;
  onReady?: () => void;
};

type WhistleLike = {
  transcribe: (audio: Float32Array, opts: { sampleRate: number }) => Promise<{ text?: string }>;
};

function resolveSttMode(): VoiceSttMode {
  const env = import.meta.env.VITE_SPIKE_MODE as string | undefined;
  if (env === "server_stt") return "server_stt";
  if (env === "client_stt") return "client_stt";
  return VOICE_STT_MODE;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Orchestrates socket, capture, playback, and client/server STT (spec 173).
 */
export class VoiceEngine {
  private socket = new VoiceSocket();
  private capture = new VoiceCapture();
  private playback: PcmPlaybackScheduler | null = null;
  private vad = new EnergyVad();
  private callbacks: VoiceEngineCallbacks = {};
  private phase: VoiceUiPhase = "idle";
  private committed: string[] = [];
  private currentPartial = "";
  private utterancePcm: Int16Array[] = [];
  private whistle: WhistleLike | null = null;
  private sttMode = resolveSttMode();
  private unsub: (() => void)[] = [];

  get navPhase(): VoiceUiPhase {
    return this.phase;
  }

  get sttModeName(): VoiceSttMode {
    return this.sttMode;
  }

  setCallbacks(cb: VoiceEngineCallbacks): void {
    this.callbacks = cb;
  }

  private setPhase(next: VoiceUiPhase): void {
    this.phase = next;
    this.callbacks.onPhase?.(next);
  }

  private pushTranscript(): void {
    const text = [...this.committed, this.currentPartial].filter(Boolean).join(" ").trim();
    this.callbacks.onTranscript?.(text);
  }

  private wireSocket(): void {
    this.unsub.push(
      this.socket.onJson((frame) => {
        const t = frame.type;
        if (t === "prep") {
          const step = String(frame.step ?? "");
          const status = String(frame.status ?? "running") as PrepStepStatus;
          const ms = typeof frame.ms === "number" ? frame.ms : undefined;
          this.callbacks.onPrep?.(step, status, ms);
          return;
        }
        if (t === "ready") {
          void this.onReady().catch((e) => {
            // Without this the rejection vanished (onReady was fire-and-forget)
            // and the UI sat on "Preparing voice session…" indefinitely.
            this.callbacks.onError?.(e instanceof Error ? e.message : String(e));
            void this.teardown();
          });
          return;
        }
        if (t === "partial") {
          const partial = {
            text: String(frame.text ?? ""),
            is_final: Boolean(frame.is_final),
          };
          const next = commitPartial(this.committed, partial);
          this.committed = next.committed;
          this.currentPartial = next.current;
          this.pushTranscript();
          return;
        }
        if (t === "text") {
          this.callbacks.onAnswer?.(String(frame.delta ?? ""));
          return;
        }
        if (t === "state") {
          this.callbacks.onSessionState?.(String(frame.state ?? ""));
          return;
        }
        if (t === "tool") {
          this.callbacks.onTool?.(
            String(frame.name ?? "tool"),
            String(frame.hint ?? ""),
          );
          return;
        }
        if (t === "sentence_end") {
          const seq = typeof frame.seq === "number" ? frame.seq : 0;
          this.callbacks.onSpeakingLine?.(seq);
          return;
        }
        if (t === "done") {
          this.callbacks.onTurnDone?.();
          return;
        }
        if (t === "error") {
          this.callbacks.onError?.(String(frame.message ?? "Voice error"));
          if (this.phase === "preparing") {
            void this.teardown();
          }
        }
        if (t === "ended") {
          void this.teardown();
        }
      }),
    );

    this.unsub.push(
      this.socket.onBinary((pcm) => {
        if (this.playback) this.playback.enqueueInt16(pcm);
      }),
    );
  }

  private async loadClientStt(): Promise<void> {
    if (this.sttMode !== "client_stt") {
      return;
    }
    const { createWhistle } = await import("cactus-needle/browser");
    this.whistle = await createWhistle({
      model: shrutiModelUrl(),
      onDownloadProgress: () => {
        /* prep frames come from the server for tts/stt */
      },
    });
  }

  private waitForSocketOpen(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const off = this.socket.onOpen(() => {
        if (timer !== undefined) clearTimeout(timer);
        off();
        resolve();
      });
      timer = setTimeout(() => {
        off();
        reject(new Error(`WebSocket open timed out after ${timeoutMs}ms`));
      }, timeoutMs);
    });
  }

  private async onReady(): Promise<void> {
    const ctx = await withTimeout(
      this.capture.start(),
      VOICE_CAPTURE_TIMEOUT_MS,
      "Microphone setup",
    );
    this.playback = new PcmPlaybackScheduler(ctx);
    this.callbacks.onReady?.();
    await playVoiceReadyChime(ctx);
    this.setPhase("live");

    this.vad.setHandlers({
      onSpeech: (ev, ts) => {
        if (ev === "speech_start") {
          this.socket.sendJson({ type: "speech_start", ts });
          if (this.playback?.isPlaying) {
            this.playback.stopAll();
            this.socket.sendJson({ type: "stop_turn" });
          }
        } else {
          this.socket.sendJson({ type: "speech_end", ts });
          void this.finalizeUtterance();
        }
      },
      onBargeIn: (ts) => {
        this.playback?.stopAll();
        this.socket.sendJson({ type: "speech_start", ts });
        this.socket.sendJson({ type: "stop_turn" });
      },
    });

    this.capture.setHandlers({
      onPcm: (pcm) => {
        this.utterancePcm.push(pcm);
        if (this.sttMode === "server_stt") {
          this.socket.sendPcm(pcm);
        }
      },
      onRms: (rms) => {
        this.vad.processRms(rms, Boolean(this.playback?.isPlaying));
      },
    });
  }

  private pcmToFloat(chunks: Int16Array[]): Float32Array {
    let len = 0;
    for (const c of chunks) len += c.length;
    const out = new Float32Array(len);
    let off = 0;
    for (const c of chunks) {
      for (let i = 0; i < c.length; i += 1) {
        out[off++] = c[i]! / 32768;
      }
    }
    return out;
  }

  private async finalizeUtterance(): Promise<void> {
    if (this.sttMode === "server_stt") {
      this.utterancePcm = [];
      return;
    }
    if (!this.whistle || this.utterancePcm.length === 0) {
      this.utterancePcm = [];
      return;
    }
    const audio = this.pcmToFloat(this.utterancePcm);
    this.utterancePcm = [];
    try {
      const result = await this.whistle.transcribe(audio, { sampleRate: VoiceCapture.captureRate() });
      const text = (result?.text ?? "").trim();
      if (!text) return;
      const phrase = { text, is_final: true };
      const next = commitPartial(this.committed, phrase);
      this.committed = next.committed;
      this.currentPartial = next.current;
      this.pushTranscript();
      this.socket.sendJson({ type: "partial", text, is_final: true });
      this.socket.sendJson({ type: "utterance", text, lang: "mixed" });
    } catch (e) {
      this.callbacks.onError?.(e instanceof Error ? e.message : String(e));
    }
  }

  async activate(): Promise<void> {
    if (this.phase !== "idle") return;
    this.setPhase("preparing");
    this.committed = [];
    this.currentPartial = "";
    this.wireSocket();
    this.socket.connect();

    try {
      await this.waitForSocketOpen(VOICE_WS_OPEN_TIMEOUT_MS);
      await withTimeout(
        this.loadClientStt(),
        VOICE_CLIENT_STT_TIMEOUT_MS,
        "Speech model",
      );

      this.socket.sendJson({
        type: "start",
        voice: VOICE_DEFAULT_VOICE,
        stt: VOICE_DEFAULT_STT,
        mode: this.sttMode,
        stt_mode: this.sttMode,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.callbacks.onError?.(msg);
      await this.teardown();
      throw e;
    }
  }

  async cancel(): Promise<void> {
    if (this.phase === "idle") return;
    this.socket.sendJson({ type: "cancel", reason: "user" });
    await this.teardown();
  }

  async endSession(): Promise<void> {
    if (this.phase !== "live") return;
    this.setPhase("ending");
    this.socket.sendJson({ type: "cancel", reason: "end_session" });
    await this.teardown();
  }

  async teardown(): Promise<void> {
    for (const u of this.unsub) u();
    this.unsub = [];
    this.whistle = null;
    this.playback?.stopAll();
    this.playback = null;
    await this.capture.stop();
    this.socket.disconnect();
    this.vad.reset();
    this.utterancePcm = [];
    this.setPhase("idle");
  }
}

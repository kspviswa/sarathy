import { getToken } from "@/lib/api";
import { buildVoiceWsUrl } from "@/lib/voice/urls";

export type VoiceControlOutbound =
  | { type: "hello" }
  | { type: "start"; voice?: string; stt?: string; mode?: string; stt_mode?: string }
  | { type: "cancel"; reason?: string }
  | { type: "speech_start"; ts?: number }
  | { type: "speech_end"; ts?: number }
  | { type: "partial"; text: string; is_final?: boolean }
  | { type: "stop_turn" };

export type VoiceJsonInbound = {
  type: string;
} & Record<string, unknown>;

type JsonHandler = (frame: VoiceJsonInbound) => void;
type BinaryHandler = (pcm: ArrayBuffer) => void;
type OpenHandler = () => void;

/**
 * Duplex `/ws/voice` — JSON control + binary PCM (spec 173 §A).
 */
export class VoiceSocket {
  private ws: WebSocket | null = null;
  private jsonHandlers = new Set<JsonHandler>();
  private binaryHandlers = new Set<BinaryHandler>();
  private openHandlers = new Set<OpenHandler>();
  private closed = false;

  connect(url?: string): void {
    this.closed = false;
    const target = url ?? buildVoiceWsUrl({ token: getToken() });
    const ws = new WebSocket(target);
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      this.openHandlers.forEach((h) => h());
      this.sendJson({ type: "hello" });
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === "string") {
        try {
          const frame = JSON.parse(ev.data) as VoiceJsonInbound;
          this.jsonHandlers.forEach((h) => h(frame));
        } catch {
          /* ignore */
        }
        return;
      }
      if (ev.data instanceof ArrayBuffer) {
        this.binaryHandlers.forEach((h) => h(ev.data));
      }
    };

    ws.onclose = () => {
      this.ws = null;
    };
  }

  disconnect(): void {
    this.closed = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }

  get ready(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  sendJson(frame: VoiceControlOutbound | VoiceJsonInbound): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify(frame));
  }

  sendPcm(pcm: ArrayBuffer | Int16Array): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    const buf = pcm instanceof Int16Array ? pcm.buffer.slice(pcm.byteOffset, pcm.byteOffset + pcm.byteLength) : pcm;
    this.ws.send(buf);
  }

  onJson(handler: JsonHandler): () => void {
    this.jsonHandlers.add(handler);
    return () => this.jsonHandlers.delete(handler);
  }

  onBinary(handler: BinaryHandler): () => void {
    this.binaryHandlers.add(handler);
    return () => this.binaryHandlers.delete(handler);
  }

  onOpen(handler: OpenHandler): () => void {
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }
}

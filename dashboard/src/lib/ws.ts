import { getToken } from "./api";
import { WS_OPEN_EVENT } from "./events";
import type { OutboundMessage } from "./types";

export { WS_OPEN_EVENT } from "./events";

type MessageHandler = (msg: OutboundMessage) => void;

export interface NotificationFrame {
  type: "notification";
  payload: {
    title: string;
    body?: string;
    tab?: string;
    timestamp?: string;
  };
}

type NotificationHandler = (n: NotificationFrame) => void;

/** A raw parsed WS frame of any type (`message`, `notification`, `turn_state`, `snapshot`). */
export type RawFrame = { type?: string } & Record<string, unknown>;
type FrameHandler = (frame: RawFrame) => void;

type OpenHandler = () => void;

export class DashboardSocket {
  private ws: WebSocket | null = null;
  private handlers = new Set<MessageHandler>();
  private notifHandlers = new Set<NotificationHandler>();
  private openHandlers = new Set<OpenHandler>();
  private frameHandlers = new Set<FrameHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private closed = false;

  connect(): void {
    this.closed = false;
    this.open();
  }

  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.heartbeat) clearInterval(this.heartbeat);
    if (this.ws) this.ws.close();
    this.ws = null;
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  onNotification(handler: NotificationHandler): () => void {
    this.notifHandlers.add(handler);
    return () => this.notifHandlers.delete(handler);
  }

  /** Subscribe to (re)open — fires on the first connect too. */
  onOpen(handler: OpenHandler): () => void {
    this.openHandlers.add(handler);
    return () => this.openHandlers.delete(handler);
  }

  /**
   * Subscribe to EVERY parsed frame, regardless of `type`. The shared turn
   * module reads `turn_state` / `snapshot` frames (spec 127 §C) without
   * stealing them from `onMessage`, whose `type:"message"` contract is
   * unchanged.
   */
  onFrame(handler: FrameHandler): () => void {
    this.frameHandlers.add(handler);
    return () => this.frameHandlers.delete(handler);
  }

  /**
   * Re-open the socket if it is not already usable (spec 127 §C.3).
   *
   * The iOS PWA suspends the page and the socket dies without a prompt
   * `onclose`; on resume `visibilitychange`/`pageshow` call this to force a
   * reconnect immediately instead of waiting out the backoff. No-ops when the
   * socket is OPEN or already CONNECTING.
   */
  ensureConnected(): void {
    if (this.closed) return;
    const state = this.ws?.readyState;
    if (state === WebSocket.OPEN || state === WebSocket.CONNECTING) return;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.open();
  }

  private open(): void {
    if (!getToken()) return;
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const url = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(getToken())}`;

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.onopen = () => {
      this.attempt = 0;
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: "ping" }));
        }
      }, 20000);
      // Signal every (re)open — including the very first one. Consumers that
      // loaded data while the gateway was unreachable (e.g. a browser refresh
      // during a restart) refetch here instead of staying blank.
      this.openHandlers.forEach((h) => h());
      window.dispatchEvent(new CustomEvent(WS_OPEN_EVENT));
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data as string);
        // Fan every frame to generic subscribers first (additive; does not
        // consume the frame — the typed handlers below still run).
        this.frameHandlers.forEach((h) => h(data as RawFrame));
        if (data?.type === "notification") {
          this.notifHandlers.forEach((h) => h(data as NotificationFrame));
          // Emit custom event for views that don't have direct socket access
          window.dispatchEvent(new CustomEvent("sarathy:notification", { detail: data }));
        } else if (data?.type === "message") {
          this.handlers.forEach((h) => h(data as OutboundMessage));
        }
      } catch {
        /* ignore non-JSON */
      }
    };

    ws.onclose = () => {
      if (this.heartbeat) clearInterval(this.heartbeat);
      this.heartbeat = null;
      if (!this.closed) this.scheduleReconnect();
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    };
  }

  private scheduleReconnect(): void {
    if (this.closed) return;
    const delay = Math.min(1000 * 2 ** this.attempt, 15000);
    this.attempt += 1;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.open(), delay);
  }
}
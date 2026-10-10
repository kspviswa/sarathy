import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DashboardSocket, WS_OPEN_EVENT } from "@/lib/ws";

vi.mock("@/lib/api", () => ({
  getToken: () => "test-token",
}));

class FakeWebSocket {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  readonly url: string;
  readyState = 0;
  sent: string[] = [];
  handlers: Record<string, Array<(arg?: any) => void>> = {};
  static instances: FakeWebSocket[] = [];

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  set onopen(cb: (() => void) | null) {
    this.handlers["open"] = cb ? [cb] : [];
  }
  set onmessage(cb: ((ev: { data: string }) => void) | null) {
    this.handlers["message"] = cb ? [cb] : [];
  }
  set onclose(cb: (() => void) | null) {
    this.handlers["close"] = cb ? [cb] : [];
  }
  set onerror(cb: (() => void) | null) {
    this.handlers["error"] = cb ? [cb] : [];
  }
  get onopen() {
    return this.handlers["open"]?.[0];
  }
  get onmessage() {
    return this.handlers["message"]?.[0];
  }
  get onclose() {
    return this.handlers["close"]?.[0];
  }
  get onerror() {
    return this.handlers["error"]?.[0];
  }

  send(data: string) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  emit(type: string, data?: unknown) {
    const cb = this.handlers[type]?.[0];
    if (cb) cb(data === undefined ? undefined : { data: JSON.stringify(data) });
  }
}

describe("DashboardSocket notification frames", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:18790" },
      dispatched: [] as Array<{ type: string }>,
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(function (this: { dispatched: Array<{ type: string }> }, ev: any) {
        this.dispatched.push(ev);
        return true;
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("surfaces a notification frame to onNotification handlers and NOT onMessage", () => {
    const socket = new DashboardSocket();
    const msgSpy = vi.fn();
    const notifSpy = vi.fn();
    socket.onMessage(msgSpy);
    socket.onNotification(notifSpy);
    socket.connect();

    const ws = FakeWebSocket.instances[0];
    expect(ws).toBeTruthy();

    ws.emit("message", {
      type: "notification",
      payload: { title: "Backup done", body: "Finished", tab: "status" },
    });

    expect(notifSpy).toHaveBeenCalledTimes(1);
    expect(notifSpy).toHaveBeenCalledWith({
      type: "notification",
      payload: { title: "Backup done", body: "Finished", tab: "status" },
    });
    expect(msgSpy).not.toHaveBeenCalled();
    socket.disconnect();
  });

  it("still delivers normal message frames to onMessage", () => {
    const socket = new DashboardSocket();
    const msgSpy = vi.fn();
    socket.onMessage(msgSpy);
    socket.connect();

    const ws = FakeWebSocket.instances[0];
    ws.emit("message", {
      type: "message",
      channel: "dashboard",
      chatId: "console",
      content: "hi",
      media: [],
      replyTo: null,
      metadata: {},
    });

    expect(msgSpy).toHaveBeenCalledTimes(1);
    socket.disconnect();
  });
});

/**
 * Spec 124 §B1 — the (re)open signal is what lets `useLastSession` recover a
 * transcript after a refresh that landed while the gateway was restarting.
 */
describe("DashboardSocket open signal", () => {
  beforeEach(() => {
    FakeWebSocket.instances = [];
    (globalThis as any).WebSocket = FakeWebSocket;
    vi.stubGlobal("window", {
      location: { protocol: "http:", host: "localhost:18790" },
      dispatched: [] as Array<{ type: string }>,
      addEventListener: vi.fn(),
      dispatchEvent: vi.fn(function (this: { dispatched: Array<{ type: string }> }, ev: any) {
        this.dispatched.push(ev);
        return true;
      }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("fires onOpen handlers and the window event when the socket opens", () => {
    const socket = new DashboardSocket();
    const openSpy = vi.fn();
    socket.onOpen(openSpy);
    socket.connect();

    const ws = FakeWebSocket.instances[0];
    ws.emit("open");

    expect(openSpy).toHaveBeenCalledTimes(1);
    const win = globalThis.window as unknown as { dispatched: Array<{ type: string }> };
    expect(win.dispatched.map((e) => e.type)).toContain(WS_OPEN_EVENT);
    socket.disconnect();
  });

  it("unsubscribes onOpen handlers", () => {
    const socket = new DashboardSocket();
    const openSpy = vi.fn();
    const off = socket.onOpen(openSpy);
    socket.connect();
    off();
    FakeWebSocket.instances[0].emit("open");

    expect(openSpy).not.toHaveBeenCalled();
    socket.disconnect();
  });
});

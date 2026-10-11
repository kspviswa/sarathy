/**
 * Spec 127 §C / §D — the shared server-owned turn state and the non-blocking
 * notification preference.
 *
 * Root cause these pin: `streaming` used to be client state set/cleared only by
 * WS frames, so a missed terminal frame (socket drop, iOS suspension) stranded
 * the spinner/Stop button. The turn module now derives `streaming` from the
 * authoritative server turn block and reconciles on (re)connect / resume.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  api: {
    turn: vi.fn().mockResolvedValue({
      active: false,
      state: "idle",
      turn_id: null,
      started_at: null,
    }),
    notificationsPref: vi.fn().mockResolvedValue({ enabled: null }),
    setNotificationsPref: vi.fn().mockResolvedValue({ ok: true, enabled: true }),
  },
}));

import { api } from "@/lib/api";
import { WS_OPEN_EVENT } from "@/lib/events";
import type { RawFrame } from "@/lib/ws";
import {
  attachTurnSync,
  getTurnSnapshot,
  endTurnLocal,
  noteMessageFrame,
  reconcileTurn,
  setServerTurn,
  useTurn,
} from "@/lib/turn";
import { useNotificationPref } from "@/lib/useNotificationPref";

type FrameHandler = (frame: RawFrame) => void;

const apiMock = api as unknown as {
  turn: ReturnType<typeof vi.fn>;
  notificationsPref: ReturnType<typeof vi.fn>;
  setNotificationsPref: ReturnType<typeof vi.fn>;
};

const IDLE = { active: false, state: "idle", turn_id: null, started_at: null };

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.turn.mockResolvedValue(IDLE);
  apiMock.notificationsPref.mockResolvedValue({ enabled: null });
  setServerTurn(IDLE);
  endTurnLocal();
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

describe("turn module — server-owned streaming state", () => {
  it("(a) a snapshot with active:true ⇒ streaming true", () => {
    setServerTurn({ active: true, state: "streaming", turn_id: "T", started_at: 1 });
    expect(getTurnSnapshot()).toMatchObject({ streaming: true, turn_id: "T" });
  });

  it("(b) a snapshot with active:false ⇒ streaming false", () => {
    setServerTurn({ active: true, state: "streaming", turn_id: "T", started_at: 1 });
    setServerTurn({ active: false, state: "idle", turn_id: null, started_at: null });
    expect(getTurnSnapshot().streaming).toBe(false);
  });

  it("(c) reconcile after a reconnect clears a stale client streaming flag", async () => {
    // Stale client state: the terminal frame was missed, so the last known
    // server state still says active.
    setServerTurn({ active: true, state: "streaming", turn_id: "T", started_at: 1 });
    expect(getTurnSnapshot().streaming).toBe(true);

    // The server, truthfully, is idle.
    apiMock.turn.mockResolvedValue({ ...IDLE });

    const detach = attachTurnSync({ onFrame: () => () => {}, ensureConnected: () => {} });
    await act(async () => {
      window.dispatchEvent(new CustomEvent(WS_OPEN_EVENT));
      await Promise.resolve();
      await Promise.resolve();
    });
    detach();

    expect(getTurnSnapshot().streaming).toBe(false);
    expect(apiMock.turn).toHaveBeenCalled();
  });

  it("voice-reply flow clears streaming: media frame (no _final) then turn_state:false", () => {
    // The voice-reply path relays via the message tool to the SAME dashboard
    // target, so the final response is suppressed and NO `_final` frame is ever
    // sent. The media bubble arrives as a plain frame; the ONLY terminal signal
    // is the server `turn_state:false`. The spinner must clear on it
    // (Viswa's "spinner still spinning after a voice reply", 2026-10-11).
    let handler: FrameHandler | null = null;
    const detach = attachTurnSync({
      onFrame: (h: FrameHandler) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
      ensureConnected: () => {},
    });

    act(() => {
      handler?.({
        type: "turn_state",
        channel: "dashboard",
        turn: { active: true, state: "thinking", turn_id: "V1", started_at: 1 },
      });
    });
    expect(getTurnSnapshot().streaming).toBe(true);

    // The media outbound (assistant voice reply): no _final/_progress/_thinking.
    act(() => {
      noteMessageFrame({
        metadata: { turn_id: "V1" },
        // media present on the real frame; the turn module only reads metadata
      });
    });
    expect(getTurnSnapshot().streaming).toBe(true);

    act(() => {
      handler?.({
        type: "turn_state",
        channel: "dashboard",
        turn: { active: false, state: "idle", turn_id: null, started_at: null },
      });
    });
    expect(getTurnSnapshot().streaming).toBe(false);
    detach();
  });

  it("reacts to turn_state / snapshot frames from the socket", () => {
    let handler: FrameHandler | null = null;
    const socket = {
      onFrame: (h: FrameHandler) => {
        handler = h;
        return () => {
          handler = null;
        };
      },
      ensureConnected: () => {},
    };
    const detach = attachTurnSync(socket);
    act(() => {
      handler?.({
        type: "turn_state",
        channel: "dashboard",
        turn: { active: true, state: "thinking", turn_id: "T2", started_at: 5 },
      });
    });
    expect(getTurnSnapshot()).toMatchObject({ streaming: true, turn_id: "T2" });
    detach();
  });

  it("ignores turn frames for other channels", () => {
    let handler: FrameHandler | null = null;
    const detach = attachTurnSync({
      onFrame: (h: FrameHandler) => {
        handler = h;
        return () => {};
      },
      ensureConnected: () => {},
    });
    act(() => {
      handler?.({
        type: "turn_state",
        channel: "telegram",
        turn: { active: true, state: "thinking", turn_id: "X", started_at: 1 },
      });
    });
    expect(getTurnSnapshot().streaming).toBe(false);
    detach();
  });

  it("visibilitychange forces a reconnect and reconciles", async () => {
    const ensureConnected = vi.fn();
    const detach = attachTurnSync({ onFrame: () => () => {}, ensureConnected });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await Promise.resolve();
    });
    detach();
    expect(ensureConnected).toHaveBeenCalled();
  });

  it("useTurn exposes the derived streaming flag", () => {
    setServerTurn({ active: true, state: "tool", turn_id: "T", started_at: 1 });
    const { result } = renderHook(() => useTurn());
    expect(result.current.streaming).toBe(true);
    expect(result.current.turn_id).toBe("T");
  });

  it("reconcileTurn never throws when the API lacks turn (older mocks)", async () => {
    const original = apiMock.turn;
    // @ts-expect-error simulate a partial mock
    apiMock.turn = undefined;
    await expect(reconcileTurn()).resolves.toBeUndefined();
    apiMock.turn = original;
  });
});

describe("useNotificationPref — must not block on the service worker (spec 127 §D)", () => {
  it("resolves to a boolean immediately even when serviceWorker.ready never settles", async () => {
    // A cold launch: the SW is installing and `ready` will not settle for
    // seconds. The toggle must still be usable right away.
    Object.defineProperty(navigator, "serviceWorker", {
      configurable: true,
      value: { ready: new Promise(() => {}) },
    });

    const { result } = renderHook(() => useNotificationPref());
    // Synchronous first render is already a concrete boolean (default OFF) —
    // never `null`, which would leave the control disabled.
    expect(typeof result.current.enabled).toBe("boolean");

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.enabled).toBe(false);
  });

  it("caches the server preference over the local default", async () => {
    apiMock.notificationsPref.mockResolvedValue({ enabled: true });
    const { result } = renderHook(() => useNotificationPref());
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.enabled).toBe(true);
    expect(localStorage.getItem("sarathy_notifications_enabled")).toBe("true");
  });

  it("setEnabled writes locally and posts to the server without awaiting", () => {
    const { result } = renderHook(() => useNotificationPref());
    act(() => result.current.setEnabled(true));
    expect(result.current.enabled).toBe(true);
    expect(localStorage.getItem("sarathy_notifications_enabled")).toBe("true");
    expect(apiMock.setNotificationsPref).toHaveBeenCalledWith(true);
  });
});

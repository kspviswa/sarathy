/**
 * Shared, server-owned turn state for BOTH SPAs (spec 127 §C).
 *
 * `streaming` used to be pure client state set true on `_progress`/`_thinking`
 * and false only on `_final`; a missed terminal frame (socket drop, iOS PWA
 * suspension) left the spinner and Stop button stuck forever. The backend now
 * owns the authoritative per-session turn (spec §A) and this module mirrors it:
 *
 *  - `turn_state` / `snapshot` frames and `GET /api/turn` update the server
 *    block;
 *  - a short optimistic window keeps the caret visible right after the user
 *    sends, before the first server frame lands;
 *  - `attachTurnSync` reconciles on WS (re)connect, `visibilitychange` and
 *    `pageshow` (the iOS-suspend fix).
 *
 * Both `App.tsx` and `mobile/App.tsx` consume this one module — no duplicated
 * logic (that is exactly how the two surfaces drift).
 */
import { useSyncExternalStore } from "react";

import { api } from "@/lib/api";
import { WS_OPEN_EVENT } from "@/lib/events";
import type { RawFrame } from "@/lib/ws";

export const DASHBOARD_SESSION_KEY = "dashboard:console";

/** How long the optimistic window keeps the caret on after a local send. */
const OPTIMISTIC_WINDOW_MS = 8000;
/** Hard bound on the `/api/turn` reconcile fetch so it can never hang. */
const RECONCILE_TIMEOUT_MS = 5000;

export interface TurnBlock {
  active: boolean;
  state: "idle" | "thinking" | "streaming" | "tool" | string;
  turn_id: string | null;
  started_at: number | null;
}

export interface TurnSnapshot extends TurnBlock {
  /** Derived: server says active OR we are inside the optimistic window. */
  streaming: boolean;
}

const IDLE: TurnBlock = {
  active: false,
  state: "idle",
  turn_id: null,
  started_at: null,
};

let serverTurn: TurnBlock = IDLE;
let optimisticUntil = 0;
let optimisticTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();

function compute(): TurnSnapshot {
  return {
    active: serverTurn.active,
    state: serverTurn.state,
    turn_id: serverTurn.turn_id,
    started_at: serverTurn.started_at,
    streaming: serverTurn.active || Date.now() < optimisticUntil,
  };
}

// useSyncExternalStore requires a referentially stable snapshot until state
// actually changes, so cache it and only rebuild when a field differs.
let cached: TurnSnapshot = compute();

function emit(): void {
  const next = compute();
  if (
    next.active === cached.active &&
    next.state === cached.state &&
    next.turn_id === cached.turn_id &&
    next.started_at === cached.started_at &&
    next.streaming === cached.streaming
  ) {
    return;
  }
  cached = next;
  listeners.forEach((l) => l());
}

function clearOptimistic(): void {
  optimisticUntil = 0;
  if (optimisticTimer) {
    clearTimeout(optimisticTimer);
    optimisticTimer = null;
  }
}

/** Apply an authoritative server turn block; it always wins over optimism. */
export function setServerTurn(block: Partial<TurnBlock> | null | undefined): void {
  if (!block) return;
  serverTurn = {
    active: Boolean(block.active),
    state: typeof block.state === "string" ? block.state : block.active ? "thinking" : "idle",
    turn_id: typeof block.turn_id === "string" ? block.turn_id : null,
    started_at: typeof block.started_at === "number" ? block.started_at : null,
  };
  // A definitive "not active" ends any lingering optimistic window.
  if (!serverTurn.active) clearOptimistic();
  emit();
}

/**
 * Start the optimistic window (user just sent / regenerated). Keeps the caret
 * on until the server confirms, or the window elapses — whichever comes first.
 */
export function beginOptimisticTurn(turnId?: string | null): void {
  optimisticUntil = Date.now() + OPTIMISTIC_WINDOW_MS;
  if (turnId && !serverTurn.active) {
    serverTurn = { ...serverTurn, active: true, state: "thinking", turn_id: turnId };
  }
  if (optimisticTimer) clearTimeout(optimisticTimer);
  // Re-emit when the window expires so `streaming` flips back to the server
  // truth even if no further frame arrives.
  optimisticTimer = setTimeout(() => {
    optimisticTimer = null;
    emit();
  }, OPTIMISTIC_WINDOW_MS + 25);
  emit();
}

/** Clear optimism locally (user pressed Stop, started a new chat, …). */
export function endTurnLocal(): void {
  clearOptimistic();
  emit();
}

/** True while the turn is (or appears to be) streaming. */
export function isStreaming(): boolean {
  return cached.streaming;
}

export function getTurnSnapshot(): TurnSnapshot {
  return cached;
}

function subscribeTurn(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** React hook — the shared source of `streaming` / `turn_id` for both SPAs. */
export function useTurn(): TurnSnapshot {
  return useSyncExternalStore(subscribeTurn, getTurnSnapshot, getTurnSnapshot);
}

/**
 * Fold a streamed chat frame into the optimistic turn state. Called from the
 * socket `onMessage` handler BEFORE `applyOutbound` so the turn state tracks
 * the same frames the transcript does.
 *
 * A `_final` frame is terminal (the server's `turn_state:false` follows on the
 * same turn), so it clears optimism immediately rather than waiting.
 */
export function noteMessageFrame(m: { metadata?: Record<string, unknown> }): void {
  const md = (m.metadata || {}) as Record<string, unknown>;
  const turnId = typeof md.turn_id === "string" ? md.turn_id : undefined;

  if (md._final) {
    clearOptimistic();
    // Terminal: reflect it right away so the spinner clears even if the
    // turn_state frame is delayed or dropped.
    serverTurn = { ...serverTurn, active: false, state: "idle", turn_id: turnId ?? serverTurn.turn_id };
    emit();
    return;
  }

  if (md._progress || md._thinking || md._tool_hint) {
    const state = md._tool_hint ? "tool" : md._thinking ? "thinking" : "streaming";
    optimisticUntil = Date.now() + OPTIMISTIC_WINDOW_MS;
    if (optimisticTimer) clearTimeout(optimisticTimer);
    optimisticTimer = setTimeout(() => {
      optimisticTimer = null;
      emit();
    }, OPTIMISTIC_WINDOW_MS + 25);
    serverTurn = { ...serverTurn, active: true, state, turn_id: turnId ?? serverTurn.turn_id };
    emit();
  }
}

/** Apply a raw WS frame carrying server turn state (`turn_state` / `snapshot`). */
export function applyServerFrame(frame: RawFrame): void {
  if (!frame || (frame.type !== "turn_state" && frame.type !== "snapshot")) return;
  if (frame.channel && frame.channel !== "dashboard") return;
  const turn = (frame.turn ?? null) as Partial<TurnBlock> | null;
  if (turn && typeof turn === "object") setServerTurn(turn);
}

/**
 * Fetch the authoritative turn state and apply it (spec §C.2). Bounded so a
 * dead network can never hang the reconcile.
 */
export async function reconcileTurn(key: string = DASHBOARD_SESSION_KEY): Promise<void> {
  try {
    // Older/partial API mocks (and pre-§A gateways) may not expose `turn`;
    // treat that as "no server state" rather than throwing on an event.
    if (typeof api.turn !== "function") return;
    const request = api.turn(key);
    // Swallow the eventual result either way to avoid an unhandled rejection.
    request.catch(() => undefined);
    const block = await Promise.race([
      request,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("turn reconcile timeout")), RECONCILE_TIMEOUT_MS),
      ),
    ]);
    setServerTurn(block);
  } catch {
    /* keep the last known state; the next event retries */
  }
}

interface TurnSocket {
  onFrame?(handler: (frame: RawFrame) => void): () => void;
  ensureConnected?(): void;
}

/**
 * Wire the shared reconcile triggers to a socket (spec §C.2, §C.3):
 *  - every `turn_state` / `snapshot` frame updates the server block;
 *  - `WS_OPEN_EVENT` reconciles (covers a missed terminal frame);
 *  - `visibilitychange` (visible) and `pageshow` force a reconnect if the
 *    socket is dead, then reconcile — the iOS PWA suspension fix.
 *
 * Returns a cleanup that removes every listener.
 */
export function attachTurnSync(socket: TurnSocket | null, key: string = DASHBOARD_SESSION_KEY): () => void {
  const offFrame = socket?.onFrame?.(applyServerFrame);

  const onOpen = () => void reconcileTurn(key);
  const onVisible = () => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
    socket?.ensureConnected?.();
    void reconcileTurn(key);
  };
  const onPageShow = () => {
    socket?.ensureConnected?.();
    void reconcileTurn(key);
  };

  window.addEventListener(WS_OPEN_EVENT, onOpen);
  document.addEventListener("visibilitychange", onVisible);
  window.addEventListener("pageshow", onPageShow);

  return () => {
    offFrame?.();
    window.removeEventListener(WS_OPEN_EVENT, onOpen);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener("pageshow", onPageShow);
  };
}

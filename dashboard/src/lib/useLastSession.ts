import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ChatMessage } from "@/views/ChatView";

export const DASHBOARD_SESSION_KEY = "dashboard:console";

/**
 * Window event fired by {@link DashboardSocket} every time the WebSocket
 * (re)opens. A first load can happen while the gateway is still down — during a
 * restart, say — so the transcript is refetched on this signal rather than only
 * on mount: that is what lets a refresh mid-restart recover once the gateway is
 * back instead of staying blank forever.
 */
export const WS_OPEN_EVENT = "sarathy:ws-open";

/** Backoff between post-reconnect refetch attempts (bounded — spec §B1). */
const RECONNECT_RETRY_DELAYS_MS = [0, 1000, 3000];

let _resetFlag = false;

export function resetLastSession(): void {
  _resetFlag = true;
}

export function clearResetFlag(): void {
  _resetFlag = false;
}

export interface UseLastSessionResult {
  loading: boolean;
  /** Last load failure, or null when the last attempt succeeded. */
  error: string | null;
}

/**
 * Load the previous dashboard conversation on open so the Chat tab does not
 * start empty. Prefers the `dashboard:console` session (the same key the WS
 * streams into); falls back to the most recently updated session.
 *
 * Refetches whenever the WebSocket (re)opens — a browser refresh during a
 * gateway restart mounts this hook while `/api/session` is unreachable, and
 * without the reconnect signal that empty chat would never recover.
 */
export function useLastSession(
  authed: boolean,
  onMessages: (messages: ChatMessage[]) => void,
): UseLastSessionResult {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const onMessagesRef = useRef(onMessages);
  onMessagesRef.current = onMessages;

  // Monotonic load id: a slow response from an older attempt must never
  // overwrite the result of a newer one (which may already include messages
  // streamed in over the freshly-reopened socket).
  const seqRef = useRef(0);
  const inFlightRef = useRef(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearTimers = useCallback(() => {
    for (const t of timersRef.current) clearTimeout(t);
    timersRef.current = [];
  }, []);

  /**
   * One history load. `retriesLeft` schedules bounded backoff attempts on
   * failure; the initial mount load does not retry (the reconnect signal will
   * drive the next attempt instead).
   */
  const load = useCallback(
    async (retriesLeft = 0): Promise<void> => {
      const seq = ++seqRef.current;
      inFlightRef.current = true;
      const isCurrent = () => seq === seqRef.current;

      try {
        const { sessions } = await api.sessions();
        const chosen =
          sessions.find((s) => s.key === DASHBOARD_SESSION_KEY) ?? sessions[0];
        // No sessions at all is a legitimate empty state, not a failure.
        if (!chosen) {
          if (isCurrent()) setError(null);
          return;
        }
        const detail = await api.session(chosen.key);
        if (!isCurrent()) return;
        const mapped = detail.messages
          // Only surface user + assistant messages that actually carry text.
          // Tool-call bookkeeping rows have null/empty content; rendering them
          // would crash on `.content.length` (blank-screen regression).
          .filter(
            (m) =>
              (m.role === "user" || m.role === "assistant") &&
              typeof m.content === "string" &&
              m.content.length > 0,
          )
          .map<ChatMessage>((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content,
            messageId: m.timestamp,
          }));
        if (mapped.length > 0) onMessagesRef.current(mapped);
        if (isCurrent()) setError(null);
      } catch (e) {
        // Never blank what is already on screen: a transient failure keeps the
        // existing messages and only surfaces the error (spec §B2).
        if (isCurrent()) {
          setError(e instanceof Error ? e.message : String(e));
        }
        if (retriesLeft > 0) {
          // retriesLeft counts DOWN, so the delay index counts up: the first
          // retry fires immediately, then 1s, then 3s.
          const delay =
            RECONNECT_RETRY_DELAYS_MS[
              RECONNECT_RETRY_DELAYS_MS.length - retriesLeft
            ];
          timersRef.current.push(
            setTimeout(() => void load(retriesLeft - 1), delay),
          );
        }
      } finally {
        if (isCurrent()) {
          inFlightRef.current = false;
          setLoading(false);
        }
      }
    },
    [],
  );

  // Initial load (mount / auth change).
  useEffect(() => {
    if (!authed) return;
    if (_resetFlag) {
      clearResetFlag();
      setLoading(false);
      return;
    }
    setLoading(true);
    void load(0);
    return () => {
      clearTimers();
    };
  }, [authed, load, clearTimers]);

  // Refetch on every WebSocket (re)open, with bounded backoff: this is the
  // recovery path for a refresh that happened while the gateway was down.
  useEffect(() => {
    if (!authed) return;

    const onOpen = () => {
      if (inFlightRef.current) return; // a load is already running
      setLoading(true);
      void load(RECONNECT_RETRY_DELAYS_MS.length - 1);
    };

    window.addEventListener(WS_OPEN_EVENT, onOpen);
    return () => {
      window.removeEventListener(WS_OPEN_EVENT, onOpen);
      clearTimers();
    };
  }, [authed, load, clearTimers]);

  return { loading, error };
}

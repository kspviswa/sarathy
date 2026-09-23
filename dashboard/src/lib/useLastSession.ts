import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ChatMessage } from "@/views/ChatView";

export const DASHBOARD_SESSION_KEY = "dashboard:console";

let _resetFlag = false;

export function resetLastSession(): void {
  _resetFlag = true;
}

export function clearResetFlag(): void {
  _resetFlag = false;
}

/**
 * Load the previous dashboard conversation on open so the Chat tab does not
 * start empty. Prefers the `dashboard:console` session (the same key the WS
 * streams into); falls back to the most recently updated session.
 */
export function useLastSession(
  authed: boolean,
  onMessages: (messages: ChatMessage[]) => void,
): boolean {
  const [loadingHistory, setLoadingHistory] = useState(false);
  const onMessagesRef = useRef(onMessages);
  onMessagesRef.current = onMessages;

  useEffect(() => {
    if (!authed) return;
    if (_resetFlag) {
      clearResetFlag();
      setLoadingHistory(false);
      return;
    }
    let cancelled = false;
    setLoadingHistory(true);
    (async () => {
      try {
        const { sessions } = await api.sessions();
        const chosen =
          sessions.find((s) => s.key === DASHBOARD_SESSION_KEY) ?? sessions[0];
        if (!chosen) return;
        const detail = await api.session(chosen.key);
        if (cancelled) return;
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
      } catch {
        // Keep the chat empty if history cannot be loaded.
      } finally {
        if (!cancelled) setLoadingHistory(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [authed]);

  return loadingHistory;
}

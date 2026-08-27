import { useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import type { ChatMessage } from "@/views/ChatView";

const DASHBOARD_SESSION_KEY = "dashboard:console";

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
          .filter((m) => m.role === "user" || m.role === "assistant")
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

import {
  Activity,
  Briefcase,
  CloudOff,
  Command as CommandIcon,
  FileCode2,
  Gauge,
  MessageSquareText,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CommandPalette } from "@/components/CommandPalette";
import { Logo } from "@/components/logo";
import { NotificationControls } from "@/components/NotificationControls";
import { api, AuthError, clearToken, getToken } from "@/lib/api";
import type { Quote } from "@/lib/quotes";
import type { SlashCommand } from "@/lib/palette";
import { ThemeProvider } from "@/lib/theme";
import { useLastSession, resetLastSession, DASHBOARD_SESSION_KEY } from "@/lib/useLastSession";
import { useNotificationPref } from "@/lib/useNotificationPref";
import { useNotifications, type AppNotification } from "@/lib/useNotifications";
import { DashboardSocket } from "@/lib/ws";
import type { ChatMessage as ChatMessageT } from "@/views/ChatView";
import { PairView } from "@/views/PairView";
import { cn } from "@/lib/utils";
import { ChatView } from "./ChatView";
import { FilesView } from "./FilesView";
import { JobsView } from "./JobsView";
import { SessionsView } from "./SessionsView";
import { ConfigView } from "./ConfigView";
import { StatusView } from "./StatusView";

type Tab = "chat" | "files" | "sessions" | "jobs" | "config" | "status";

const TABS: { id: Tab; label: string; icon: typeof MessageSquareText }[] = [
  { id: "chat", label: "Chat", icon: MessageSquareText },
  { id: "files", label: "Files", icon: FileCode2 },
  { id: "sessions", label: "Sessions", icon: Gauge },
  { id: "jobs", label: "Jobs", icon: Briefcase },
  { id: "config", label: "Config", icon: Settings },
  { id: "status", label: "Status", icon: Activity },
];

function MobileAppInner() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [messages, setMessages] = useState<ChatMessageT[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [unread, setUnread] = useState<Partial<Record<Tab, number>>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [followUpSeed, setFollowUpSeed] = useState<{ text: string; nonce: number } | null>(null);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [socket, setSocket] = useState<DashboardSocket | null>(null);
  const socketRef = useRef<DashboardSocket | null>(null);
  const lastUserMessageRef = useRef<string>("");
  const tabRef = useRef<Tab>("chat");
  const busyRef = useRef(false);
  tabRef.current = tab;

  // Handle token in URL (for deep links from Telegram, etc.)
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get("token");
    if (token) {
      localStorage.setItem("sarathy_token", token);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // Handle deep links via hash: #/jobs/<id>
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash;
      if (hash.startsWith("#/jobs/")) {
        const idStr = hash.slice(7);
        const id = parseInt(idStr, 10);
        if (!isNaN(id)) {
          setTab("jobs");
          window.dispatchEvent(new CustomEvent("sarathy:open-job", { detail: { id } }));
        }
      }
    };

    handleHashChange();
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  // Commands for the palette + `/` autocomplete, sourced from the backend
  // (parity with the desktop App: the registry is the single source of truth).
  const refreshCommands = useCallback(() => {
    // Defensive: degrade to an empty list if the endpoint is missing.
    if (typeof api.commands !== "function") return;
    api
      .commands()
      .then((res) => setCommands(res.commands ?? []))
      .catch(() => setCommands([]));
  }, []);

  useEffect(() => {
    if (authed !== true) return;
    refreshCommands();
  }, [authed, refreshCommands]);

  const { loading: loadingHistory, error: historyError } = useLastSession(
    authed === true,
    setMessages,
  );

  const { notifications, unreadIds, markAllRead, markRead, remove, clearAll } =
    useNotifications(socket, {
    navigateTo: (tabId) => {
      const dest = TABS.find((t) => t.id === tabId);
      if (!dest) return;
      setTab(dest.id);
      setUnread((prev) => ({ ...prev, [dest.id]: 0 }));
    },
    onMarkAllRead: () => setUnread({}),
  });

  const { enabled: notificationsEnabled, setEnabled: setNotificationsEnabled } =
    useNotificationPref();

  useEffect(() => {
    if (!getToken()) {
      setAuthed(false);
      return;
    }
    api
      .me()
      .then(() => setAuthed(true))
      .catch((err) => {
        if (err instanceof AuthError) {
          clearToken();
          setAuthed(false);
        } else {
          toast.error(err instanceof Error ? err.message : "Connection failed");
          setAuthed(true);
        }
      });
  }, []);

  useEffect(() => {
    if (!authed) return;
    const socket = new DashboardSocket();
    socketRef.current = socket;
    setSocket(socket);
    const unsubNotif = socket.onNotification((n) => {
      const t = n.payload.tab as Tab | undefined;
      if (t && t !== tabRef.current) {
        setUnread((prev) => ({ ...prev, [t]: (prev[t] ?? 0) + 1 }));
      }
    });
    const unsubscribe = socket.onMessage((m) => {
      if (m.channel !== "dashboard" || m.chatId !== "console") return;
      if (m.metadata?._final) {
        setStreaming(false);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && last.progress) {
            return [
              ...prev.slice(0, -1),
              { ...last, content: m.content, progress: false, media: m.media?.length ? m.media : last.media, replyTo: m.replyTo ?? last.replyTo },
            ];
          }
          if (last?.role === "assistant" && !last.progress) {
            return [
              ...prev.slice(0, -1),
              { ...last, content: last.content + m.content, progress: false, media: m.media?.length ? m.media : last.media, replyTo: m.replyTo ?? last.replyTo },
            ];
          }
          return [...prev, { role: "assistant", content: m.content, media: m.media, replyTo: m.replyTo }];
        });
        return;
      }
      if (m.metadata?._progress) {
        setStreaming(true);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, content: m.content, progress: true }];
          }
          return [...prev, { role: "assistant", content: m.content, progress: true }];
        });
        return;
      }
      if (m.metadata?._thinking) {
        setStreaming(true);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant") {
            return [...prev.slice(0, -1), { ...last, thinkingContent: m.content }];
          }
          return [...prev, { role: "assistant", content: "", thinkingContent: m.content }];
        });
        return;
      }
      if (m.metadata?._tool_hint) {
        setStreaming(true);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          const hint = String(m.metadata._tool_hint);
          if (last?.role === "assistant") {
            return [
              ...prev.slice(0, -1),
              { ...last, toolHint: hint, toolHints: [...(last.toolHints || []), hint] },
            ];
          }
          return [...prev, { role: "assistant", content: "", toolHint: hint, toolHints: [hint] }];
        });
        return;
      }
      setStreaming(false);
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last?.role === "assistant" && !last.progress) {
          return [...prev.slice(0, -1), { ...last, content: last.content + m.content, media: m.media?.length ? m.media : last.media, replyTo: m.replyTo ?? last.replyTo }];
        }
        return [...prev, { role: "assistant", content: m.content, media: m.media, replyTo: m.replyTo }];
      });
    });
    socket.connect();
    return () => {
      unsubNotif();
      unsubscribe();
      socket.disconnect();
      socketRef.current = null;
      setSocket(null);
    };
  }, [authed]);

  const handleSend = useCallback(
    async (
      content: string,
      media?: string[],
      replyTo?: string | null,
      replyToContent?: string,
      quotes?: Quote[],
    ) => {
      lastUserMessageRef.current = content;
      setMessages((prev) => [
        ...prev,
        { role: "user", content, media, replyTo, replyToContent, quotes },
      ]);
      setStreaming(true);
      await api.sendChatFull({
        content,
        ...(media?.length ? { media } : {}),
        replyTo: replyTo ?? null,
        ...(quotes?.length ? { quotes } : {}),
      });
    },
    [],
  );

  /**
   * "Reply" on a notification (spec 126 §D) — mobile parity with the desktop
   * App. Starts a NEW session so the follow-up is a clean conversation, then
   * seeds the composer with the notification as a quote chip. Nothing is sent
   * on the user's behalf.
   */
  const handleNotificationReply = useCallback(async (n: AppNotification) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await api.sessionNew(DASHBOARD_SESSION_KEY);
      resetLastSession();
      setMessages([]);
      setStreaming(false);
      setOpenFile(null);
      setFollowUpSeed({
        text: [n.title, n.body].filter(Boolean).join("\n"),
        nonce: Date.now(),
      });
      setTab("chat");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to start a new session");
    } finally {
      busyRef.current = false;
    }
  }, []);

  const handleNewChat = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await api.sessionNew(DASHBOARD_SESSION_KEY);
      resetLastSession();
      setMessages([]);
      setStreaming(false);
      setOpenFile(null);
      toast.success("Session archived · new chat started");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to archive session");
    } finally {
      busyRef.current = false;
    }
  }, []);

  const handleStop = useCallback(async () => {
    await api.stopChat();
    setStreaming(false);
  }, []);

  const handleOpenFile = useCallback(
    (path: string) => {
      setOpenFile(path);
      setTab("files");
    },
    [],
  );

  const handleRegenerate = useCallback(async () => {
    const lastUserMsg = lastUserMessageRef.current;
    if (!lastUserMsg || streaming) return;
    setMessages((prev) => [...prev, { role: "user", content: lastUserMsg }]);
    await api.sendChat(lastUserMsg);
  }, [streaming]);

  if (authed === null) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <div className="animate-pulse text-sm text-muted-foreground">Connecting…</div>
      </div>
    );
  }

  if (!authed) {
    return <PairView onPaired={() => setAuthed(true)} />;
  }

  const logout = () => {
    void api.logout();
    clearToken();
    setAuthed(false);
  };

  return (
    <div
      className="standalone-fix safe-top flex min-h-dvh flex-col overflow-hidden"
      data-testid="mobile-app"
    >
      <header className="flex items-center justify-between border-b bg-background/90 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <Logo size={22} />
          <span className="font-bold tracking-tight">Sarathy</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <button
            onClick={() => setPaletteOpen(true)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Commands"
            title="Commands"
            data-testid="mobile-commands-trigger"
          >
            <CommandIcon className="size-4" />
            <span>Commands</span>
          </button>
          <NotificationControls
            enabled={notificationsEnabled}
            onEnabledChange={setNotificationsEnabled}
            notifications={notifications}
            unreadIds={unreadIds}
            onMarkAllRead={markAllRead}
            onMarkRead={markRead}
            onDelete={remove}
            onClearAll={clearAll}
            swipeToDismiss
            onReply={(n) => void handleNotificationReply(n)}
            onNavigate={(tabId) => {
              const dest = TABS.find((t) => t.id === tabId);
              if (!dest) return;
              setTab(dest.id);
              setUnread((prev) => ({ ...prev, [dest.id]: 0 }));
            }}
          />
          <span>Mobile</span>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {tab === "chat" && (
          <>
            {historyError && (
              <div
                data-testid="history-error"
                className="flex items-center gap-2 border-b border-border bg-destructive/10 px-4 py-1.5 text-xs text-destructive"
              >
                <CloudOff className="size-3.5 shrink-0" />
                <span>Could not load conversation history: {historyError}</span>
              </div>
            )}
            <ChatView
              messages={messages}
              streaming={streaming}
              loading={loadingHistory}
              onSend={handleSend}
              onStop={handleStop}
              onNewChat={handleNewChat}
              onOpenFile={handleOpenFile}
              onRegenerate={handleRegenerate}
              commands={commands}
              sessionKey={DASHBOARD_SESSION_KEY}
              followUpSeed={followUpSeed}
            />
          </>
        )}
        {tab === "files" && <FilesView initialFile={openFile} />}
        {tab === "sessions" && <SessionsView />}
        {tab === "jobs" && <JobsView />}
        {tab === "config" && <ConfigView />}
        {tab === "status" && <StatusView onLoggedOut={logout} />}
      </main>

      <nav
        className="safe-bottom flex shrink-0 items-stretch justify-around border-t bg-background px-1 pb-2"
        data-testid="mobile-tabbar"
      >
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            aria-label={label}
            onClick={() => {
              setTab(id);
              setUnread((prev) => ({ ...prev, [id]: 0 }));
            }}
            className={cn(
              "relative flex min-w-0 flex-1 flex-col items-center gap-0.5 rounded-lg px-1 py-2",
              tab === id ? "text-primary" : "text-muted-foreground",
            )}
          >
            <span className="relative">
              {unread[id] ? (
                <span className="absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
                  {unread[id]}
                </span>
              ) : null}
              <Icon className="size-6" />
            </span>
            <span className="text-[10px] font-medium">{label}</span>
          </button>
        ))}
      </nav>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onRun={(command) => {
          setTab("chat");
          void handleSend(command);
        }}
      />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <MobileAppInner />
    </ThemeProvider>
  );
}

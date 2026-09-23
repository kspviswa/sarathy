import {
  Activity,
  Bell,
  Briefcase,
  FileCode2,
  Gauge,
  MessageSquareText,
  Settings,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Logo } from "@/components/logo";
import { api, AuthError, clearToken, getToken } from "@/lib/api";
import { ThemeProvider } from "@/lib/theme";
import { useLastSession, resetLastSession, DASHBOARD_SESSION_KEY } from "@/lib/useLastSession";
import { useNotifications } from "@/lib/useNotifications";
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

  const loadingHistory = useLastSession(authed === true, setMessages);

  const { unreadCount, markAllRead } = useNotifications(socket, {
    navigateTo: (tabId) => {
      const dest = TABS.find((t) => t.id === tabId);
      if (!dest) return;
      setTab(dest.id);
      setUnread((prev) => ({ ...prev, [dest.id]: 0 }));
    },
    onMarkAllRead: () => setUnread({}),
  });

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
      if (m.channel !== "dashboard" && m.chatId !== "console") return;
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
    async (content: string, media?: string[], replyTo?: string | null, replyToContent?: string) => {
      lastUserMessageRef.current = content;
      setMessages((prev) => [...prev, { role: "user", content, media, replyTo, replyToContent }]);
      setStreaming(true);
      if (media && media.length > 0) {
        await api.sendChatWithMedia(content, media, replyTo);
      } else {
        await api.sendChat(content);
      }
    },
    [],
  );

  const handleNewChat = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await api.sessionNew(DASHBOARD_SESSION_KEY);
      resetLastSession();
      setMessages([]);
      setStreaming(false);
      setOpenFile(null);
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
    <div className="safe-top flex h-dvh flex-col" data-testid="mobile-app">
      <header className="flex items-center justify-between border-b bg-background/90 px-4 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <Logo size={22} />
          <span className="font-bold tracking-tight">Sarathy</span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {unreadCount > 0 && (
            <button
              onClick={markAllRead}
              aria-label={`${unreadCount} unread notifications, mark all read`}
              data-testid="mobile-notifications-badge"
              className="flex items-center gap-1.5 rounded-full text-primary"
            >
              <Bell className="size-4" />
              <Badge variant="destructive" className="h-4 min-w-4 px-1 text-[10px]">
                {unreadCount}
              </Badge>
            </button>
          )}
          <span>Mobile</span>
        </div>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {tab === "chat" && (
          <ChatView
            messages={messages}
            streaming={streaming}
            loading={loadingHistory}
            onSend={handleSend}
            onStop={handleStop}
            onNewChat={handleNewChat}
            onOpenFile={handleOpenFile}
            onRegenerate={handleRegenerate}
          />
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

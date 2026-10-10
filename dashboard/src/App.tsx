import {
  Bell,
  Briefcase,
  Command as CommandIcon,
  FileCode2,
  Gauge,
  LogOut,
  MessageSquareText,
  Search,
  Send,
  Settings,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { ArchiveBrowser, TranscriptDrawer } from "@/components/ArchiveBrowser";
import { CommandPalette } from "@/components/CommandPalette";
import { DEFAULT_SUGGESTIONS } from "@/components/GreetingState";
import { Logo } from "@/components/logo";
import { PresenceIndicator } from "@/components/Presence";
import { PushToggle } from "@/components/PushToggle";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { api, AuthError, clearToken, getToken } from "@/lib/api";
import type { SlashCommand } from "@/lib/palette";
import type { Quote } from "@/lib/quotes";
import {
  nextReaction,
  reactionFrameFrom,
  startTurn,
  type ReactionState,
} from "@/lib/reactions";
import { ThemeProvider } from "@/lib/theme";
import type { SessionInfo } from "@/lib/types";
import { DASHBOARD_SESSION_KEY, resetLastSession, useLastSession } from "@/lib/useLastSession";
import { useNotifications } from "@/lib/useNotifications";
import { cn } from "@/lib/utils";
import { DashboardSocket } from "@/lib/ws";
import { ChatView, type ChatMessage } from "@/views/ChatView";
import { ConfigView } from "@/views/ConfigView";
import { FilesView } from "@/views/FilesView";
import { JobsView } from "@/views/JobsView";
import { PairView } from "@/views/PairView";
import { StatusView } from "@/views/StatusView";

export type { ChatMessage } from "@/views/ChatView";

/** Secondary views slide over the chat instead of replacing it (spec §A). */
type Drawer = "files" | "sessions" | "jobs" | "config" | "status" | null;

const DRAWERS: { id: Exclude<Drawer, null>; label: string; icon: typeof Gauge }[] = [
  { id: "jobs", label: "Jobs", icon: Briefcase },
  { id: "files", label: "Files", icon: FileCode2 },
  { id: "config", label: "Config", icon: Settings },
  { id: "status", label: "Status", icon: Gauge },
];

function AppInner() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [drawer, setDrawer] = useState<Drawer>(null);
  const [transcriptKey, setTranscriptKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [reaction, setReaction] = useState<ReactionState>("done");
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [unread, setUnread] = useState<Partial<Record<Drawer, number>>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [socket, setSocket] = useState<DashboardSocket | null>(null);
  const socketRef = useRef<DashboardSocket | null>(null);
  const lastUserMessageRef = useRef<string>("");
  const drawerRef = useRef<Drawer>(null);
  const busyRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  drawerRef.current = drawer;

  // Handle token in URL (for deep links from Telegram, etc.)
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get("token");
    if (token) {
      localStorage.setItem("sarathy_token", token);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  // Deep links via hash: #/jobs/<id>
  useEffect(() => {
    const handleHashChange = () => {
      const hash = window.location.hash;
      if (hash.startsWith("#/jobs/")) {
        const id = parseInt(hash.slice(7), 10);
        if (!isNaN(id)) {
          setDrawer("jobs");
          window.dispatchEvent(new CustomEvent("sarathy:open-job", { detail: { id } }));
        }
      }
    };
    handleHashChange();
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  // Global Cmd+K / Ctrl+K.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const loadingHistory = useLastSession(authed === true, setMessages);

  const { unreadCount, markAllRead } = useNotifications(socket, {
    navigateTo: (tab) => setDrawer(tab as Drawer),
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

  // Commands for the palette + `/` autocomplete, sourced from the backend.
  const refreshCommands = useCallback(() => {
    api
      .commands()
      .then((res) => setCommands(res.commands ?? []))
      .catch(() => setCommands([]));
  }, []);

  const refreshSessions = useCallback(() => {
    api
      .sessions()
      .then((res) => setSessions(res.sessions ?? []))
      .catch(() => setSessions([]));
  }, []);

  useEffect(() => {
    if (authed !== true) return;
    refreshCommands();
    refreshSessions();
  }, [authed, refreshCommands, refreshSessions]);

  useEffect(() => {
    if (!authed) return;
    const socket = new DashboardSocket();
    socketRef.current = socket;
    setSocket(socket);

    const unsubNotif = socket.onNotification((n) => {
      const t = n.payload.tab as Drawer | undefined;
      if (t && t !== drawerRef.current) {
        setUnread((prev) => ({ ...prev, [t]: (prev[t] ?? 0) + 1 }));
      }
    });

    const unsubscribe = socket.onMessage((m) => {
      if (m.channel !== "dashboard" && m.chatId !== "console") return;

      // Fold every streamed frame into the reaction state machine.
      const frame = reactionFrameFrom(m.metadata);
      if (frame) {
        setReaction((prev) => nextReaction(prev, frame));
        if (frame.kind === "final") setStreaming(false);
        else setStreaming(true);
      }

      if (m.metadata?._final) {
        setStreaming(false);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && last.progress) {
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                content: m.content,
                progress: false,
                media: m.media?.length ? m.media : last.media,
                replyTo: m.replyTo ?? last.replyTo,
              },
            ];
          }
          if (last?.role === "assistant" && !last.progress) {
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                content: last.content + m.content,
                progress: false,
                media: m.media?.length ? m.media : last.media,
                replyTo: m.replyTo ?? last.replyTo,
              },
            ];
          }
          return [
            ...prev,
            { role: "assistant", content: m.content, media: m.media, replyTo: m.replyTo },
          ];
        });
        refreshSessions();
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

      if (!frame) {
        setStreaming(false);
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (last?.role === "assistant" && !last.progress) {
            return [
              ...prev.slice(0, -1),
              {
                ...last,
                content: last.content + m.content,
                media: m.media?.length ? m.media : last.media,
                replyTo: m.replyTo ?? last.replyTo,
              },
            ];
          }
          return [...prev, { role: "assistant", content: m.content, media: m.media, replyTo: m.replyTo }];
        });
      }
    });

    socket.connect();
    return () => {
      unsubNotif();
      unsubscribe();
      socket.disconnect();
      socketRef.current = null;
      setSocket(null);
    };
  }, [authed, refreshSessions]);

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
      // Optimistic: show live state immediately, before the first frame lands.
      setStreaming(true);
      setReaction(startTurn());
      await api.sendChatFull({
        content,
        ...(media?.length ? { media } : {}),
        replyTo: replyTo ?? null,
        ...(quotes?.length ? { quotes } : {}),
      });
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
      setReaction("done");
      setOpenFile(null);
      setTranscriptKey(null);
      refreshSessions();
      toast.success("Session archived · new chat started");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to archive session");
    } finally {
      busyRef.current = false;
    }
  }, [refreshSessions]);

  const handleStop = useCallback(async () => {
    await api.stopChat();
    setStreaming(false);
    setReaction("done");
  }, []);

  const handleOpenFile = useCallback((path: string) => {
    setOpenFile(path);
    setDrawer("files");
    setUnread((prev) => ({ ...prev, files: 0 }));
  }, []);

  const handleRegenerate = useCallback(async () => {
    const lastUserMsg = lastUserMessageRef.current;
    if (!lastUserMsg || streaming) return;
    setMessages((prev) => [...prev, { role: "user", content: lastUserMsg }]);
    setStreaming(true);
    setReaction(startTurn());
    await api.sendChat({ content: lastUserMsg });
  }, [streaming]);

  // A command picked in the palette is sent as a normal slash message.
  const runCommand = useCallback(
    (command: string) => {
      setDrawer(null);
      void handleSend(command);
    },
    [handleSend],
  );

  const openTranscript = useCallback(
    (key: string) => {
      setTranscriptKey(key);
      setDrawer("sessions");
    },
    [],
  );

  const recentTopics = useMemo(
    () =>
      sessions
        .filter((s) => s.key !== DASHBOARD_SESSION_KEY && (s.topic || s.preview))
        .slice(0, 8)
        .map((s) => ({
          label: (s.topic || s.preview || s.key).slice(0, 32),
          prompt: `Tell me about "${s.topic || s.preview || ""}".`,
        })),
    [sessions],
  );

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
    <div className="standalone-fix flex min-h-dvh flex-col md:h-dvh md:flex-row" data-testid="app-shell">
      {/* ------------------------------------------------------------ left rail */}
      <aside
        className={cn(
          "safe-bottom order-2 flex shrink-0 flex-col border-t bg-background md:order-1 md:w-64 md:border-r md:border-t-0",
          railOpen ? "flex" : "hidden md:flex",
        )}
        data-testid="left-rail"
      >
        <div className="hidden items-center gap-2 px-4 py-4 md:flex">
          <Logo size={26} />
          <span className="flex-1 font-bold tracking-tight">Sarathy</span>
          <button
            onClick={() => setRailOpen(false)}
            className="rounded p-1 text-muted-foreground md:hidden"
            aria-label="Hide conversations"
          >
            <X className="size-4" />
          </button>
        </div>

        <div className="flex items-center gap-1 px-2 pb-2">
          <Button
            variant="secondary"
            size="sm"
            className="flex-1 justify-start"
            onClick={() => setPaletteOpen(true)}
          >
            <CommandIcon className="size-3.5" />
            <span className="flex-1 text-left">Search</span>
            <kbd className="rounded border border-border px-1 text-[10px]">⌘K</kbd>
          </Button>
        </div>

        {unreadCount > 0 && (
          <button
            onClick={markAllRead}
            className="mx-2 mb-1 hidden items-center justify-between rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground md:flex"
            data-testid="notifications-menu"
          >
            <span className="flex items-center gap-1.5">
              <Bell className="size-3.5" />
              Notifications
            </span>
            <Badge variant="destructive">{unreadCount}</Badge>
          </button>
        )}

        <nav className="space-y-0.5 px-2">
          {DRAWERS.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              variant={drawer === id && !transcriptKey ? "secondary" : "ghost"}
              size="sm"
              onClick={() => {
                setTranscriptKey(null);
                setDrawer((d) => (d === id ? null : id));
                setUnread((prev) => ({ ...prev, [id]: 0 }));
              }}
              className="relative w-full justify-start"
            >
              <Icon className="size-4" />
              <span className="flex-1 text-left">{label}</span>
              {unread[id] ? (
                <span className="rounded-full bg-destructive px-1.5 text-[10px] font-semibold text-destructive-foreground">
                  {unread[id]}
                </span>
              ) : null}
            </Button>
          ))}
        </nav>

        {/* Recent conversations — shallow list, click to open transcript. */}
        <div className="mt-4 min-h-0 flex-1 overflow-y-auto px-2 pb-2">
          <h2 className="px-2 pb-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
            Recent conversations
          </h2>
          {sessions.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">No conversations yet.</p>
          ) : (
            <ul className="space-y-0.5">
              {sessions.slice(0, 30).map((s) => (
                <li key={s.key}>
                  <button
                    onClick={() => openTranscript(s.key)}
                    className={cn(
                      "w-full truncate rounded-lg px-2 py-1.5 text-left text-sm hover:bg-accent",
                      transcriptKey === s.key && "bg-accent font-medium",
                    )}
                    data-testid="rail-session"
                  >
                    {s.topic || s.preview || s.key}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </aside>

      {/* ---------------------------------------------------------------- main */}
      <main className="order-1 flex min-h-0 flex-1 flex-col md:order-2">
        {/* top bar */}
        <header className="safe-top flex items-center gap-2 border-b bg-background/80 px-3 py-2 backdrop-blur">
          <button
            onClick={() => setRailOpen((v) => !v)}
            className="rounded-lg p-2 text-muted-foreground hover:bg-accent hover:text-foreground md:hidden"
            aria-label="Toggle conversations"
          >
            <MessageSquareText className="size-4" />
          </button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setPaletteOpen(true)}
            className="hidden text-muted-foreground sm:inline-flex"
          >
            <Search className="size-3.5" />
            <span className="text-xs">Search commands…</span>
            <kbd className="ml-2 rounded border border-border px-1 text-[10px]">⌘K</kbd>
          </Button>

          <div className="flex-1" />

          <PresenceIndicator state={reaction} />
          <PushToggle />
          <ThemeToggle />

          <div className="hidden items-center gap-2 md:flex">
            <span className="max-w-[10rem] truncate text-xs text-muted-foreground">Profile</span>
            <Button
              variant="ghost"
              size="icon"
              onClick={logout}
              aria-label="Log out"
              title="Log out"
            >
              <LogOut className="size-4" />
            </Button>
          </div>
        </header>

        {/* chat surface stays mounted so drawers slide OVER it */}
        <div className="min-h-0 flex-1">
          <ChatView
            messages={messages}
            streaming={streaming}
            loading={loadingHistory}
            reaction={reaction}
            onSend={handleSend}
            onStop={handleStop}
            onNewChat={handleNewChat}
            onOpenFile={handleOpenFile}
            onRegenerate={handleRegenerate}
            commands={commands}
            sessionKey={DASHBOARD_SESSION_KEY}
            suggestions={
              recentTopics.length > 0
                ? [...recentTopics, ...DEFAULT_SUGGESTIONS].slice(0, 6)
                : DEFAULT_SUGGESTIONS
            }
            messagesRef={messagesRef}
          />
        </div>

        {/* drawers slide over the continuous chat surface */}
        {drawer && (
          <div
            className="fixed inset-0 z-30 flex justify-end bg-background/50 backdrop-blur-sm"
            onClick={() => setDrawer(null)}
            data-testid="drawer-scrim"
          >
            <aside
              className="flex h-full w-full max-w-2xl flex-col border-l border-border bg-background shadow-2xl"
              onClick={(e) => e.stopPropagation()}
              data-testid="drawer-panel"
            >
              {drawer === "sessions" && transcriptKey ? (
                <TranscriptDrawer key_={transcriptKey} onClose={() => setTranscriptKey(null)} />
              ) : drawer === "sessions" ? (
                <ArchiveBrowser
                  sessions={sessions}
                  onOpen={openTranscript}
                  onClose={() => setDrawer(null)}
                  loading={false}
                />
              ) : drawer === "files" ? (
                <div className="flex h-full flex-col">
                  <div className="flex items-center justify-end border-b border-border px-3 py-2">
                    <Button variant="ghost" size="icon" onClick={() => setDrawer(null)} aria-label="Close">
                      <X className="size-4" />
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1">
                    <FilesView initialFile={openFile} />
                  </div>
                </div>
              ) : drawer === "jobs" ? (
                <div className="flex h-full flex-col">
                  <div className="flex items-center justify-end border-b border-border px-3 py-2">
                    <Button variant="ghost" size="icon" onClick={() => setDrawer(null)} aria-label="Close">
                      <X className="size-4" />
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1">
                    <JobsView />
                  </div>
                </div>
              ) : drawer === "config" ? (
                <div className="flex h-full flex-col">
                  <div className="flex items-center justify-end border-b border-border px-3 py-2">
                    <Button variant="ghost" size="icon" onClick={() => setDrawer(null)} aria-label="Close">
                      <X className="size-4" />
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <ConfigView />
                  </div>
                </div>
              ) : drawer === "status" ? (
                <div className="flex h-full flex-col">
                  <div className="flex items-center justify-end border-b border-border px-3 py-2">
                    <Button variant="ghost" size="icon" onClick={() => setDrawer(null)} aria-label="Close">
                      <X className="size-4" />
                    </Button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto">
                    <StatusView onLoggedOut={logout} />
                  </div>
                </div>
              ) : null}
            </aside>
          </div>
        )}
      </main>

      {/* bottom nav on mobile */}
      <nav
        className="safe-bottom order-3 flex shrink-0 items-center justify-around border-t bg-background px-2 py-1 md:hidden"
      >
        <Button variant="ghost" size="sm" onClick={() => setRailOpen((v) => !v)}>
          <MessageSquareText className="size-4" />
          <span className="text-[11px]">Chats</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDrawer("jobs")}>
          <Briefcase className="size-4" />
          <span className="text-[11px]">Jobs</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDrawer("files")}>
          <FileCode2 className="size-4" />
          <span className="text-[11px]">Files</span>
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setDrawer("config")}>
          <Settings className="size-4" />
          <span className="text-[11px]">Config</span>
        </Button>
      </nav>

      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        onRun={runCommand}
      />
    </div>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}
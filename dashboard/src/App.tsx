import {
  Briefcase,
  CloudOff,
  Command as CommandIcon,
  FileCode2,
  Gauge,
  History,
  LogOut,
  MessageSquareText,
  Search,
  Settings,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { CommandPalette } from "@/components/CommandPalette";
import { DEFAULT_SUGGESTIONS } from "@/components/GreetingState";
import { Logo } from "@/components/logo";
import { NotificationBell } from "@/components/NotificationBell";
import { PresenceIndicator } from "@/components/Presence";
import { ThemeToggle } from "@/components/ThemeToggle";
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
import { useNotificationPref } from "@/lib/useNotificationPref";
import { useNotifications } from "@/lib/useNotifications";
import { cn } from "@/lib/utils";
import { DashboardSocket } from "@/lib/ws";
import { ChatView, type ChatMessage } from "@/views/ChatView";
import { ConfigView } from "@/views/ConfigView";
import { FilesView } from "@/views/FilesView";
import { JobsView } from "@/views/JobsView";
import { PairView } from "@/views/PairView";
import { SessionsView } from "@/views/SessionsView";
import { StatusView } from "@/views/StatusView";

export type { ChatMessage } from "@/views/ChatView";

/** Navigation is tab-style: picking a section swaps the main content area
 *  (spec §A). Chat is the default; the rest are peer sections, not drawers. */
export type Section = "chat" | "sessions" | "files" | "jobs" | "config" | "status";

const SECTIONS: { id: Section; label: string; icon: typeof Gauge; mobile?: boolean }[] = [
  { id: "chat", label: "Chat", icon: MessageSquareText, mobile: true },
  { id: "sessions", label: "Sessions", icon: History, mobile: true },
  { id: "files", label: "Files", icon: FileCode2, mobile: true },
  { id: "jobs", label: "Jobs", icon: Briefcase, mobile: true },
  { id: "config", label: "Config", icon: Settings, mobile: true },
  { id: "status", label: "Status", icon: Gauge },
];

const SECTION_IDS = new Set<string>(SECTIONS.map((s) => s.id));

/** Map a notification frame's `tab` onto a real section; unknown tabs are
 *  ignored rather than blanking the main area. */
function toSection(tab: string | undefined | null): Section | null {
  if (!tab) return null;
  return SECTION_IDS.has(tab) ? (tab as Section) : null;
}

function AppInner() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [section, setSection] = useState<Section>("chat");
  const [transcriptKey, setTranscriptKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [reaction, setReaction] = useState<ReactionState>("done");
  const [openFile, setOpenFile] = useState<string | null>(null);
  const [unread, setUnread] = useState<Partial<Record<Section, number>>>({});
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [commands, setCommands] = useState<SlashCommand[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [socket, setSocket] = useState<DashboardSocket | null>(null);
  const socketRef = useRef<DashboardSocket | null>(null);
  const lastUserMessageRef = useRef<string>("");
  const sectionRef = useRef<Section>("chat");
  const busyRef = useRef(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  sectionRef.current = section;

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
          setSection("jobs");
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

  const { loading: loadingHistory, error: historyError } = useLastSession(
    authed === true,
    setMessages,
  );

  // Tab navigation: swap the main area and clear that section's unread badge.
  const selectSection = useCallback((next: Section) => {
    setSection((prev) => (prev === next ? prev : next));
    setUnread((prev) => ({ ...prev, [next]: 0 }));
    setRailOpen(false);
  }, []);

  const { notifications, unreadIds, markAllRead, markRead } = useNotifications(socket, {
    navigateTo: (tab) => {
      const target = toSection(tab);
      if (target) selectSection(target);
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
      const t = toSection(n.payload.tab);
      if (t && t !== sectionRef.current) {
        setUnread((prev) => ({ ...prev, [t]: (prev[t] ?? 0) + 1 }));
      }
    });

    const unsubscribe = socket.onMessage((m) => {
      // Accept only the dashboard console pair. The previous `||`-style check
      // let ANY chatId named "console" and ANY dashboard chat through.
      if (m.channel !== "dashboard" || m.chatId !== "console") return;

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

  const handleOpenFile = useCallback(
    (path: string) => {
      setOpenFile(path);
      selectSection("files");
    },
    [selectSection],
  );

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
      selectSection("chat");
      void handleSend(command);
    },
    [handleSend, selectSection],
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
    <div
      className="standalone-fix flex min-h-dvh flex-col overflow-hidden md:h-dvh md:flex-row"
      data-testid="app-shell"
    >
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

        <nav className="space-y-0.5 px-2" data-testid="section-nav">
          {SECTIONS.map(({ id, label, icon: Icon }) => (
            <Button
              key={id}
              variant={section === id ? "secondary" : "ghost"}
              size="sm"
              onClick={() => {
                setTranscriptKey(null);
                selectSection(id);
              }}
              aria-current={section === id ? "page" : undefined}
              data-testid={`nav-${id}`}
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

        {/* Recent conversations were removed (spec §B): the rail is logo,
            Search, and section nav. Sessions live in the Sessions tab now. */}
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
          <NotificationBell
            enabled={notificationsEnabled ?? false}
            onEnabledChange={setNotificationsEnabled}
            notifications={notifications}
            unreadIds={unreadIds}
            onMarkAllRead={markAllRead}
            onMarkRead={markRead}
            onNavigate={(tab) => {
              const target = toSection(tab);
              if (target) selectSection(target);
            }}
          />
          <ThemeToggle />

          <div className="hidden items-center gap-2 md:flex">
            {/* Not a dead label: the session this surface is talking to. */}
            <span
              className="max-w-[12rem] truncate font-mono text-[11px] text-muted-foreground"
              title={transcriptKey ?? DASHBOARD_SESSION_KEY}
              data-testid="session-badge"
            >
              {transcriptKey ?? DASHBOARD_SESSION_KEY}
            </span>
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

        {/* Tab-style main area: activating a section swaps this region. */}
        <div className="min-h-0 flex-1 overflow-hidden" data-testid="main-content">
          {section === "chat" && (
            <>
              {historyError && (
                <div
                  data-testid="history-error"
                  className="flex items-center gap-2 border-b border-border bg-destructive/10 px-4 py-1.5 text-xs text-destructive"
                >
                  <CloudOff className="size-3.5 shrink-0" />
                  <span>
                    Could not load conversation history: {historyError}
                  </span>
                </div>
              )}
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
            </>
          )}

          {section === "sessions" && (
            <SessionsView sessions={sessions} initialKey={transcriptKey} />
          )}

          {section === "files" && (
            <div className="h-full overflow-y-auto">
              <FilesView initialFile={openFile} />
            </div>
          )}

          {section === "jobs" && (
            <div className="h-full">
              <JobsView />
            </div>
          )}

          {section === "config" && (
            <div className="h-full overflow-y-auto">
              <ConfigView />
            </div>
          )}

          {section === "status" && (
            <div className="h-full overflow-y-auto">
              <StatusView onLoggedOut={logout} />
            </div>
          )}
        </div>
      </main>

      {/* bottom nav on mobile */}
      <nav
        className="safe-bottom order-3 flex shrink-0 items-center justify-around border-t bg-background px-2 py-1 md:hidden"
        data-testid="mobile-section-nav"
      >
        {SECTIONS.filter((s) => s.mobile).map(({ id, label, icon: Icon }) => (
          <Button
            key={id}
            variant="ghost"
            size="sm"
            onClick={() => {
              setTranscriptKey(null);
              selectSection(id);
            }}
            aria-current={section === id ? "page" : undefined}
            className={cn(section === id && "bg-accent text-accent-foreground")}
          >
            <Icon className="size-4" />
            <span className="text-[11px]">{label}</span>
          </Button>
        ))}
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
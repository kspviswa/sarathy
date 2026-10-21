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
  Sparkles,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { CommandPalette } from "@/components/CommandPalette";
import { DEFAULT_SUGGESTIONS } from "@/components/GreetingState";
import { Logo } from "@/components/logo";
import { NotificationControls } from "@/components/NotificationControls";
import { PresenceIndicator } from "@/components/Presence";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { api, AuthError, clearToken, getToken } from "@/lib/api";
import { setActiveAskThreadId, subscribeAskHistoryRequest } from "@/lib/ask";
import { toSection, type NavSection } from "@/lib/navigation";
import type { SlashCommand } from "@/lib/palette";
import type { Quote } from "@/lib/quotes";
import {
  nextReaction,
  reactionFrameFrom,
  startTurn,
  type ReactionState,
} from "@/lib/reactions";
import { applyOutbound } from "@/lib/transcript";
import {
  attachTurnSync,
  beginOptimisticTurn,
  endTurnLocal,
  noteMessageFrame,
  useTurn,
} from "@/lib/turn";
import { ThemeProvider } from "@/lib/theme";
import type { SessionInfo } from "@/lib/types";
import { DASHBOARD_SESSION_KEY, resetLastSession, useLastSession } from "@/lib/useLastSession";
import { useNotificationPref } from "@/lib/useNotificationPref";
import { useNotifications } from "@/lib/useNotifications";
import type { AppNotification } from "@/lib/useNotifications";
import { cn } from "@/lib/utils";
import { DashboardSocket } from "@/lib/ws";
import { AskView } from "@/views/AskView";
import { ChatView, type ChatMessage } from "@/views/ChatView";
import { FilesView } from "@/views/FilesView";
import { JobsView } from "@/views/JobsView";
import { PairView } from "@/views/PairView";
import { SessionsView } from "@/views/SessionsView";
import { SettingsView, type SettingsSegment } from "@/views/SettingsView";

export type { ChatMessage } from "@/views/ChatView";

/** Navigation is tab-style: picking a section swaps the main content area
 *  (spec §A). Chat is the default; the rest are peer sections, not drawers.
 *
 *  Config and Status merged into ONE `settings` section (spec §B). */
export type Section = NavSection;

const SECTIONS: { id: Section; label: string; icon: typeof Gauge; mobile?: boolean }[] = [
  { id: "chat", label: "Chat", icon: MessageSquareText, mobile: true },
  { id: "ask", label: "Ask", icon: Sparkles, mobile: true },
  { id: "sessions", label: "Sessions", icon: History, mobile: true },
  { id: "files", label: "Files", icon: FileCode2, mobile: true },
  { id: "jobs", label: "Jobs", icon: Briefcase, mobile: true },
  { id: "settings", label: "Settings", icon: Settings, mobile: true },
];

function AppInner() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [section, setSection] = useState<Section>("chat");
  const [settingsSegment, setSettingsSegment] = useState<SettingsSegment>("form");
  const [transcriptKey, setTranscriptKey] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  /**
   * Notification text handed to the composer by "Reply" (spec 126 §D). The
   * nonce changes per Reply so the same notification twice re-seeds the composer.
   */
  const [followUpSeed, setFollowUpSeed] = useState<{
    text: string;
    nonce: number;
  } | null>(null);
  // `streaming` is DERIVED from the server-owned turn state (spec 127 §C.1) —
  // both SPAs read it from the shared module so a missed terminal frame can no
  // longer strand the spinner/Stop button.
  const { streaming } = useTurn();
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

  // The Ask canvas's history button asks for the Sessions surface (job 150
  // §C): the Ask history lives there, behind its `Chats / Asks` switch.
  useEffect(
    () => subscribeAskHistoryRequest(() => selectSection("sessions")),
    [selectSection],
  );

  /**
   * Where a notification frame (or an old link) wants to go.
   *
   * `config` and `status` are the OLD ids of the two surfaces that merged
   * into Settings: they land on the segment they used to be. An unknown id
   * is ignored — it must never blank the main area.
   */
  const navigate = useCallback(
    (tab: string | undefined | null) => {
      const target = toSection(tab);
      if (!target) return;
      if (target.section === "settings") {
        setSettingsSegment(target.settingsSegment ?? "form");
      }
      selectSection(target.section);
    },
    [selectSection],
  );

  const { notifications, unreadIds, markAllRead, markRead } = useNotifications(socket, {
    navigateTo: (tab) => navigate(tab),
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
      if (t && t.section !== sectionRef.current) {
        setUnread((prev) => ({ ...prev, [t.section]: (prev[t.section] ?? 0) + 1 }));
      }
    });

    const unsubscribe = socket.onMessage((m) => {
      // Accept only the dashboard console pair. The previous `||`-style check
      // let ANY chatId named "console" and ANY dashboard chat through.
      if (m.channel !== "dashboard" || m.chatId !== "console") return;

      const md = (m.metadata || {}) as Record<string, unknown>;

      // Keep the shared turn state in lockstep with the transcript: this is
      // what derives `streaming` (spec 127 §C.1).
      noteMessageFrame(m);

      // Fold every streamed frame into the reaction state machine.
      const frame = reactionFrameFrom(m.metadata);
      if (frame) setReaction((prev) => nextReaction(prev, frame));

      // Out-of-band command acks (/stop, /steer, /btw) are their own message and
      // must not disturb the running turn's bubble.
      if (md._notice) {
        setMessages((prev) => applyOutbound(prev, m));
        return;
      }

      if (md._final) {
        setMessages((prev) => applyOutbound(prev, m));
        refreshSessions();
        return;
      }

      setMessages((prev) => applyOutbound(prev, m));
    });

    // Reconcile server turn state on (re)connect and on tab resume (spec §C.2/§C.3).
    const detachTurn = attachTurnSync(socket);

    socket.connect();
    return () => {
      detachTurn();
      unsubNotif();
      unsubscribe();
      socket.disconnect();
      socketRef.current = null;
      setSocket(null);
    };
  }, [authed, refreshSessions]);

  // A missed `_final` no longer strands the reaction chip either: whenever the
  // server says the turn is not streaming, drop a live reaction to done.
  useEffect(() => {
    if (streaming) return;
    setReaction((prev) =>
      prev === "queued" || prev === "working" || prev === "thinking" || prev === "tool"
        ? "done"
        : prev,
    );
  }, [streaming]);

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
      beginOptimisticTurn();
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
      endTurnLocal();
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

  /**
   * "Reply" on a notification (spec 126 §D).
   *
   * Quotes the notification into the CURRENT console session: the item lands as
   * a quote chip on the composer and the reply is added as the next turn of the
   * conversation already open. The quote travels with the next message as
   * `quotes`, so the notification is genuine prior context the model can read.
   *
   * It deliberately does NOT archive the session or start a new one — replying
   * is a continuation of what the user was doing, and silently throwing the
   * live session away (the old behavior) lost that context.
   *
   * Nothing is sent on the user's behalf: the chip is placed and the composer
   * focused, so they write the actual question.
   */
  const handleNotificationReply = useCallback(
    (n: AppNotification) => {
      setFollowUpSeed({
        text: [n.title, n.body].filter(Boolean).join("\n"),
        nonce: Date.now(),
      });
      selectSection("chat");
    },
    [selectSection],
  );

  /** The seed is one-shot: ChatView reports it applied so it can't re-inject. */
  const clearFollowUpSeed = useCallback(() => setFollowUpSeed(null), []);

  /**
   * "Open as new thread" from the Sessions tab (job 132 §C).
   *
   * Carries a past conversation's last question into the composer as a quote
   * chip — the same seeding path a notification "Reply" uses — so the model
   * reads it as genuine prior context. Nothing is sent on the user's behalf,
   * and the live session is NOT archived: they may be mid-conversation here.
   */
  const handleOpenThread = useCallback(
    (text: string) => {
      if (!text.trim()) return;
      setFollowUpSeed({ text, nonce: Date.now() });
      selectSection("chat");
    },
    [selectSection],
  );

  /**
   * Open an Ask research thread in the Ask canvas (spec §C).
   *
   * The Asks list lives in Sessions, the thread lives in the Ask canvas — the
   * pointer between them is the shared module, so the canvas restores the
   * thread (its turns, its sources and its research timeline) when it mounts.
   */
  const handleOpenAskThread = useCallback(
    (threadId: string) => {
      setActiveAskThreadId(threadId);
      selectSection("ask");
    },
    [selectSection],
  );

  const handleStop = useCallback(async () => {
    await api.stopChat();
    endTurnLocal();
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
    beginOptimisticTurn();
    setReaction(startTurn());
    await api.sendChat(lastUserMsg);
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
          // safe-top: the rail spans the full viewport height at md+, so on
          // iPad/notch devices its top row collided with the status bar.
          "safe-top safe-bottom order-2 flex shrink-0 flex-col overflow-y-auto border-t bg-background md:order-1 md:w-64 md:border-r md:border-t-0",
          railOpen ? "flex" : "hidden md:flex",
        )}
        data-testid="left-rail"
      >
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
              /* Job 132 §E: the pill eases between states and the active marker
                 grows in beside it. `motion-reduce` drops the transition for
                 users who ask for reduced motion. */
              className={cn(
                "relative w-full justify-start transition-[background-color,color,transform] duration-200 ease-out motion-reduce:transition-none",
                section === id && "scale-[0.99]",
              )}
            >
              <span
                aria-hidden="true"
                data-testid={`nav-indicator-${id}`}
                className={cn(
                  "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-primary transition-all duration-200 ease-out motion-reduce:transition-none",
                  section === id ? "scale-y-100 opacity-100" : "scale-y-50 opacity-0",
                )}
              />
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

        {/* Branding sits at the BOTTOM (spec 125 §C2), below the nav's Status
            button: the mascot + title used to collide with the safe area up
            top, and the space below the nav was dead anyway. `mt-auto` pins it
            to the bottom of whatever height the rail has. */}
        <div
          className="mt-auto hidden items-center gap-3 border-t border-border/60 px-4 py-5 md:flex"
          data-testid="rail-branding"
        >
          <Logo size={44} />
          <div className="flex min-w-0 flex-col">
            <span className="truncate text-lg font-bold tracking-tight">Sarathy</span>
            <span className="truncate text-[11px] text-muted-foreground">
              Viswa's AI assistant
            </span>
          </div>
        </div>

        {/* Recent conversations were removed (spec §B): the rail is Search,
            section nav, and the branding block. Sessions live in the Sessions
            tab now. */}
      </aside>

      {/* ---------------------------------------------------------------- main */}
      <main className="order-1 flex min-h-0 flex-1 flex-col md:order-2">
        {/* top bar */}
        {/* One line at every width, same discipline as the mobile header: the
            row never wraps and labels drop to icons as space runs out. At the
            `md` breakpoint the rail claims ~180px, so a 768px viewport leaves
            only ~590px for this bar — "Notifications" used to wrap one letter
            per line and blow the header up to 181px. */}
        <header
          className="safe-top flex flex-nowrap items-center gap-2 border-b bg-background/80 px-3 py-2 backdrop-blur"
          data-testid="desktop-header"
        >
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
            className="hidden shrink-0 text-muted-foreground sm:inline-flex"
            aria-label="Search commands"
            title="Search commands (⌘K)"
          >
            <Search className="size-3.5" />
            <span className="hidden text-xs lg:inline">Search commands…</span>
            <kbd className="ml-2 hidden rounded border border-border px-1 text-[10px] lg:inline">⌘K</kbd>
          </Button>

          <div className="min-w-0 flex-1" />

          <PresenceIndicator state={reaction} />
          <NotificationControls
            enabled={notificationsEnabled}
            onEnabledChange={setNotificationsEnabled}
            notifications={notifications}
            unreadIds={unreadIds}
            onMarkAllRead={markAllRead}
            onMarkRead={markRead}
            onNavigate={(tab) => navigate(tab)}
            onReply={(n) => void handleNotificationReply(n)}
          />
          <ThemeToggle />

          <div className="hidden items-center gap-2 md:flex">
            {/* Not a dead label: the session this surface is talking to. */}
            <span
              className="hidden max-w-[12rem] truncate font-mono text-[11px] text-muted-foreground lg:inline"
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

        {/* Tab-style main area: activating a section swaps this region. `key`
            re-mounts it per section so the entry transition (job 132 §E) runs
            on every switch instead of only the first paint. */}
        <div
          key={section}
          className="section-in min-h-0 flex-1 overflow-hidden"
          data-testid="main-content"
        >
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
                followUpSeed={followUpSeed}
                onFollowUpSeedConsumed={clearFollowUpSeed}
              />
            </>
          )}

          {section === "ask" && (
            <div className="h-full overflow-y-auto">
              <AskView />
            </div>
          )}

          {section === "sessions" && (
            <SessionsView
              initialKey={transcriptKey}
              onOpenThread={handleOpenThread}
              onOpenAskThread={handleOpenAskThread}
            />
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

          {section === "settings" && (
            <SettingsView
              segment={settingsSegment}
              onSegmentChange={setSettingsSegment}
              onLoggedOut={logout}
              variant="desktop"
            />
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
            /* Job 132 §E — the active pill eases in, reduced-motion aware. */
            className={cn(
              "transition-[background-color,color,transform] duration-200 ease-out motion-reduce:transition-none",
              section === id && "scale-95 bg-accent text-accent-foreground",
            )}
            data-testid={`mobile-nav-${id}`}
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
import {
  Briefcase,
  ChevronLeft,
  ChevronRight,
  CloudOff,
  Command as CommandIcon,
  FileCode2,
  History,
  MessageSquareText,
  Settings,
  Sparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { CommandPalette } from "@/components/CommandPalette";
import { Logo } from "@/components/logo";
import { NotificationControls } from "@/components/NotificationControls";
import { ThemeToggle } from "@/components/ThemeToggle";
import { Button } from "@/components/ui/button";
import { api, AuthError, clearToken, getToken } from "@/lib/api";
import { setActiveAskThreadId, subscribeAskHistoryRequest } from "@/lib/ask";
import { toSection } from "@/lib/navigation";
import type { Quote } from "@/lib/quotes";
import type { SlashCommand } from "@/lib/palette";
import { ThemeProvider } from "@/lib/theme";
import { useLastSession, resetLastSession, DASHBOARD_SESSION_KEY } from "@/lib/useLastSession";
import { applyOutbound } from "@/lib/transcript";
import {
  attachTurnSync,
  beginOptimisticTurn,
  endTurnLocal,
  noteMessageFrame,
  useTurn,
} from "@/lib/turn";
import { useNotificationPref } from "@/lib/useNotificationPref";
import { useNotifications, type AppNotification } from "@/lib/useNotifications";
import { DashboardSocket } from "@/lib/ws";
import type { ChatMessage as ChatMessageT } from "@/views/ChatView";
import { PairView } from "@/views/PairView";
import { SettingsView, type SettingsSegment } from "@/views/SettingsView";
import { cn } from "@/lib/utils";
import { AskView } from "./AskView";
import { ChatView } from "./ChatView";
import { FilesView } from "./FilesView";
import { JobsView } from "./JobsView";
import { SessionsView } from "./SessionsView";

/**
 * The mobile shell carries SIX tabs (spec §A, Viswa's correction):
 * **Chat · Ask · Jobs · Settings · Sessions · Files**.
 *
 * Nothing is dropped. The bar is a horizontally scrollable strip, so the four
 * primary tabs fill the first viewport and the two secondary ones are reached
 * with the `>` affordance on the right edge.
 *
 * Config and Status merged into ONE Settings tab (spec §B) — Status is a
 * segment of the Settings surface, not a tab of its own.
 */
type Tab = "chat" | "ask" | "jobs" | "settings" | "sessions" | "files";

const TABS: { id: Tab; label: string; icon: typeof MessageSquareText }[] = [
  { id: "chat", label: "Chat", icon: MessageSquareText },
  { id: "ask", label: "Ask", icon: Sparkles },
  { id: "jobs", label: "Jobs", icon: Briefcase },
  { id: "settings", label: "Settings", icon: Settings },
  { id: "sessions", label: "Sessions", icon: History },
  { id: "files", label: "Files", icon: FileCode2 },
];

/** The Files sheet: closed, or open at a path (`null` = the workspace root). */
interface FilesSheet {
  open: boolean;
  path: string | null;
}

function MobileAppInner() {
  const [authed, setAuthed] = useState<boolean | null>(null);
  const [tab, setTab] = useState<Tab>("chat");
  const [settingsSegment, setSettingsSegment] = useState<SettingsSegment>("form");
  const [messages, setMessages] = useState<ChatMessageT[]>([]);
  // `streaming` is DERIVED from the server-owned turn state (spec 127 §C.1) via
  // the shared module, so a missed terminal frame no longer strands the UI.
  const { streaming } = useTurn();
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

  // The Sessions drawer and the Files sheet (spec §A).
  //
  // They are NOT the only route any more — Sessions and Files are tabs again
  // (Viswa: *"I didn't ask you to drop anything"*) — they stay as extra
  // shortcuts: the Chat header's History button and the attachment picker's
  // "Browse workspace files" row.
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [filesSheet, setFilesSheet] = useState<FilesSheet>({ open: false, path: null });

  // The scrollable tab strip (spec §A). The strip carries EVERY tab; the
  // `>` affordance on the right edge scrolls it to the ones that do not fit.
  //
  // The element is state, not just a ref: the strip is only mounted once the
  // shell is authenticated, so the listeners have to attach when it APPEARS.
  const [tabStrip, setTabStrip] = useState<HTMLDivElement | null>(null);
  const tabButtonRefs = useRef<Partial<Record<Tab, HTMLButtonElement | null>>>({});
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  // Handle token in URL (for deep links from Telegram, etc.)
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get("token");
    if (token) {
      localStorage.setItem("sarathy_token", token);
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, []);

  /**
   * Deep links: `#/jobs/<id>` and `#/files/<path>`.
   *
   * Files is a tab again (spec §A), so the deep link switches to the Files
   * tab and opens the file it names.
   */
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
        return;
      }
      if (hash.startsWith("#/files/")) {
        const path = decodeURIComponent(hash.slice("#/files/".length));
        setOpenFile(path || null);
        setTab("files");
      }
    };

    handleHashChange();
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

  // Escape closes the drawer and the sheet.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setSessionsOpen(false);
      setFilesSheet((prev) => ({ ...prev, open: false }));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The Ask canvas's history button asks for the Sessions surface (job 150
  // §C): the Ask history lives there, behind its `Chats / Asks` switch.
  useEffect(
    () =>
      subscribeAskHistoryRequest(() => {
        setTab("sessions");
        setSessionsOpen(false);
      }),
    [],
  );

  // Commands for the palette + `/` autocomplete, sourced from the backend
  // (parity with the desktop App: the registry is the single source of truth).
  const refreshCommands = useCallback(async () => {
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

  /**
   * Where a notification frame (or an old link) wants to go.
   *
   * `sessions` and `files` are TABS again (spec §A), so they land on the tab.
   * `config` and `status` are the OLD ids of the two surfaces that merged
   * into Settings — they land on the segment they used to be. An unknown id
   * is ignored: it must never blank the app.
   */
  const navigate = useCallback((tabId: string | undefined | null) => {
    const target = toSection(tabId);
    if (!target) return;

    if (target.section === "settings") {
      setSettingsSegment(target.settingsSegment ?? "form");
      setTab("settings");
      return;
    }
    if (target.section === "chat") setTab("chat");
    else if (target.section === "ask") setTab("ask");
    else if (target.section === "jobs") setTab("jobs");
    else if (target.section === "sessions") setTab("sessions");
    else if (target.section === "files") setTab("files");
  }, []);

  const { notifications, unreadIds, markAllRead, markRead, remove, clearAll } =
    useNotifications(socket, {
      navigateTo: (tabId) => navigate(tabId),
      onMarkAllRead: () => setUnread({}),
    });

  /* ------------------------------------------------------------------ *
   * The scrollable tab strip (spec §A)
   *
   * Six tabs do not fit a 390px screen, so the bar SCROLLS. The `>`
   * affordance on the right edge scrolls it to the tabs that are off
   * screen; once the end is reached the same control flips to `<` and
   * scrolls back. The direction is derived from the scroll position —
   * one button, never two.
   * ------------------------------------------------------------------ */

  /** Can the strip still scroll further right / is it scrolled off the left? */
  const measureStrip = useCallback(() => {
    const el = tabStrip;
    if (!el) return;
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    setCanScrollLeft(el.scrollLeft > 0);
  }, [tabStrip]);

  // Measure on mount, on resize and on scroll (spec §A). The scroll handler
  // is rAF-throttled so a fling does not thrash React with a state update per
  // frame.
  useEffect(() => {
    const el = tabStrip;
    if (!el) return;

    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measureStrip();
      });
    };

    measureStrip();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", measureStrip);

    let observer: ResizeObserver | undefined;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => measureStrip());
      observer.observe(el);
    }

    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", measureStrip);
      observer?.disconnect();
    };
  }, [tabStrip, measureStrip]);

  /**
   * The ACTIVE tab always scrolls into view — by tap, by a notification
   * frame, by a deep link or by `navigate()`. Picking Sessions from the
   * Asks list must not leave the bar showing Chat.
   */
  useLayoutEffect(() => {
    const button = tabButtonRefs.current[tab];
    if (button && typeof button.scrollIntoView === "function") {
      button.scrollIntoView({ inline: "nearest", block: "nearest" });
    }
    // The strip's geometry changed (a different tab may be wider, the window
    // may have been resized) — re-measure so the affordance stays honest.
    measureStrip();
  }, [tab, tabStrip, measureStrip]);

  /** The `>` / `<` affordance: scroll by ~0.7 viewport, then re-evaluate. */
  const handleScrollTabs = useCallback(() => {
    const el = tabStrip;
    if (!el) return;
    const delta = el.clientWidth * 0.7;
    if (canScrollRight) el.scrollBy({ left: delta, behavior: "smooth" });
    else el.scrollBy({ left: -delta, behavior: "smooth" });
    // `scrollBy` is smooth, so the position settles a frame later; measure
    // again straight away AND on the scroll event that follows.
    measureStrip();
  }, [tabStrip, canScrollRight, measureStrip]);



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
    if (authed !== true) return;
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
      const md = (m.metadata || {}) as Record<string, unknown>;

      // Keep the shared turn state in lockstep with the transcript (spec §C.1).
      noteMessageFrame(m);

      // Out-of-band command acks (/stop, /steer, /btw): their own bubble.
      if (md._notice) {
        setMessages((prev) => applyOutbound(prev, m));
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
      beginOptimisticTurn();
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
   * App. Quotes the notification into the CURRENT console session (the item
   * becomes a quote chip on the composer and the reply is added as the next
   * turn of the open conversation); it does NOT archive the session or start a
   * new one. Nothing is sent on the user's behalf.
   */
  const handleNotificationReply = useCallback((n: AppNotification) => {
    setFollowUpSeed({
      text: [n.title, n.body].filter(Boolean).join("\n"),
      nonce: Date.now(),
    });
    setTab("chat");
  }, []);

  /** The seed is one-shot: ChatView reports it applied so it can't re-inject. */
  const clearFollowUpSeed = useCallback(() => setFollowUpSeed(null), []);

  /**
   * "Open as new thread" from the Sessions list (job 132 §C) — carries a past
   * conversation's last question into the composer as a quote chip, exactly as
   * a notification "Reply" does. Nothing is sent on the user's behalf.
   */
  const handleOpenThread = useCallback((text: string) => {
    if (!text.trim()) return;
    setFollowUpSeed({ text, nonce: Date.now() });
    setTab("chat");
    setSessionsOpen(false);
  }, []);

  /**
   * Open an Ask research thread in the Ask canvas (spec §C).
   */
  const handleOpenAskThread = useCallback((threadId: string) => {
    setActiveAskThreadId(threadId);
    setTab("ask");
    setSessionsOpen(false);
  }, []);

  const handleNewChat = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await api.sessionNew(DASHBOARD_SESSION_KEY);
      resetLastSession();
      setMessages([]);
      endTurnLocal();
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
    endTurnLocal();
  }, []);

  /** A file link in a chat message opens the Files tab at that path. */
  const handleOpenFile = useCallback((path: string) => {
    setOpenFile(path);
    setTab("files");
  }, []);

  const handleRegenerate = useCallback(async () => {
    const lastUserMsg = lastUserMessageRef.current;
    if (!lastUserMsg || streaming) return;
    setMessages((prev) => [...prev, { role: "user", content: lastUserMsg }]);
    beginOptimisticTurn();
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
      {/* Single line at every width: the brand shrinks (min-w-0 + truncate) and
          the controls never wrap. The "Commands" label is icon-only here — on a
          390px screen the word plus the old "Mobile" tag pushed the row onto a
          second line. */}
      <header
        className="flex flex-nowrap items-center justify-between gap-2 border-b bg-background/90 px-3 py-2 backdrop-blur"
        data-testid="mobile-header"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Logo size={22} />
          <span className="truncate font-bold tracking-tight">Sarathy</span>
        </div>
        <div className="flex shrink-0 items-center gap-1 text-xs text-muted-foreground">
          <button
            onClick={() => setPaletteOpen(true)}
            className="inline-flex size-9 items-center justify-center rounded-lg transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Commands"
            title="Commands"
            data-testid="mobile-commands-trigger"
          >
            <CommandIcon className="size-4" />
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
            onNavigate={(tabId) => navigate(tabId)}
          />
          <ThemeToggle compact />
        </div>
      </header>

      {/* `key` re-mounts the content area per tab so the entry transition
          (job 132 §E) runs on every switch, not only the first paint. */}
      <main key={tab} className="section-in min-h-0 flex-1 overflow-y-auto">
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
              onFollowUpSeedConsumed={clearFollowUpSeed}
              onOpenSessions={() => setSessionsOpen(true)}
              onBrowseFiles={() => setFilesSheet({ open: true, path: null })}
            />
          </>
        )}
        {tab === "ask" && <AskView />}
        {tab === "jobs" && <JobsView />}
        {tab === "sessions" && (
          <div className="h-full overflow-hidden">
            <SessionsView
              onOpenThread={handleOpenThread}
              onOpenAskThread={handleOpenAskThread}
            />
          </div>
        )}
        {tab === "files" && (
          <div className="h-full overflow-hidden">
            <FilesView initialFile={openFile} />
          </div>
        )}
        {tab === "settings" && (
          <SettingsView
            segment={settingsSegment}
            onSegmentChange={setSettingsSegment}
            onLoggedOut={logout}
            variant="mobile"
          />
        )}
      </main>

      {/* ------------------------------------------------- Sessions drawer */}
      {sessionsOpen && (
        <div className="fixed inset-0 z-40" data-testid="mobile-sessions-drawer">
          <button
            type="button"
            aria-label="Close sessions"
            data-testid="mobile-sessions-drawer-scrim"
            onClick={() => setSessionsOpen(false)}
            className="absolute inset-0 h-full w-full bg-black/60"
          />
          <div
            className="absolute inset-y-0 left-0 flex w-[88%] max-w-sm flex-col bg-background shadow-xl"
            data-testid="mobile-sessions-drawer-panel"
          >
            <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
              <h2 className="text-base font-semibold">Sessions</h2>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Close sessions"
                onClick={() => setSessionsOpen(false)}
              >
                <X className="size-4" />
              </Button>
            </div>
            <div className="min-h-0 flex-1 overflow-hidden">
              <SessionsView
                onOpenThread={handleOpenThread}
                onOpenAskThread={handleOpenAskThread}
              />
            </div>
          </div>
        </div>
      )}

      {/* ----------------------------------------------------- Files sheet */}
      {filesSheet.open && (
        <div
          className="fixed inset-0 z-40 flex flex-col bg-background"
          data-testid="mobile-files-sheet"
        >
          <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
            <h2 className="flex items-center gap-2 text-base font-semibold">
              <FileCode2 className="size-4" />
              Files
            </h2>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Close files"
              onClick={() => setFilesSheet({ open: false, path: null })}
            >
              <X className="size-4" />
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden">
            <FilesView initialFile={filesSheet.path ?? openFile} />
          </div>
        </div>
      )}

      {/* ------------------------------------------------------------ tab bar
          A horizontally scrollable strip carrying EVERY tab (spec §A).
          Six tabs do not fit a phone, so the bar scrolls instead of dropping
          anything; the `>` affordance on the right edge reveals the rest. */}
      <nav
        className="safe-bottom relative flex shrink-0 items-stretch border-t bg-background px-1 pb-2"
        data-testid="mobile-tabbar"
      >
        <div
          ref={setTabStrip}
          className="no-scrollbar flex flex-nowrap items-stretch overflow-x-auto scroll-smooth [-webkit-overflow-scrolling:touch]"
          data-testid="mobile-tabbar-scroll"
        >
          {TABS.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              ref={(el) => {
                tabButtonRefs.current[id] = el;
              }}
              aria-label={label}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => {
                setTab(id);
                setUnread((prev) => ({ ...prev, [id]: 0 }));
              }}
              /* Job 132 §E: the selected tab eases into place (the icon
               scales, the label fades up); reduced-motion aware.
               The min-width keeps a label from being squeezed — and it is
               what makes the FIRST viewport hold exactly the four primary
               tabs on a 390px screen. */
              className={cn(
                "relative flex min-w-[5.75rem] flex-col items-center gap-0.5 rounded-lg px-1 py-2 transition-colors duration-200 ease-out motion-reduce:transition-none",
                tab === id ? "text-primary" : "text-muted-foreground",
              )}
              data-testid={`mobile-tab-${id}`}
            >
              <span className="relative">
                {unread[id] ? (
                  <span className="absolute -right-2 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold text-destructive-foreground">
                    {unread[id]}
                  </span>
                ) : null}
                <Icon
                  className={cn(
                    "size-6 transition-transform duration-200 ease-out motion-reduce:transition-none",
                    tab === id && "scale-110",
                  )}
                />
              </span>
              <span
                className={cn(
                  "text-[10px] font-medium transition-opacity duration-200 ease-out motion-reduce:transition-none",
                  tab === id ? "opacity-100" : "opacity-70",
                )}
              >
                {label}
              </span>
            </button>
          ))}
          {/* Trailing spacer: it lets the LAST tab scroll clear of the
              affordance, so no tab is ever stranded under the chevron. */}
          <div className="w-10 shrink-0" aria-hidden="true" />
        </div>

        {/* The overflow affordance: ONE button, direction derived from the
            scroll position. `>` while there is more to the right, `<` once the
            end is reached, gone when there is nothing to scroll. The gradient
            fade keeps the labels from colliding with it. */}
        {(canScrollRight || canScrollLeft) && (
          <button
            type="button"
            aria-label={canScrollRight ? "Scroll tabs right" : "Scroll tabs left"}
            title={canScrollRight ? "Scroll tabs right" : "Scroll tabs left"}
            onClick={handleScrollTabs}
            data-testid="mobile-tab-scroll"
            className="absolute right-0 top-0 bottom-0 flex items-center bg-gradient-to-l from-background via-background/70 to-transparent pl-3"
          >
            <span className="flex size-6 items-center justify-center rounded-full border border-border bg-background/90 text-muted-foreground shadow-sm">
              {canScrollRight ? (
                <ChevronRight className="size-4" />
              ) : (
                <ChevronLeft className="size-4" />
              )}
            </span>
          </button>
        )}
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

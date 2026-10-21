import {
  Check,
  Copy,
  FolderTree,
  History,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  Reply as ReplyIcon,
  RotateCcw,
  Send,
  Square,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { Logo } from "@/components/logo";
import { MarkdownBubble } from "@/components/MarkdownBubble";
import {
  QuoteActionBar,
  QuoteChips,
  useTextSelection,
} from "@/components/QuoteAsk";
import { JumpToLatest } from "@/components/JumpToLatest";
import { useChatScroll } from "@/lib/useChatScroll";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CodeBlock } from "@/components/CodeBlock";
import { LiveStatus } from "@/components/LiveStatus";
import { SlashAutocomplete } from "@/components/CommandPalette";
import { SlashUsageCard, useSlashUsage } from "@/components/SlashUsageCard";
import { ThinkingSection } from "@/components/ThinkingSection";
import { TurnSegments } from "@/components/AssistantTurn";
import { UsageFooter } from "@/components/UsageFooter";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { cleanRenderedContent, extractMediaPaths } from "@/lib/messageText";
import { MD_COMPONENTS, SAFE_REHYPE_PLUGINS } from "@/lib/markdown";
import { EmojiText } from "@/lib/emojiIcons";
import { extractProse, hasOpenUIBlock, UIBlock } from "@/lib/uiBlocks";
import {
  addQuote,
  buildQuotesPayload,
  clearQuotes,
  quoteFromSelection,
  quoteFromText,
  removeQuote,
  type Quote,
  type QuoteChip,
} from "@/lib/quotes";
import type { SlashCommand } from "@/lib/palette";
import {
  deriveLiveTurnStatus,
  liveBubbleIndex,
  splitTurnDisplay,
  turnSegments,
} from "@/lib/transcript";
import type { ChatMessage } from "@/views/ChatView";
import { DASHBOARD_SESSION_KEY } from "@/lib/useLastSession";

interface PendingMedia {
  id: string;
  file: File;
  path?: string;
  uploading: boolean;
  preview?: string;
}

const IMAGE_EXTS = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".gif",
  ".webp",
  ".bmp",
  ".svg",
]);
const AUDIO_EXTS = new Set([".ogg", ".mp3", ".m4a", ".wav", ".opus", ".webm"]);

function getMediaKind(p: string): "image" | "audio" | "file" {
  const ext = p.substring(p.lastIndexOf(".")).toLowerCase();
  if (IMAGE_EXTS.has(ext)) return "image";
  if (AUDIO_EXTS.has(ext)) return "audio";
  return "file";
}

function getFileName(p: string): string {
  return p.substring(p.lastIndexOf("/") + 1) || p;
}

function MediaAttachment({ path }: { path: string }) {
  const kind = getMediaKind(path);
  if (kind === "image") {
    return (
      <img
        src={`/api/media?path=${encodeURIComponent(path)}`}
        alt={getFileName(path)}
        className="my-1 w-full rounded-lg object-cover"
        loading="lazy"
      />
    );
  }
  if (kind === "audio") {
    return (
      <audio
        controls
        src={`/api/media?path=${encodeURIComponent(path)}`}
        className="my-1 w-full"
      />
    );
  }
  return (
    <a
      href={`/api/media?path=${encodeURIComponent(path)}`}
      target="_blank"
      rel="noopener noreferrer"
      className="my-1 inline-flex w-full items-center gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2.5 text-sm text-foreground"
    >
      <Paperclip className="size-4 shrink-0" />
      <span className="truncate">{getFileName(path)}</span>
    </a>
  );
}

function MobileMedia({ paths }: { paths: string[] }) {
  if (!paths.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {paths.map((p, i) => (
        <MediaAttachment key={i} path={p} />
      ))}
    </div>
  );
}

export function ChatView({
  messages,
  streaming,
  loading,
  onSend,
  onStop,
  onNewChat,
  onOpenFile,
  onRegenerate,
  commands = [],
  sessionKey = DASHBOARD_SESSION_KEY,
  followUpSeed = null,
  onFollowUpSeedConsumed,
  onOpenSessions,
  onBrowseFiles,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  loading?: boolean;
  onSend: (
    content: string,
    media?: string[],
    replyTo?: string | null,
    replyToContent?: string,
    quotes?: Quote[],
  ) => Promise<void> | void;
  onStop: () => Promise<void> | void;
  onNewChat: () => void;
  onOpenFile?: (path: string) => void;
  onRegenerate?: () => void;
  commands?: SlashCommand[];
  sessionKey?: string;
  /** A notification-center "Reply" lands here as a pre-seeded quote chip. Keyed
   *  on `nonce` so replying to the same notification twice re-seeds. */
  followUpSeed?: { text: string; nonce: number } | null;
  /** Called once a `followUpSeed` has been applied, so the owner can clear it. */
  onFollowUpSeedConsumed?: () => void;
  /** Switch to the Sessions tab (spec §A). */
  onOpenSessions?: () => void;
  /** Switch to the Files tab (spec §A). */
  onBrowseFiles?: () => void;
}) {
  const [input, setInput] = useState("");
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([]);
  const [quoteChips, setQuoteChips] = useState<QuoteChip[]>([]);
  // Reply-to-message (parity with the desktop ChatView's `replyToMsg`): the
  // "↩ Reply" action on any message attaches that whole message to the next
  // send. Distinct from quote-and-ask, which attaches a selected snippet.
  const [replyToMsg, setReplyToMsg] = useState<ChatMessage | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  /** The attachment source sheet — the workspace branch opens the Files tab. */
  const [attachSheetOpen, setAttachSheetOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Quote-and-ask (spec §F): selection inside the message list surfaces the
  // "Add to follow-up" bar. Shared hook — the desktop ChatView uses the same
  // one, so behavior stays in lockstep across both SPAs.
  const selection = useTextSelection(messageListRef, !streaming);

  /**
   * The attach button opens the attachment SOURCE sheet (spec §A).
   *
   * It used to open the device picker straight away. Now it asks where the
   * file comes from: the device, or the workspace — the workspace branch
   * switches to the Files tab, so nothing became unreachable.
   *
   * The native picker is one more tap away: the sheet's own row is a
   * `<label>` for the very same input, so the browser still opens its own
   * dialog (the reason this input is rendered and not display:none).
   */
  const handleAttachClick = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    setAttachSheetOpen(true);
  }, []);

  const closeAttachSheet = useCallback(() => setAttachSheetOpen(false), []);

  const browseWorkspaceFiles = useCallback(() => {
    setAttachSheetOpen(false);
    onBrowseFiles?.();
  }, [onBrowseFiles]);

  const addSelectionAsQuote = useCallback(() => {
    // Prefer the text captured when the selection was made: on touch the live
    // selection is already gone by the time the tap lands.
    const quote = selection.text
      ? quoteFromText(selection.text, { sourceRole: "assistant" })
      : quoteFromSelection(window.getSelection(), { sourceRole: "assistant" });
    if (!quote) return;
    setQuoteChips((chips) => addQuote(chips, quote));
    window.getSelection()?.removeAllRanges();
    toast.success("Added to follow-up");
  }, [selection.text]);

  // Notification "Reply" seeds the composer with a quote chip (parity with
  // desktop App's followUpSeed handling). The reply is a continuation of the
  // session already open, so a draft in the composer is preserved — the stub
  // prompt is only prefilled when the box is empty. Keyed on `nonce` so
  // replying to the same notification twice re-seeds; the seed is then CONSUMED
  // (the owner clears it) so leaving the chat tab and returning does not
  // re-inject a chip the user already removed.
  useEffect(() => {
    if (!followUpSeed?.text) return;
    setQuoteChips((chips) =>
      addQuote(chips, {
        text: followUpSeed.text,
        source_message_id: `notification-${followUpSeed.nonce}`,
        source_role: "assistant",
      }),
    );
    setInput((prev) => prev.trim() || "Replying to this notification — ");
    textareaRef.current?.focus();
    onFollowUpSeedConsumed?.();
  }, [followUpSeed?.nonce, followUpSeed?.text, onFollowUpSeedConsumed]);

  // Auto-follow while pinned, and the "jump to latest" state when not
  // (spec 141 §A). Shared with desktop — see `lib/useChatScroll.ts`. Mobile
  // reaches the pill by thumb, so it matters here at least as much: a long
  // reply scrolls the viewport and the way back must be one tap.
  const { showJump, newCount, jumpToLatest, onScroll } = useChatScroll(
    scrollRef,
    {
      messages,
      streaming,
      threshold: 120,
    },
  );

  // The live strip's label: the turn's newest narrated phase, or the fallback
  // (spec 134 §B). Derived in `lib/transcript.ts`, shared with desktop.
  const liveStatus = useMemo(() => deriveLiveTurnStatus(messages), [messages]);

  // Which bubble the turn in flight is writing (spec 135 §A follow-up). The
  // session-wide `streaming` flag says a turn is running, not WHICH bubble it is
  // in — so the live treatment is applied through this index, never to every row.
  const liveIndex = useMemo(
    () => (streaming ? liveBubbleIndex(messages) : -1),
    [streaming, messages],
  );

  // Auto-grow with content (spec 126 §F). The textarea now owns a full-width
  // row, so its resting height drops from 96px to 64px: on a 360×640 phone the
  // two-row composer plus this taller box would eat a third of the viewport
  // before a single message is sent. It still starts roomy enough to read a
  // couple of lines and grows with typing up to the same 200px cap.
  const COMPOSER_MIN = 64;
  const COMPOSER_MAX = 200;
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    // Collapse to the min, FORCE a reflow (iOS Safari can return a stale
    // scrollHeight for the same frame otherwise), then grow to fit.
    el.style.height = `${COMPOSER_MIN}px`;
    void el.offsetHeight; // eslint-disable-line no-unused-expressions
    el.style.height = `${Math.max(COMPOSER_MIN, Math.min(el.scrollHeight, COMPOSER_MAX))}px`;
  }, [input]);

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) clearTimeout(recordingTimerRef.current);
      if (
        mediaRecorderRef.current &&
        mediaRecorderRef.current.state !== "inactive"
      ) {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const addFiles = useCallback((files: FileList | File[]) => {
    const arr = Array.from(files);
    const items: PendingMedia[] = arr.map((file) => ({
      id: crypto.randomUUID(),
      file,
      uploading: false,
      preview: file.type.startsWith("image/")
        ? URL.createObjectURL(file)
        : undefined,
    }));
    setPendingMedia((prev) => [...prev, ...items]);
    for (const item of items) uploadMedia(item);
  }, []);

  const uploadMedia = useCallback(async (item: PendingMedia) => {
    setPendingMedia((prev) =>
      prev.map((p) => (p.id === item.id ? { ...p, uploading: true } : p)),
    );
    try {
      const result = await api.uploadMedia(item.file);
      setPendingMedia((prev) =>
        prev.map((p) =>
          p.id === item.id ? { ...p, uploading: false, path: result.path } : p,
        ),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
      setPendingMedia((prev) => prev.filter((p) => p.id !== item.id));
    }
  }, []);

  const removePending = useCallback((id: string) => {
    setPendingMedia((prev) => {
      const item = prev.find((p) => p.id === id);
      if (item?.preview) URL.revokeObjectURL(item.preview);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, {
        mimeType: "audio/webm;codecs=opus",
      });
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const file = new File(chunks, `voice-${Date.now()}.webm`, {
          type: "audio/webm",
        });
        addFiles([file]);
      };
      mediaRecorderRef.current = mr;
      mr.start();
      setIsRecording(true);
    } catch {
      toast.error("Microphone access denied");
    }
  }, [addFiles]);

  const stopRecording = useCallback(() => {
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state !== "inactive"
    ) {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    if (recordingTimerRef.current) {
      clearTimeout(recordingTimerRef.current);
      recordingTimerRef.current = null;
    }
  }, []);

  const allUploaded = pendingMedia.every((p) => !p.uploading);
  const mediaPaths = useMemo(
    () => pendingMedia.filter((p) => p.path).map((p) => p.path!),
    [pendingMedia],
  );

  const showSlashMenu =
    /^\/[^\s]*$/.test(input.trim()) && input.trimStart().startsWith("/");

  async function send() {
    const content = input.trim();
    if (!content && !mediaPaths.length && quoteChips.length === 0) return;
    if (!allUploaded) {
      toast.info("Waiting for uploads to finish…");
      return;
    }
    const quotes = buildQuotesPayload(quoteChips);
    const replyTo = replyToMsg?.messageId ?? null;
    const replyToContent = replyToMsg?.content;
    setInput("");
    setPendingMedia([]);
    setReplyToMsg(null);
    setQuoteChips(clearQuotes());
    try {
      await onSend(
        content,
        mediaPaths.length ? mediaPaths : undefined,
        replyTo,
        replyToContent,
        quotes.length ? quotes : undefined,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send");
    }
  }

  return (
    <div className="flex h-full flex-col" data-testid="mobile-chat">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex min-w-0 items-center gap-1">
          {onOpenSessions && (
            <button
              type="button"
              onClick={onOpenSessions}
              aria-label="Sessions"
              title="Sessions"
              data-testid="mobile-sessions-drawer-toggle"
              className="inline-flex size-9 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <History className="size-5" />
            </button>
          )}
          <h1 className="truncate text-base font-semibold">Chat</h1>
        </div>
        <div className="flex items-center gap-1">
          {streaming && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void onStop()}
              title="Stop"
            >
              <Square className="size-4" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onNewChat}
            title="New chat"
          >
            <Plus className="size-5" />
            <span className="hidden">New chat</span>
          </Button>
        </div>
      </div>

      {/* `relative` so the jump-to-latest pill can float over the transcript's
          bottom edge, just above the composer (spec 141 §A). */}
      <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={scrollRef}
          onScroll={onScroll}
          className="no-scrollbar flex-1 overflow-y-auto px-3 pb-3"
        >
          {messages.length === 0 ? (
            loading ? (
              <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </div>
            ) : (
              <div className="flex flex-col items-center gap-3 py-20 text-center">
                <Logo size={64} />
                <p className="text-muted-foreground">
                  Say hello to Sarathy anywhere.
                </p>
              </div>
            )
          ) : null}
          <div
            ref={messageListRef}
            className="flex w-full flex-col gap-3"
            data-testid="mobile-message-list"
          >
            {messages.map((m, i) => (
              <MobileMessage
                key={m.bubbleId ?? m.turnId ?? m.messageId ?? i}
                message={m}
                /* Parity with desktop: the live treatment belongs to the bubble the
                 turn in flight is writing, never to every bubble because the
                 SESSION is streaming (spec 135 §A follow-up). */
                live={streaming && i === liveIndex}
                onOpenFile={onOpenFile}
                onRegenerate={
                  m.role === "assistant" && !streaming
                    ? onRegenerate
                    : undefined
                }
                onReply={!streaming ? () => setReplyToMsg(m) : undefined}
                onSend={(text) => void onSend(text, undefined)}
              />
            ))}

            {/* Parity with the desktop ChatView: a live status strip while the
              turn is running. It reads the turn's newest narrated phase —
              "🔍 Sending image to VLM…", a tool call — falling back to
              "Sarathy is responding…". Both SPAs render the same component off
              the same `deriveLiveTurnStatus` (spec 134 §B). */}
            {streaming && liveStatus && <LiveStatus {...liveStatus} />}
          </div>
          <JumpToLatest
            show={showJump}
            newCount={newCount}
            onClick={jumpToLatest}
          />
        </div>
      </div>

      <div className="safe-bottom border-t bg-background/95 px-3 pb-2 pt-2 backdrop-blur">
        {/* Visually hidden but RENDERED (not display:none): iOS Safari ignores
          programmatic .click() on a display:none file input, so the attach
          button silently does nothing there. sr-only keeps it clickable. */}
        <input
          id="attach-file-input"
          ref={fileInputRef}
          type="file"
          multiple
          className="sr-only"
          tabIndex={-1}
          aria-hidden="true"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
        />
        <QuoteChips
          chips={quoteChips}
          onRemove={(id) => setQuoteChips((c) => removeQuote(c, id))}
        />
        {replyToMsg && (
          <div
            className="mb-2 flex items-start gap-2 rounded-xl border border-border bg-muted/30 p-2 text-xs text-muted-foreground"
            data-testid="reply-preview"
          >
            <span className="mt-0.5 shrink-0 opacity-60">↩</span>
            <span className="flex-1 truncate">
              <EmojiText text={replyToMsg.content} />
            </span>
            <button
              onClick={() => setReplyToMsg(null)}
              aria-label="Cancel reply"
            >
              <X className="size-3.5" />
            </button>
          </div>
        )}
        {pendingMedia.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingMedia.map((pm) => (
              <div
                key={pm.id}
                className="relative flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5 text-xs"
              >
                {pm.preview ? (
                  <img
                    src={pm.preview}
                    alt=""
                    className="size-10 rounded object-cover"
                  />
                ) : (
                  <span className="flex size-10 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                    {pm.file.name.slice(0, 4)}
                  </span>
                )}
                <span className="max-w-[80px] truncate">{pm.file.name}</span>
                <button
                  onClick={() => removePending(pm.id)}
                  className="text-muted-foreground"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="relative">
          <SlashAutocomplete
            input={input}
            commands={commands}
            activeIndex={slashIndex}
            onPick={(cmd) => {
              setInput(`/${cmd.name} `);
              setSlashIndex(0);
              textareaRef.current?.focus();
            }}
          />
          {/* Two-row composer (spec 126 §F).
              Previously attach + mic + textarea + send shared ONE
              `flex items-end gap-2` row, so on a 360px phone the textarea was
              squeezed into the ~180px left over by three 44px controls — too
              narrow to read what you were typing. The textarea now owns a
              full-width row and the actions sit beneath it, which is also the
              arrangement phone keyboards expect (input above, controls below).

              Desktop and iPad are untouched: they render ChatView from
              views/, never this component. */}
          <div className="flex flex-col gap-1.5">
            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (showSlashMenu) setSlashIndex(0);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault();
                  void send();
                  return;
                }
                if (showSlashMenu) {
                  if (e.key === "ArrowDown") {
                    e.preventDefault();
                    setSlashIndex((i) => i + 1);
                    return;
                  }
                  if (e.key === "ArrowUp") {
                    e.preventDefault();
                    setSlashIndex((i) => Math.max(0, i - 1));
                    return;
                  }
                  if (e.key === "Tab") {
                    e.preventDefault();
                    const match = commands.find(
                      (c) => input.trim() === `/${c.name}`,
                    );
                    if (match) setInput(`/${match.name} `);
                    return;
                  }
                }
              }}
              placeholder="Message Sarathy…"
              /* Same accent + symmetric vertical padding as desktop (spec
                 135 §B): the input and the send button light up together, and
                 the first line starts where the controls do. */
              className="w-full !min-h-16 max-h-[200px] resize-none overflow-y-auto rounded-lg px-3.5 py-3 text-base focus-visible:border-primary/40 focus-visible:ring-primary/40"
              rows={1}
              aria-label="Message input"
              data-testid="mobile-composer-input"
            />
            {/* Controls: a tight ghost cluster on the left, send alone on the
                right. Every control is the SAME square with the input's radius
                — the send button used to be a circle among rounded squares,
                which is what made the row look unresolved. Footprint stays
                44px here (spec 126 §F touch target); desktop is 36px. */}
            <div
              className="flex items-center justify-between gap-2"
              data-testid="mobile-composer-actions"
            >
              <div className="flex items-center gap-0.5">
                <label
                  htmlFor="attach-file-input"
                  onClick={handleAttachClick}
                  className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="Attach file"
                  role="button"
                >
                  <Paperclip className="size-5" />
                </label>
                <Button
                  variant={isRecording ? "destructive" : "ghost"}
                  size="icon"
                  className="size-11 shrink-0 rounded-lg text-muted-foreground hover:text-foreground"
                  onClick={isRecording ? stopRecording : startRecording}
                  aria-label={isRecording ? "Stop recording" : "Record voice"}
                  data-testid="mobile-mic"
                >
                  {isRecording ? (
                    <Square className="size-5" />
                  ) : (
                    <Mic className="size-5" />
                  )}
                </Button>
              </div>
              <Button
                size="icon"
                className="size-11 shrink-0 rounded-lg"
                onClick={() => void send()}
                disabled={
                  !input.trim() && !mediaPaths.length && quoteChips.length === 0
                }
                aria-label="Send"
                data-testid="mobile-send"
              >
                <Send className="size-5" />
              </Button>
            </div>
          </div>
        </div>
        <UsageFooter
          sessionKey={sessionKey}
          streaming={streaming}
          revision={messages.length}
          compact
          className="mt-1.5"
        />
      </div>

      <QuoteActionBar
        visible={selection.visible}
        rect={selection.rect}
        onAdd={addSelectionAsQuote}
      />

      {/* --------------------------------------------- attachment source sheet */}
      {attachSheetOpen && (
        <div className="fixed inset-0 z-50" data-testid="mobile-attach-sheet">
          <button
            type="button"
            aria-label="Close attachment menu"
            data-testid="mobile-attach-sheet-scrim"
            onClick={closeAttachSheet}
            className="absolute inset-0 h-full w-full bg-black/60"
          />
          <div
            className="absolute inset-x-0 bottom-0 flex flex-col gap-1 rounded-t-2xl border-t bg-background p-3 pb-6"
            data-testid="mobile-attach-sheet-panel"
          >
            <label
              htmlFor="attach-file-input"
              role="button"
              data-testid="mobile-attach-upload"
              onClick={closeAttachSheet}
              className="flex min-h-12 cursor-pointer items-center gap-3 rounded-lg px-3 text-base hover:bg-accent"
            >
              <Paperclip className="size-5 shrink-0" />
              Upload from device
            </label>
            <button
              type="button"
              onClick={browseWorkspaceFiles}
              data-testid="mobile-attach-files"
              className="flex min-h-12 items-center gap-3 rounded-lg px-3 text-left text-base hover:bg-accent"
            >
              <FolderTree className="size-5 shrink-0" />
              Browse workspace files
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function MobileMessage({
  message,
  live: liveProp,
  onOpenFile,
  onRegenerate,
  onReply,
  onSend,
}: {
  message: ChatMessage;
  /**
   * Whether this bubble is the one the turn in flight is writing
   * (`liveBubbleIndex`) — NOT the session-wide `streaming` flag. Reading that
   * directly painted the live affordances onto every finished bubble above the
   * live one, and left the caret blinking on a turn that ended without a
   * `_final` frame (voice replies, `/stop`).
   */
  live: boolean;
  onOpenFile?: (path: string) => void;
  onRegenerate?: () => void;
  onReply?: () => void;
  onSend?: (message: string) => void;
}) {
  const isUser = message.role === "user";
  const isNotice = !isUser && Boolean(message.notice);
  // Shared render-layer cleanup (spec 126 §B).
  const cleanContent = useMemo(
    () => cleanRenderedContent(message.content),
    [message.content],
  );

  const [copied, setCopied] = useState(false);
  const copyMessage = useCallback(() => {
    void navigator.clipboard.writeText(cleanContent);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [cleanContent]);

  // Reads the RAW content: the machine lines holding these paths are exactly
  // what cleanRenderedContent strips.
  const displayMedia = useMemo(() => {
    if (message.media?.length) return message.media;
    return extractMediaPaths(message.content);
  }, [message.media, message.content]);

  // A reply carrying a widget needs room: on a 390px phone the content-sized
  // bubble is ~186px, which crushes charts and tables. Widen only these
  // bubbles (desktop MessageRow does the same) so ordinary chat stays compact.
  const hasUI = useMemo(() => hasOpenUIBlock(cleanContent), [cleanContent]);

  // The turn's ordered prose (spec 135 §A) — ONE bubble per turn, with the
  // desktop rendering the same `segments` through the same `TurnSegments`.
  const segments = useMemo(
    () => (isUser || isNotice ? [] : turnSegments(message)),
    [message, isUser, isNotice],
  );
  const hasContent = segments.length > 0;

  // Parity with the desktop MessageRow: the thinking strip's live state tracks
  // the bubble the turn in flight is WRITING, never the session-wide `streaming`
  // flag (spec 135 §A follow-up). Reading `streaming` (or `progress`) directly
  // made every finished bubble above the live one shimmer and pulse, and kept the
  // caret blinking on a turn that ended without a `_final` frame.
  const live = !isUser && !isNotice && liveProp;

  // A settled turn shows its answer; the monologue tucks into the collapse
  // (spec 139 §A). Shared with desktop, so the two cannot disagree about which
  // prose is the reply.
  const { inline: inlineSegments, tucked: tuckedSegments } = useMemo(
    () =>
      splitTurnDisplay(
        segments,
        live,
        (message.media?.length ?? 0) > 0 || (message.quotes?.length ?? 0) > 0,
      ),
    [segments, live, message.media?.length, message.quotes?.length],
  );

  // The collapse header is the turn's only status row: it shows whenever the
  // turn has anything to reveal, and also while a live turn has said nothing
  // yet — that empty state is one slim row, not a placeholder + a chip.
  const showThinking =
    !isUser &&
    !isNotice &&
    (hasContent ||
      (message.toolHints?.length || 0) > 0 ||
      (message.thinkingContent?.length || 0) > 0 ||
      live);

  return (
    <div
      className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}
      /* Same row testids as desktop MessageRow, so a parity assertion (and any
         e2e selector) works against either SPA (spec 135 §A). */
      data-testid={isUser ? "message-row-user" : "message-row-assistant"}
    >
      <div
        className={cn(
          "max-w-[88%] rounded-2xl px-4 py-2.5 text-base leading-relaxed",
          hasUI && "w-full",
          isUser
            ? "bg-primary text-primary-foreground"
            : isNotice
              ? "border border-dashed border-border bg-muted/40 py-2 text-[13px] text-muted-foreground"
              : "border border-border bg-card",
        )}
        data-testid={isNotice ? "command-notice" : undefined}
      >
        {showThinking && (
          /* ONE header per turn, identical to desktop (spec 135 §A): the live
             pulse sits in this row, and the separate placeholder + working chip
             that used to stack under it are gone. */
          <ThinkingSection
            toolHints={message.toolHints || []}
            thinkingContent={message.thinkingContent || ""}
            notes={tuckedSegments}
            done={!live}
            durationMs={message.durationMs}
            /* The slim row exists for the LIVE turn — it is the turn's status
               line while the bubble has no prose yet (spec 135 §A). A SETTLED
               turn shows it only when it has something to reveal; otherwise the
               chevron would expand to nothing. A turn rebuilt from the session
               file whose iterations never narrated is exactly that case. */
            alwaysShow={live}
            onOpenFile={onOpenFile}
          />
        )}
        {message.replyTo && message.replyToContent && (
          <div
            className={cn(
              "mb-2 rounded-lg border px-2.5 py-1.5 text-xs opacity-70",
              isUser ? "border-primary-foreground/30" : "border-border",
            )}
          >
            ↩ {message.replyToContent.slice(0, 80)}
          </div>
        )}
        {message.quotes && message.quotes.length > 0 && (
          <div
            className={cn(
              "mb-2 space-y-1 rounded-lg border px-2.5 py-1.5 text-xs opacity-80",
              isUser ? "border-primary-foreground/30" : "border-border",
            )}
            data-testid="message-quotes"
          >
            {message.quotes.map((q, i) => (
              <div key={i} className="border-l-2 border-current/30 pl-2 italic">
                {q.text.length > 160 ? `${q.text.slice(0, 160)}…` : q.text}
              </div>
            ))}
          </div>
        )}
        {displayMedia.length > 0 && (
          <div className={isUser ? "mb-1" : "mb-2"}>
            <MobileMedia paths={displayMedia} />
          </div>
        )}
        {isUser ? (
          /* Parity with the desktop MessageRow (job 132 §D): user turns render
             as markdown, not literal backticks. Markdown only — no openUI. */
          <MarkdownBubble content={cleanContent} onPrimary />
        ) : isNotice ? (
          /* Out-of-band acks are standalone messages carrying their own
             `content` (no segments) — same plain body as before spec 135. */
          <AssistantBody
            content={cleanContent}
            onOpenFile={onOpenFile}
            onSend={onSend}
          />
        ) : (
          /* The turn's prose — every segment while it is live, the answer alone
             once it has settled (spec 135 §A, spec 139 §A). The same shared
             component desktop renders. */
          <TurnSegments
            segments={inlineSegments}
            live={live}
            renderSegment={(text, isStreaming) => (
              <AssistantBody
                content={cleanRenderedContent(text)}
                onOpenFile={onOpenFile}
                streaming={isStreaming}
                onSend={onSend}
              />
            )}
          />
        )}
        {!isNotice && hasContent && (
          <div className="mt-2 flex items-center gap-3 text-xs text-muted-foreground">
            <button
              onClick={copyMessage}
              className="inline-flex items-center gap-1.5 active:text-foreground"
              title="Copy"
            >
              {copied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
              {copied ? "Copied" : "Copy"}
            </button>
            {!isUser && onRegenerate && (
              <button
                onClick={onRegenerate}
                className="inline-flex items-center gap-1.5 active:text-foreground"
                title="Regenerate"
              >
                <RotateCcw className="size-3.5" /> Regenerate
              </button>
            )}
            {onReply && (
              <button
                onClick={onReply}
                className="inline-flex items-center gap-1.5 active:text-foreground"
                title="Reply"
                data-testid="message-reply"
              >
                <ReplyIcon className="size-3.5" /> Reply
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Assistant body — parity with the desktop ChatView (v0.16.x openUI adapter).
 *
 * A well-formed ```openui-lang block renders as interactive widgets; anything
 * else (including every pure-text reply) falls back to markdown exactly as
 * before. Without this, mobile showed the raw UI-block source as code.
 */
function AssistantBody({
  content,
  streaming,
  onOpenFile,
  onSend,
}: {
  content: string;
  streaming?: boolean;
  onOpenFile?: (path: string) => void;
  onSend?: (message: string) => void;
}) {
  // Slash-usage replies render as a tappable card instead of a wall of
  // monospace (spec 137 §A3). The detection is the shared module's, shared with
  // desktop; only the markdown pipeline below differs between the two surfaces.
  // Tap targets are sized for a phone.
  const usage = useSlashUsage(onSend ? content : "");
  const body = usage ? usage.prose : content;

  const hasUI = useMemo(() => hasOpenUIBlock(body), [body]);
  const chunks = useMemo(
    () => (hasUI ? extractProse(body) : [body]),
    [body, hasUI],
  );

  const markdown = useMemo(
    () =>
      chunks.map((chunk, i) => (
        <ReactMarkdown
          key={i}
          remarkPlugins={[remarkGfm]}
          rehypePlugins={SAFE_REHYPE_PLUGINS}
          components={{
            ...MD_COMPONENTS,
            code: ({ children, className, ...props }) => {
              const isBlock = className?.startsWith("language-");
              if (isBlock) {
                return (
                  <CodeBlock className={className} onOpenFile={onOpenFile}>
                    {String(children)}
                  </CodeBlock>
                );
              }
              return (
                <code className={className} {...props}>
                  {children}
                </code>
              );
            },
          }}
        >
          {chunk}
        </ReactMarkdown>
      )),
    [chunks, onOpenFile],
  );

  if (usage) {
    return (
      <div className="md">
        {markdown}
        <SlashUsageCard parsed={usage} onSend={onSend} />
        {streaming && <span className="streaming-caret" />}
      </div>
    );
  }

  if (hasUI) {
    return (
      <div className="md">
        {markdown}
        <UIBlock source={content} isStreaming={streaming} onSend={onSend} />
        {streaming && <span className="streaming-caret" />}
      </div>
    );
  }

  return (
    <div className="md">
      {markdown}
      {streaming && <span className="streaming-caret" />}
    </div>
  );
}

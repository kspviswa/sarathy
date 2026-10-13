import {
  Check,
  Copy,
  Download,
  Loader2,
  Mic,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  Square,
  X,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { CodeBlock } from "@/components/CodeBlock";
import { GreetingState, DEFAULT_SUGGESTIONS, type Suggestion } from "@/components/GreetingState";
import { LiveStatus } from "@/components/LiveStatus";
import { MarkdownBubble } from "@/components/MarkdownBubble";
import { PresenceIndicator } from "@/components/Presence";
import { cleanRenderedContent, extractMediaPaths } from "@/lib/messageText";
import { MD_COMPONENTS, SAFE_REHYPE_PLUGINS } from "@/lib/markdown";
import { QuoteActionBar, QuoteChips, useTextSelection } from "@/components/QuoteAsk";
import { ThinkingSection } from "@/components/ThinkingSection";
import { TurnSegments } from "@/components/AssistantTurn";
import { SlashAutocomplete } from "@/components/CommandPalette";
import { UsageFooter } from "@/components/UsageFooter";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api } from "@/lib/api";
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
import { deriveLiveTurnStatus, turnSegments, type TurnSegment } from "@/lib/transcript";
import type { SlashCommand } from "@/lib/palette";
import type { ReactionState } from "@/lib/reactions";
import { UIBlock, extractProse, hasOpenUIBlock } from "@/lib/uiBlocks";
import { cn } from "@/lib/utils";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  progress?: boolean;
  toolHint?: string;
  toolHints?: string[];
  thinkingContent?: string;
  messageId?: string;
  /**
   * Server turn id (spec 127 §C.4): all frames of one turn carry the same id
   * and fold into a single bubble keyed by it.
   */
  turnId?: string;
  media?: string[];
  replyTo?: string | null;
  replyToContent?: string;
  quotes?: Quote[];
  /**
   * Out-of-band command notice — the ack for `/stop`, `/steer`, `/btw` and
   * friends. Rendered as its own bubble (Telegram delivers each as a separate
   * message) and never merged into a turn's streaming bubble.
   */
  notice?: boolean;
  /**
   * Genuine prose the turn committed to alongside a tool call (spec 131 §C).
   * On the bubble this means "this turn has already committed a segment" — the
   * turn itself still continues in the SAME bubble (spec 135 §A).
   */
  sealed?: boolean;
  /**
   * The turn's ordered prose (spec 135 §A): one bubble, N segments, a hairline
   * trail divider between them. `content` mirrors these joined, so every
   * consumer that predates segments (copy, media extraction, the session
   * viewer) keeps working. Absent on messages loaded from a session archive —
   * `turnSegments()` treats those as a single sealed segment.
   */
  segments?: TurnSegment[];
  /**
   * `turnId` + sub-index — the unique React key. A turn is ONE bubble, so the
   * sub-index only ever distinguishes legacy turns that arrived without one.
   */
  bubbleId?: string;
}

interface PendingMedia {
  id: string;
  file: File;
  path?: string;
  uploading: boolean;
  preview?: string;
}

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]);
const AUDIO_EXTS = new Set([".ogg", ".mp3", ".m4a", ".wav", ".opus", ".webm"]);

/** Composer height bounds (px). Small enough to stay a composer, tall enough
 *  to paste a stack trace without scrolling (spec §E). */
export const COMPOSER_MIN_HEIGHT = 56;
export const COMPOSER_MAX_HEIGHT = 480;
export const COMPOSER_DEFAULT_HEIGHT = 96;
export const COMPOSER_HEIGHT_KEY = "sarathy_composer_height";

function clampComposerHeight(px: number): number {
  return Math.min(COMPOSER_MAX_HEIGHT, Math.max(COMPOSER_MIN_HEIGHT, Math.round(px)));
}

/** Remember the drag height across reloads; a bad/hostile value falls back to
 *  the default instead of rendering a 0px or 100000px composer. */
export function loadComposerHeight(): number {
  try {
    const raw = typeof localStorage === "undefined" ? null : localStorage.getItem(COMPOSER_HEIGHT_KEY);
    const n = raw === null ? NaN : Number(raw);
    if (Number.isFinite(n)) return clampComposerHeight(n);
  } catch {
    // localStorage blocked (private mode / sandboxed iframe) — use the default.
  }
  return COMPOSER_DEFAULT_HEIGHT;
}

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
        className="max-h-56 rounded-lg my-1 cursor-pointer"
        loading="lazy"
      />
    );
  }
  if (kind === "audio") {
    return (
      <audio controls src={`/api/media?path=${encodeURIComponent(path)}`} className="my-1 w-full max-w-xs" />
    );
  }
  return (
    <a
      href={`/api/media?path=${encodeURIComponent(path)}`}
      target="_blank"
      rel="noopener noreferrer"
      className="my-1 inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm text-foreground hover:bg-muted"
    >
      <Download className="size-4" />
      {getFileName(path)}
    </a>
  );
}

function MediaAttachments({ paths }: { paths: string[] }) {
  if (!paths.length) return null;
  return (
    <div className="flex flex-col gap-1">
      {paths.map((p, i) => (
        <MediaAttachment key={i} path={p} />
      ))}
    </div>
  );
}

interface MessageActionsProps {
  content: string;
  onRegenerate?: () => void;
  onReply?: () => void;
}

function MessageActions({ content, onRegenerate, onReply }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);

  const copyMessage = useCallback(() => {
    void navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  return (
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
      {onReply && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground hover:text-foreground"
              onClick={onReply}
            >
              <svg className="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="9 14 4 9 9 4" />
                <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
              </svg>
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Reply</TooltipContent>
        </Tooltip>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        onClick={copyMessage}
        title="Copy"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </Button>
      {onRegenerate && (
        <Button
          variant="ghost"
          size="icon"
          className="size-7 text-muted-foreground hover:text-foreground"
          onClick={onRegenerate}
          title="Regenerate"
        >
          <RotateCcw className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

/**
 * Renders an assistant message body.
 *
 * Routes through the openUI adapter: a well-formed typed UI block renders as
 * interactive UI; anything else (including every pure-text reply) falls back to
 * markdown exactly as before. Prose outside a UI fence is rendered alongside.
 */
function MessageBody({
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
  // Gate on a cheap fence check so the heavy openUI renderer stays unloaded for
  // ordinary text replies. When a block IS present, prose (fences stripped) is
  // shown alongside it; otherwise the whole body renders as markdown.
  const hasUI = useMemo(() => hasOpenUIBlock(content), [content]);
  const chunks = useMemo(() => (hasUI ? extractProse(content) : [content]), [content, hasUI]);

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

export function ChatView({
  messages,
  streaming,
  loading,
  reaction = "done",
  onSend,
  onStop,
  onNewChat,
  onOpenFile,
  onRegenerate,
  commands = [],
  sessionKey,
  suggestions = DEFAULT_SUGGESTIONS,
  messagesRef,
  followUpSeed = null,
  onFollowUpSeedConsumed,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  loading?: boolean;
  reaction?: ReactionState;
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
  suggestions?: Suggestion[];
  messagesRef?: RefObject<HTMLDivElement>;
  /**
   * Notification text to seed the composer with, from the notification center's
   * "Reply" action (spec 126 §D). Carries a nonce so replying to the SAME
   * notification twice re-seeds instead of being swallowed as a no-op change.
   */
  followUpSeed?: { text: string; nonce: number } | null;
  /** Called once a `followUpSeed` has been applied, so the owner can clear it. */
  onFollowUpSeedConsumed?: () => void;
}) {
  const [input, setInput] = useState("");
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([]);
  const [replyToMsg, setReplyToMsg] = useState<ChatMessage | null>(null);
  const [quoteChips, setQuoteChips] = useState<QuoteChip[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [composerHeight, setComposerHeightState] = useState(loadComposerHeight);
  const [resizing, setResizing] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const turnStartRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  const localScrollRef = useRef<HTMLDivElement>(null);
  const scrollRef = messagesRef ?? localScrollRef;
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isNearBottomRef = useRef(true);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const resizeDragRef = useRef<{ startY: number; startHeight: number } | null>(null);

  const setComposerHeight = useCallback((px: number) => {
    const next = clampComposerHeight(px);
    setComposerHeightState(next);
    try {
      localStorage.setItem(COMPOSER_HEIGHT_KEY, String(next));
    } catch {
      // Persisting the height is a convenience, never a hard requirement.
    }
  }, []);

  const startResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      resizeDragRef.current = { startY: e.clientY, startHeight: composerHeight };
      setResizing(true);
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Pointer capture unsupported (older Safari) — move/up still fire.
      }
    },
    [composerHeight],
  );

  const dragResize = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = resizeDragRef.current;
      if (!drag) return;
      e.preventDefault();
      // Dragging UP grows the composer, so the delta is inverted.
      setComposerHeight(drag.startHeight + (drag.startY - e.clientY));
    },
    [setComposerHeight],
  );

  const endResize = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    resizeDragRef.current = null;
    setResizing(false);
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch {
      // No capture to release — harmless.
    }
  }, []);

  const nudgeResize = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.shiftKey ? 64 : 24;
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setComposerHeight(composerHeight + step);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        setComposerHeight(composerHeight - step);
      } else if (e.key === "Home") {
        e.preventDefault();
        setComposerHeight(COMPOSER_MIN_HEIGHT);
      }
    },
    [composerHeight, setComposerHeight],
  );

  // Elapsed timer for the reaction chip / thinking drawer.
  useEffect(() => {
    if (!streaming) {
      turnStartRef.current = null;
      setElapsed(0);
      return;
    }
    turnStartRef.current ??= Date.now();
    const id = setInterval(() => {
      setElapsed(turnStartRef.current ? Date.now() - turnStartRef.current : 0);
    }, 100);
    return () => clearInterval(id);
  }, [streaming]);

  // Quote-and-ask: only for assistant messages, never while streaming.
  const selection = useTextSelection(messageListRef, !streaming);

  const checkNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
  }, [scrollRef]);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.addEventListener("scroll", checkNearBottom, { passive: true });
    return () => el?.removeEventListener("scroll", checkNearBottom);
  }, [checkNearBottom, scrollRef]);

  useEffect(() => {
    if (isNearBottomRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages, streaming, scrollRef]);

  // The live strip's label: the turn's newest narrated phase, or the fallback
  // (spec 134 §B). Derived in `lib/transcript.ts`, shared with mobile.
  const liveStatus = useMemo(() => deriveLiveTurnStatus(messages), [messages]);

  useEffect(() => {
    return () => {
      if (recordingTimerRef.current) clearTimeout(recordingTimerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const uploadPending = useCallback(async (item: PendingMedia) => {
    setPendingMedia((prev) => prev.map((p) => (p.id === item.id ? { ...p, uploading: true } : p)));
    try {
      const result = await api.uploadMedia(item.file);
      setPendingMedia((prev) =>
        prev.map((p) => (p.id === item.id ? { ...p, uploading: false, path: result.path } : p)),
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Upload failed");
      setPendingMedia((prev) => prev.filter((p) => p.id !== item.id));
    }
  }, []);

  const addFiles = useCallback(
    (files: FileList | File[]) => {
      const items: PendingMedia[] = Array.from(files).map((file) => ({
        id: crypto.randomUUID(),
        file,
        uploading: false,
        preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
      }));
      setPendingMedia((prev) => [...prev, ...items]);
      for (const item of items) void uploadPending(item);
    },
    [uploadPending],
  );

  const removePending = useCallback((id: string) => {
    setPendingMedia((prev) => {
      const item = prev.find((p) => p.id === id);
      if (item?.preview) URL.revokeObjectURL(item.preview);
      return prev.filter((p) => p.id !== id);
    });
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const files: File[] = [];
      for (let i = 0; i < e.clipboardData.items.length; i++) {
        if (e.clipboardData.items[i].kind === "file") {
          const f = e.clipboardData.items[i].getAsFile();
          if (f) files.push(f);
        }
      }
      if (files.length) {
        e.preventDefault();
        addFiles(files);
      }
    },
    [addFiles],
  );

  const startRecording = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const file = new File([new Blob(chunks, { type: "audio/webm" })], `voice-${Date.now()}.webm`, {
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
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  }, []);

  const allUploaded = pendingMedia.every((p) => !p.uploading);
  const mediaPaths = useMemo(
    () => pendingMedia.filter((p) => p.path).map((p) => p.path!),
    [pendingMedia],
  );

  // Auto-grow: the textarea grows with its content up to the current composer
  // height, and is pinned to that height once the user has dragged it taller.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = `${composerHeight}px`;
  }, [composerHeight]);

  const send = useCallback(async () => {
    const content = input.trim();
    if (!content && !mediaPaths.length && quoteChips.length === 0) return;
    if (!allUploaded) {
      toast.info("Waiting for uploads to finish…");
      return;
    }
    const replyTo = replyToMsg?.messageId ?? null;
    const replyToContent = replyToMsg?.content;
    const quotes = buildQuotesPayload(quoteChips);

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
  }, [input, mediaPaths, quoteChips, allUploaded, replyToMsg, onSend]);

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

  /**
   * Seed the composer from a notification-center "Reply" (spec 126 §D).
   *
   * The notification lands as a quote chip — the same channel selection-based
   * quoting already uses — so it travels with the next send as `quotes` and the
   * model reads it as genuine prior context. The reply is a turn in the session
   * already open (the App no longer archives it), so an in-progress draft in the
   * composer is preserved: the stub prompt is only prefilled when the box is
   * empty. Nothing is auto-sent; the textarea takes focus so the user can type.
   *
   * Keyed on `nonce`, not the text, so replying to the same notification twice
   * re-seeds rather than being dropped as an unchanged prop. The seed is then
   * CONSUMED (the owner clears it) so that leaving the chat section and coming
   * back does not re-inject a chip the user has already removed.
   */
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

  const showSlashMenu = /^\/[^\s]*$/.test(input.trim()) && input.trimStart().startsWith("/");

  const composer = (
    <div
      className={cn(
        "border-t bg-background/95 px-4 pb-3 pt-1 backdrop-blur",
        resizing && "select-none",
      )}
      data-testid="composer"
    >
      {/* Drag handle: pull up to give the composer more room (spec §E). */}
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Resize composer"
        aria-valuenow={composerHeight}
        aria-valuemin={COMPOSER_MIN_HEIGHT}
        aria-valuemax={COMPOSER_MAX_HEIGHT}
        tabIndex={0}
        onPointerDown={startResize}
        onPointerMove={dragResize}
        onPointerUp={endResize}
        onPointerCancel={endResize}
        onKeyDown={nudgeResize}
        data-testid="composer-resize-handle"
        title="Drag to resize the composer (↑/↓ for fine tuning)"
        className="group flex h-4 w-full cursor-row-resize touch-none items-center justify-center"
      >
        <span
          className={cn(
            "h-1 w-12 rounded-full transition-colors",
            resizing ? "bg-primary" : "bg-border group-hover:bg-muted-foreground/40",
          )}
        />
      </div>
      {/* Full-width band: no max-width cap, so it reflows with the window. */}
      <div className="w-full">
        <QuoteChips chips={quoteChips} onRemove={(id) => setQuoteChips((c) => removeQuote(c, id))} />

        {(pendingMedia.length > 0 || replyToMsg) && (
          <div className="mb-2 flex flex-col gap-1 rounded-xl border border-border bg-muted/30 p-2">
            {replyToMsg && (
              <div className="flex items-start gap-2 rounded-t-xl text-xs text-muted-foreground">
                <span className="mt-0.5 shrink-0 opacity-60">↩</span>
                <span className="flex-1 truncate">{replyToMsg.content}</span>
                <button onClick={() => setReplyToMsg(null)} aria-label="Cancel reply">
                  <X className="size-3" />
                </button>
              </div>
            )}
            {pendingMedia.length > 0 && (
              <div className="flex flex-wrap gap-2">
                {pendingMedia.map((pm) => (
                  <div
                    key={pm.id}
                    className="relative flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5 text-xs"
                  >
                    {pm.preview ? (
                      <img src={pm.preview} alt="" className="size-10 rounded object-cover" />
                    ) : (
                      <span className="size-10 flex items-center justify-center rounded bg-muted text-[10px]">
                        {pm.file.name.slice(0, 4)}
                      </span>
                    )}
                    <span className="max-w-[100px] truncate text-foreground">{pm.file.name}</span>
                    {pm.uploading && (
                      <span className="size-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                    )}
                    {!pm.uploading && pm.path && <Check className="size-3 text-green-500" />}
                    <button onClick={() => removePending(pm.id)} aria-label={`Remove ${pm.file.name}`}>
                      <X className="size-3" />
                    </button>
                  </div>
                ))}
              </div>
            )}
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

          {/* Composer row (spec 135 §B). The three controls used to sit at
              three different sizes — attach/mic `size-9` (36px), send
              `Button size="icon"` = `size-10` (40px) — on an `items-end` row,
              so the rocket was the tallest thing in the composer and read as
              floating next to the input. All three are now 36px squares with
              the input box's radius, ghost-clustered left with send alone on
              the right, and they share the input's accent so the row reads as
              one control instead of four unrelated ones. */}
          <div className="flex items-end gap-2">
            <div className="flex shrink-0 items-center gap-0.5">
              <Tooltip>
                <TooltipTrigger asChild>
                  <label
                    htmlFor="attach-file-input"
                    className="inline-flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    title="Attach file"
                    aria-label="Attach file"
                    role="button"
                  >
                    <Paperclip className="size-4" />
                  </label>
                </TooltipTrigger>
                <TooltipContent side="top">Attach file</TooltipContent>
              </Tooltip>

              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant={isRecording ? "destructive" : "ghost"}
                    size="icon"
                    className="size-9 shrink-0 rounded-lg"
                    onClick={isRecording ? stopRecording : () => void startRecording()}
                    aria-label={isRecording ? "Stop recording" : "Record voice"}
                  >
                    {isRecording ? <Square className="size-4" /> : <Mic className="size-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">
                  {isRecording ? "Stop recording" : "Record voice"}
                </TooltipContent>
              </Tooltip>
            </div>

            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => {
                setInput(e.target.value);
                if (showSlashMenu) setSlashIndex(0);
              }}
              onKeyDown={(e) => {
                // Enter inserts a newline; Ctrl/Cmd+Enter sends (existing contract).
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
                    const match = commands.find((c) => input.trim() === `/${c.name}`);
                    if (match) setInput(`/${match.name} `);
                    return;
                  }
                }
              }}
              onPaste={handlePaste}
              placeholder="Message Sarathy…  ·  Enter = newline, Ctrl+Enter = send"
              style={{ height: composerHeight }}
              /* Symmetric vertical padding: the first line starts where the
                 36px controls start, whether the box holds one line or ten.
                 The focus ring takes the send button's accent (primary), so the
                 whole composer reads as one unit when it lights up. */
              className="flex-1 resize-none overflow-y-auto rounded-lg px-3.5 py-3 focus-visible:border-primary/40 focus-visible:ring-primary/40"
              rows={1}
            />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="icon"
                  className="size-9 shrink-0 rounded-lg"
                  onClick={() => void send()}
                  disabled={!input.trim() && !mediaPaths.length && quoteChips.length === 0}
                  aria-label="Send"
                >
                  <Send className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Send</TooltipContent>
            </Tooltip>
          </div>
        </div>

        <UsageFooter
          sessionKey={sessionKey}
          streaming={streaming}
          revision={messages.length}
          className="mt-1.5"
        />
      </div>
    </div>
  );

  return (
    <div
      className="flex h-full flex-col"
      onDrop={handleDrop}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      data-testid="chat-view"
    >
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

      {dragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm border-2 border-dashed border-primary/40 pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Paperclip className="size-8" />
            <span className="text-sm font-medium">Drop files here</span>
          </div>
        </div>
      )}

      <div className="safe-top flex items-center justify-between border-b bg-background/80 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-2">
          <PresenceIndicator state={reaction} />
          <div className="min-w-0">
            <span className="block text-sm font-semibold leading-tight">Sarathy</span>
            {messages.length > 0 && (
              <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                {messages[messages.length - 1].role === "assistant"
                  ? "ready"
                  : "thinking…"}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {streaming && (
            <Button variant="destructive" size="sm" onClick={() => void onStop()} title="Stop processing">
              <Square className="size-4" />
              <span className="hidden sm:inline">Stop</span>
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onNewChat} title="Start a new chat">
            <Plus className="size-4" />
            <span className="hidden sm:inline">New chat</span>
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="no-scrollbar flex-1 overflow-y-auto">
        {/* Generous cap so wide windows use their width, still readable (spec §B). */}
        <div
          ref={messageListRef}
          className="mx-auto flex w-full max-w-5xl flex-col gap-4 px-4 py-4"
          data-testid="message-list"
        >
          {messages.length === 0 ? (
            loading ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Loading…
              </div>
            ) : (
              <GreetingState
                suggestions={suggestions}
                onPick={(prompt) => {
                  setInput(prompt);
                  textareaRef.current?.focus();
                }}
              />
            )
          ) : null}

          {messages.map((m, i) => (
            <MessageRow
              key={m.bubbleId ?? m.turnId ?? m.messageId ?? i}
              message={m}
              streaming={streaming}
              /* Only the NEWEST bubble animates in (job 132 §E): the class is
                 on a stable keyed node, so it fires once on mount and a
                 streaming reply does not re-trigger it frame by frame. */
              animate={i === messages.length - 1}
              onOpenFile={onOpenFile}
              onRegenerate={m.role === "assistant" && !streaming ? onRegenerate : undefined}
              onReply={() => setReplyToMsg(m)}
              onSend={(text) => void onSend(text)}
            />
          ))}

          {streaming && liveStatus && (
            /* Narration, not decoration (spec 134 §B): the label is the newest
               `_tool_hint` the loop published — "🔍 Sending image to VLM…" while
               an image is being described, a tool call while it works — with
               "Sarathy is responding…" as the fallback. Identical markup on
               mobile; the decision lives in `deriveLiveTurnStatus`. */
            <LiveStatus {...liveStatus} elapsedMs={elapsed} />
          )}
        </div>
      </div>

      <QuoteActionBar visible={selection.visible} rect={selection.rect} onAdd={addSelectionAsQuote} />

      {composer}
    </div>
  );
}

function MessageRow({
  message,
  streaming,
  animate = false,
  onOpenFile,
  onRegenerate,
  onReply,
  onSend,
}: {
  message: ChatMessage;
  streaming: boolean;
  /** Fade the bubble in on mount (job 132 §E). */
  animate?: boolean;
  onOpenFile?: (path: string) => void;
  onRegenerate?: () => void;
  onReply?: () => void;
  onSend?: (message: string) => void;
}) {
  const isUser = message.role === "user";
  const isNotice = !isUser && Boolean(message.notice);
  const segments = useMemo(() => (isUser || isNotice ? [] : turnSegments(message)), [message, isUser, isNotice]);
  const hasContent = segments.length > 0;
  const live = !isUser && !isNotice && (streaming || Boolean(message.progress));

  // The collapse header is the turn's only status row (spec 135 §A). It renders
  // whenever the turn has something to show — prose, a tool call, reasoning —
  // and also while the turn is live with nothing yet, so the empty state is
  // that one slim row rather than a bubble with a placeholder in it.
  const showThinking =
    !isUser &&
    !isNotice &&
    (hasContent ||
      (message.toolHints?.length ?? 0) > 0 ||
      (message.thinkingContent?.length ?? 0) > 0 ||
      live);

  // Shared render-layer cleanup (spec 126 §B): the same text the chat bubble
  // shows is what the session viewer shows — no preamble, no machine lines.
  const cleanContent = useMemo(
    () => cleanRenderedContent(message.content),
    [message.content],
  );

  // A reply carrying a widget needs room: the bubble is otherwise sized to its
  // content (~186px), which squashes charts and tables into an unreadable
  // column. Widening only these bubbles keeps ordinary chat bubbles compact.
  const hasUI = useMemo(() => hasOpenUIBlock(cleanContent), [cleanContent]);

  // Reads the RAW content: the machine lines holding these paths are exactly
  // what cleanRenderedContent strips, so cleaned text could not resolve them.
  const displayMedia = useMemo(() => {
    if (message.media?.length) return message.media;
    return extractMediaPaths(message.content);
  }, [message.media, message.content]);

  return (
    <div
      className={cn(
        "group flex",
        isUser ? "justify-end" : "justify-start",
        animate && "bubble-in",
      )}
      data-testid={isUser ? "message-row-user" : "message-row-assistant"}
    >
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 text-[15px] leading-relaxed",
          hasUI && "w-full",
          isUser
            ? "bg-primary text-primary-foreground py-2"
            : isNotice
              ? "border border-dashed border-border bg-muted/40 py-2 text-[13px] text-muted-foreground"
              : "border border-border bg-card text-card-foreground py-2.5",
        )}
        data-testid={isNotice ? "command-notice" : undefined}
      >
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

        {showThinking && (
          /* ONE header per turn: chevron · Thinking · "6 steps · 2m 14s", with
             the live pulse in this row. The old stack — this header, then a big
             ThinkingIndicator placeholder, then a `working` ReactionChip — was
             three indicators for one turn (spec 135 §A). */
          <ThinkingSection
            toolHints={message.toolHints || []}
            thinkingContent={message.thinkingContent || ""}
            done={!live}
            alwaysShow
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
            <span className="opacity-60">↩ </span>
            {message.replyToContent.length > 80 ? `${message.replyToContent.slice(0, 80)}…` : message.replyToContent}
          </div>
        )}

        {displayMedia.length > 0 && (
          <div className={isUser ? "mb-1" : "mb-2"}>
            <MediaAttachments paths={displayMedia} />
          </div>
        )}

        {isUser ? (
          /* User turns go through the same markdown pipeline as assistant
             ones (job 132 §D) — backticks, fences, lists and links used to
             print literally. Markdown only: no openUI block renderer. */
          <MarkdownBubble content={cleanContent} onPrimary />
        ) : isNotice ? (
          /* Out-of-band acks (`/stop`, `/steer`, `/btw`) are standalone
             messages, not turn segments: they carry their own `content` and no
             segments, so they keep the plain body renderer. */
          <MessageBody content={cleanContent} onOpenFile={onOpenFile} onSend={onSend} />
        ) : (
          /* Every segment of the turn, in order, separated by the trail
             divider (spec 135 §A). Shared with mobile — the frame around the
             prose is identical on both surfaces; only the body renderer is not. */
          <TurnSegments
            segments={segments}
            renderSegment={(text, isStreaming) => (
              <MessageBody content={cleanRenderedContent(text)} streaming={isStreaming} onOpenFile={onOpenFile} onSend={onSend} />
            )}
          />
        )}

        {!isUser && !isNotice && hasContent && (
          <div className="mt-1 -mb-1">
            <MessageActions content={cleanContent} onRegenerate={onRegenerate} onReply={onReply} />
          </div>
        )}
        {isUser && (
          <div className="mt-0.5 flex justify-end opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
            <MessageActions content={cleanContent} onReply={onReply} />
          </div>
        )}
      </div>
    </div>
  );
}
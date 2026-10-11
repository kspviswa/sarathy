import {
  Loader2,
  Mic,
  Paperclip,
  Plus,
  RotateCcw,
  Send,
  Square,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { Logo } from "@/components/logo";
import { QuoteActionBar, QuoteChips, useTextSelection } from "@/components/QuoteAsk";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CodeBlock } from "@/components/CodeBlock";
import { SlashAutocomplete } from "@/components/CommandPalette";
import { ThinkingSection } from "@/components/ThinkingSection";
import { UsageFooter } from "@/components/UsageFooter";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import { cleanRenderedContent, extractMediaPaths } from "@/lib/messageText";
import { SAFE_REHYPE_PLUGINS, SafeLink } from "@/lib/markdown";
import { extractProse, hasOpenUIBlock, UIBlock } from "@/lib/uiBlocks";
import {
  addQuote,
  buildQuotesPayload,
  clearQuotes,
  quoteFromSelection,
  removeQuote,
  type Quote,
  type QuoteChip,
} from "@/lib/quotes";
import type { SlashCommand } from "@/lib/palette";
import type { ChatMessage } from "@/views/ChatView";
import { DASHBOARD_SESSION_KEY } from "@/lib/useLastSession";

interface PendingMedia {
  id: string;
  file: File;
  path?: string;
  uploading: boolean;
  preview?: string;
}

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".svg"]);
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
      <audio controls src={`/api/media?path=${encodeURIComponent(path)}`} className="my-1 w-full" />
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
}) {
  const [input, setInput] = useState("");
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([]);
  const [quoteChips, setQuoteChips] = useState<QuoteChip[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const [slashIndex, setSlashIndex] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const messageListRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isNearBottomRef = useRef(true);

  // Quote-and-ask (spec §F): selection inside the message list surfaces the
  // "Add to follow-up" bar. Shared hook — the desktop ChatView uses the same
  // one, so behavior stays in lockstep across both SPAs.
  const selection = useTextSelection(messageListRef, !streaming);

  const addSelectionAsQuote = useCallback(() => {
    const quote = quoteFromSelection(window.getSelection(), { sourceRole: "assistant" });
    if (!quote) return;
    setQuoteChips((chips) => addQuote(chips, quote));
    window.getSelection()?.removeAllRanges();
    toast.success("Added to follow-up");
  }, []);

  // Notification "Reply" seeds the composer with a quote chip (parity with
  // desktop App's followUpSeed handling).
  useEffect(() => {
    if (!followUpSeed?.text) return;
    setQuoteChips((chips) =>
      addQuote(chips, {
        text: followUpSeed.text,
        source_message_id: `notification-${followUpSeed.nonce}`,
        source_role: "assistant",
      }),
    );
    textareaRef.current?.focus();
  }, [followUpSeed]);

  const checkNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.addEventListener("scroll", checkNearBottom, { passive: true });
    return () => el?.removeEventListener("scroll", checkNearBottom);
  }, [checkNearBottom]);

  useEffect(() => {
    if (isNearBottomRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming]);

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
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
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
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
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
        prev.map((p) => (p.id === item.id ? { ...p, uploading: false, path: result.path } : p)),
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
      const mr = new MediaRecorder(stream, { mimeType: "audio/webm;codecs=opus" });
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
      };
      mr.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        const file = new File(chunks, `voice-${Date.now()}.webm`, { type: "audio/webm" });
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

  const showSlashMenu = /^\/[^\s]*$/.test(input.trim()) && input.trimStart().startsWith("/");

  async function send() {
    const content = input.trim();
    if (!content && !mediaPaths.length && quoteChips.length === 0) return;
    if (!allUploaded) {
      toast.info("Waiting for uploads to finish…");
      return;
    }
    const quotes = buildQuotesPayload(quoteChips);
    setInput("");
    setPendingMedia([]);
    setQuoteChips(clearQuotes());
    try {
      await onSend(
        content,
        mediaPaths.length ? mediaPaths : undefined,
        undefined,
        undefined,
        quotes.length ? quotes : undefined,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send");
    }
  }

  return (
    <div className="flex h-full flex-col" data-testid="mobile-chat">
      <div className="flex items-center justify-between px-4 py-3">
        <h1 className="text-base font-semibold">Chat</h1>
        <div className="flex items-center gap-1">
          {streaming && (
            <Button variant="secondary" size="sm" onClick={() => void onStop()} title="Stop">
              <Square className="size-4" />
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onNewChat} title="New chat">
            <Plus className="size-5" />
            <span className="hidden">New chat</span>
          </Button>
        </div>
      </div>

      <div ref={scrollRef} className="no-scrollbar flex-1 overflow-y-auto px-3 pb-3">
        {messages.length === 0 ? (
          loading ? (
            <div className="flex items-center justify-center gap-2 py-20 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading…
            </div>
          ) : (
            <div className="flex flex-col items-center gap-3 py-20 text-center">
              <Logo size={64} />
              <p className="text-muted-foreground">Say hello to Sarathy anywhere.</p>
            </div>
          )
        ) : null}
        <div ref={messageListRef} className="flex w-full flex-col gap-3" data-testid="mobile-message-list">
          {messages.map((m, i) => (
            <MobileMessage
              key={i}
              message={m}
              onOpenFile={onOpenFile}
              onRegenerate={m.role === "assistant" && !streaming ? onRegenerate : undefined}
              onSend={(text) => void onSend(text, undefined)}
            />
          ))}
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
        {pendingMedia.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {pendingMedia.map((pm) => (
              <div
                key={pm.id}
                className="relative flex items-center gap-2 rounded-lg border border-border bg-card px-2 py-1.5 text-xs"
              >
                {pm.preview ? (
                  <img src={pm.preview} alt="" className="size-10 rounded object-cover" />
                ) : (
                  <span className="flex size-10 items-center justify-center rounded bg-muted text-[10px] text-muted-foreground">
                    {pm.file.name.slice(0, 4)}
                  </span>
                )}
                <span className="max-w-[80px] truncate">{pm.file.name}</span>
                <button onClick={() => removePending(pm.id)} className="text-muted-foreground">
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
                    const match = commands.find((c) => input.trim() === `/${c.name}`);
                    if (match) setInput(`/${match.name} `);
                    return;
                  }
                }
              }}
              placeholder="Message Sarathy…"
              className="w-full !min-h-16 max-h-[200px] resize-none overflow-y-auto text-base"
              rows={1}
              aria-label="Message input"
              data-testid="mobile-composer-input"
            />
            <div className="flex items-center justify-between gap-2" data-testid="mobile-composer-actions">
              <div className="flex items-center gap-1">
                <label
                  htmlFor="attach-file-input"
                  className="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  aria-label="Attach file"
                  role="button"
                >
                  <Paperclip className="size-5" />
                </label>
                <Button
                  variant={isRecording ? "destructive" : "ghost"}
                  size="icon"
                  className="size-11 shrink-0 rounded-md text-muted-foreground hover:text-foreground"
                  onClick={isRecording ? stopRecording : startRecording}
                  aria-label={isRecording ? "Stop recording" : "Record voice"}
                  data-testid="mobile-mic"
                >
                  {isRecording ? <Square className="size-5" /> : <Mic className="size-5" />}
                </Button>
              </div>
              <Button
                size="icon"
                className="size-11 shrink-0 rounded-full"
                onClick={() => void send()}
                disabled={!input.trim() && !mediaPaths.length && quoteChips.length === 0}
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
    </div>
  );
}

function MobileMessage({
  message,
  onOpenFile,
  onRegenerate,
  onSend,
}: {
  message: ChatMessage;
  onOpenFile?: (path: string) => void;
  onRegenerate?: () => void;
  onSend?: (message: string) => void;
}) {
  const isUser = message.role === "user";
  // Shared render-layer cleanup (spec 126 §B).
  const cleanContent = useMemo(
    () => cleanRenderedContent(message.content),
    [message.content],
  );

  // Reads the RAW content: the machine lines holding these paths are exactly
  // what cleanRenderedContent strips.
  const displayMedia = useMemo(() => {
    if (message.media?.length) return message.media;
    return extractMediaPaths(message.content);
  }, [message.media, message.content]);

  const showThinking =
    !isUser && (message.toolHints?.length || 0) + (message.thinkingContent?.length || 0) > 0;
  const isStreaming = message.progress && (message.content?.length ?? 0) === 0;

  return (
    <div className={cn("flex w-full", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[88%] rounded-2xl px-4 py-2.5 text-base leading-relaxed",
          isUser ? "bg-primary text-primary-foreground" : "border border-border bg-card",
        )}
      >
        {showThinking && (
          <ThinkingSection
            toolHints={message.toolHints || []}
            thinkingContent={message.thinkingContent || ""}
            done={!message.progress}
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
          <div className="whitespace-pre-wrap break-words">{cleanContent}</div>
        ) : isStreaming ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className="inline-block size-2 animate-pulse rounded-full bg-primary" />
            thinking…
          </div>
        ) : cleanContent ? (
          <AssistantBody content={cleanContent} onOpenFile={onOpenFile} streaming={message.progress} onSend={onSend} />
        ) : message.progress ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className="inline-block size-2 animate-pulse rounded-full bg-primary" />
            thinking…
          </div>
        ) : null}
        {!isUser && onRegenerate && (
          <button
            onClick={onRegenerate}
            className="mt-2 inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          >
            <RotateCcw className="size-3.5" /> Regenerate
          </button>
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
            a: SafeLink,
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

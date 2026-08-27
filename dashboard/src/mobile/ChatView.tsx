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
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CodeBlock } from "@/components/CodeBlock";
import { ThinkingSection } from "@/components/ThinkingSection";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";
import type { ChatMessage } from "@/views/ChatView";

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
}: {
  messages: ChatMessage[];
  streaming: boolean;
  loading?: boolean;
  onSend: (content: string, media?: string[], replyTo?: string | null, replyToContent?: string) => Promise<void> | void;
  onStop: () => Promise<void> | void;
  onNewChat: () => void;
  onOpenFile?: (path: string) => void;
  onRegenerate?: () => void;
}) {
  const [input, setInput] = useState("");
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([]);
  const [isRecording, setIsRecording] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isNearBottomRef = useRef(true);

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

  // Enter inserts a newline (native textarea); Ctrl/Cmd+Enter or Send sends.
  useEffect(() => {
    const el = textareaRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
    }
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

  async function send() {
    const content = input.trim();
    if (!content && !mediaPaths.length) return;
    if (!allUploaded) {
      toast.info("Waiting for uploads to finish…");
      return;
    }
    setInput("");
    setPendingMedia([]);
    try {
      await onSend(content, mediaPaths.length ? mediaPaths : undefined);
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
        <div className="flex w-full flex-col gap-3">
          {messages.map((m, i) => (
            <MobileMessage
              key={i}
              message={m}
              onOpenFile={onOpenFile}
              onRegenerate={m.role === "assistant" && !streaming ? onRegenerate : undefined}
            />
          ))}
        </div>
      </div>

      <div className="safe-bottom border-t bg-background/95 px-3 pb-2 pt-2 backdrop-blur">
        <input
          ref={fileInputRef}
          type="file"
          multiple
          className="hidden"
          onChange={(e) => {
            if (e.target.files?.length) addFiles(e.target.files);
            e.target.value = "";
          }}
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
        <div className="flex items-end gap-2">
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            onClick={() => fileInputRef.current?.click()}
            aria-label="Attach file"
          >
            <Paperclip className="size-5" />
          </Button>
          <Button
            variant={isRecording ? "destructive" : "ghost"}
            size="icon"
            className="size-11 shrink-0"
            onClick={isRecording ? stopRecording : startRecording}
            aria-label={isRecording ? "Stop recording" : "Record voice"}
          >
            {isRecording ? <Square className="size-5" /> : <Mic className="size-5" />}
          </Button>
          <Textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Message Sarathy…"
            className="min-h-12 max-h-32 flex-1 resize-none overflow-y-auto text-base"
            rows={1}
            aria-label="Message input"
          />
          {streaming ? (
            <Button variant="secondary" size="icon" className="size-11 shrink-0" onClick={() => void onStop()} aria-label="Stop">
              <Square />
            </Button>
          ) : (
            <Button
              size="icon"
              className="size-11 shrink-0"
              onClick={() => void send()}
              disabled={!input.trim() && !mediaPaths.length}
              aria-label="Send"
            >
              <Send className="size-5" />
            </Button>
          )}
        </div>
        <p className="mt-1 px-1 text-center text-[11px] text-muted-foreground">
          Enter = newline · Ctrl+Enter = send
        </p>
      </div>
    </div>
  );
}

function MobileMessage({
  message,
  onOpenFile,
  onRegenerate,
}: {
  message: ChatMessage;
  onOpenFile?: (path: string) => void;
  onRegenerate?: () => void;
}) {
  const isUser = message.role === "user";
  const cleanContent = useMemo(() => {
    if (!message.content) return "";
    return message.content
      .split("\n")
      .filter((line) => !/^\[(image|voice|audio|file): .+\]$/.test(line.trim()))
      .join("\n")
      .trim();
  }, [message.content]);

  const displayMedia = useMemo(() => {
    if (message.media?.length) return message.media;
    const paths: string[] = [];
    for (const line of message.content.split("\n")) {
      const m = line.trim().match(/^\[(image|voice|audio|file): (.+)\]$/);
      if (m) paths.push(m[2]);
    }
    return paths;
  }, [message.media, message.content]);

  const showThinking =
    !isUser && (message.toolHints?.length || 0) + (message.thinkingContent?.length || 0) > 0;
  const isStreaming = message.progress && message.content.length === 0;

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
          <div className="md">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
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
              {cleanContent}
            </ReactMarkdown>
            {message.progress && <span className="streaming-caret" />}
          </div>
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

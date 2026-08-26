import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  Download,
  Mic,
  Paperclip,
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
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { CodeBlock } from "@/components/CodeBlock";
import { ThinkingSection } from "@/components/ThinkingSection";
import { cn } from "@/lib/utils";
import { api } from "@/lib/api";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  progress?: boolean;
  toolHint?: string;
  toolHints?: string[];
  thinkingContent?: string;
  messageId?: string;
  media?: string[];
  replyTo?: string | null;
  replyToContent?: string;
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
      <audio
        controls
        src={`/api/media?path=${encodeURIComponent(path)}`}
        className="my-1 w-full max-w-xs"
      />
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
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        title="Good response"
      >
        <ArrowUpFromLine className="size-3.5" />
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 text-muted-foreground hover:text-foreground"
        title="Bad response"
      >
        <ArrowDownToLine className="size-3.5" />
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

function ReplySnippet({ content, onCancel }: { content: string; onCancel: () => void }) {
  const snippet = content.length > 120 ? content.slice(0, 120) + "…" : content;
  return (
    <div className="flex items-start gap-2 rounded-t-xl border border-b-0 border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
      <span className="mt-0.5 shrink-0 opacity-60">↩</span>
      <span className="flex-1 truncate">{snippet}</span>
      <Button
        variant="ghost"
        size="icon"
        className="size-5 shrink-0 text-muted-foreground hover:text-foreground"
        onClick={onCancel}
      >
        <X className="size-3" />
      </Button>
    </div>
  );
}

export function ChatView({
  messages,
  streaming,
  onSend,
  onStop,
  onOpenFile,
  onRegenerate,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  onSend: (content: string, media?: string[], replyTo?: string | null, replyToContent?: string) => Promise<void> | void;
  onStop: () => Promise<void> | void;
  onOpenFile?: (path: string) => void;
  onRegenerate?: () => void;
}) {
  const [input, setInput] = useState("");
  const [pendingMedia, setPendingMedia] = useState<PendingMedia[]>([]);
  const [replyToMsg, setReplyToMsg] = useState<ChatMessage | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isNearBottomRef = useRef(true);
  const recordingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const checkNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = 100;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.addEventListener("scroll", checkNearBottom, { passive: true });
    return () => el?.removeEventListener("scroll", checkNearBottom);
  }, [checkNearBottom]);

  useEffect(() => {
    if (isNearBottomRef.current) {
      const el = scrollRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    }
  }, [messages, streaming]);

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
    for (const item of items) {
      uploadPending(item);
    }
  }, []);

  const uploadPending = useCallback(async (item: PendingMedia) => {
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

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback(() => setDragOver(false), []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const items = e.clipboardData.items;
      const files: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === "file") {
          const f = items[i].getAsFile();
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
        const blob = new Blob(chunks, { type: "audio/webm" });
        const file = new File([blob], `voice-${Date.now()}.webm`, { type: "audio/webm" });
        addFiles([file]);
      };
      mediaRecorderRef.current = mr;
      mr.start();
      setIsRecording(true);
    } catch (err) {
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
    const replyTo = replyToMsg?.messageId ?? null;
    const replyToContent = replyToMsg?.content;
    setInput("");
    setPendingMedia([]);
    setReplyToMsg(null);
    try {
      await onSend(content, mediaPaths.length ? mediaPaths : undefined, replyTo, replyToContent);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send");
    }
  }

  return (
    <div
      className="flex h-full flex-col"
      onDrop={handleDrop}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
    >
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

      {dragOver && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm border-2 border-dashed border-primary/40 pointer-events-none">
          <div className="flex flex-col items-center gap-2 text-muted-foreground">
            <Paperclip className="size-8" />
            <span className="text-sm font-medium">Drop files here</span>
          </div>
        </div>
      )}

      <div ref={scrollRef} className="no-scrollbar flex-1 overflow-y-auto">
        <div className="mx-auto flex w-full max-w-2xl flex-col gap-4 px-4 py-4">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <Logo size={56} />
              <p className="text-muted-foreground">Say hello to Sarathy from anywhere.</p>
            </div>
          ) : null}
          {messages.map((m, i) => (
            <MessageRow
              key={i}
              message={m}
              onOpenFile={onOpenFile}
              onRegenerate={m.role === "assistant" && !streaming ? onRegenerate : undefined}
              onReply={() => setReplyToMsg(m)}
            />
          ))}
          {streaming &&
            messages.length > 0 &&
            messages[messages.length - 1].role === "user" && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <span className="inline-block size-2 animate-pulse rounded-full bg-primary" />
                Sarathy is responding…
              </div>
            )}
        </div>
      </div>

      <div className="border-t bg-background/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto w-full max-w-2xl">
          {(pendingMedia.length > 0 || replyToMsg) && (
            <div className="mb-2 flex flex-col gap-1 rounded-xl border border-border bg-muted/30 p-2">
              {replyToMsg && (
                <ReplySnippet
                  content={replyToMsg.content}
                  onCancel={() => setReplyToMsg(null)}
                />
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
                        <span className="size-10 flex items-center justify-center rounded bg-muted text-muted-foreground text-[10px]">
                          {pm.file.name.slice(0, 4)}
                        </span>
                      )}
                      <span className="max-w-[100px] truncate text-foreground">
                        {pm.file.name}
                      </span>
                      {pm.uploading && (
                        <span className="size-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                      )}
                      {!pm.uploading && pm.path && (
                        <Check className="size-3 text-green-500" />
                      )}
                      <button
                        onClick={() => removePending(pm.id)}
                        className="ml-0.5 text-muted-foreground hover:text-foreground"
                      >
                        <X className="size-3" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex items-end gap-2">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-9 shrink-0 text-muted-foreground hover:text-foreground"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Paperclip className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Attach file</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant={isRecording ? "destructive" : "ghost"}
                  size="icon"
                  className="size-9 shrink-0"
                  onClick={isRecording ? stopRecording : startRecording}
                >
                  {isRecording ? <Square className="size-4" /> : <Mic className="size-4" />}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {isRecording ? "Stop recording" : "Record voice"}
              </TooltipContent>
            </Tooltip>

            <Textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              onPaste={handlePaste}
              placeholder="Message Sarathy…"
              className="max-h-32 min-h-12 flex-1 resize-none"
              rows={1}
            />

            {streaming ? (
              <Button variant="secondary" size="icon" onClick={() => void onStop()} title="Stop">
                <Square />
              </Button>
            ) : (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon"
                    onClick={() => void send()}
                    disabled={!input.trim() && !mediaPaths.length}
                  >
                    <Send className="size-4" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top">Send</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  onOpenFile,
  onRegenerate,
  onReply,
}: {
  message: ChatMessage;
  onOpenFile?: (path: string) => void;
  onRegenerate?: () => void;
  onReply?: () => void;
}) {
  const isUser = message.role === "user";
  const isStreaming = message.progress && message.content.length === 0;
  const hasContent = message.content.length > 0;
  const showThinking =
    !isUser && (message.toolHints?.length || 0) + (message.thinkingContent?.length || 0) > 0;

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

  return (
    <div className={cn("group flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground"
            : "border border-border bg-card text-card-foreground",
        )}
      >
        {showThinking && (
          <ThinkingSection
            toolHints={message.toolHints || []}
            thinkingContent={message.thinkingContent || ""}
            onOpenFile={onOpenFile}
          />
        )}
        {message.replyTo && message.replyToContent && (
          <div className={cn(
            "mb-2 rounded-lg border px-2.5 py-1.5 text-xs opacity-70",
            isUser ? "border-primary-foreground/30" : "border-border",
          )}>
            <span className="opacity-60">↩ </span>
            {message.replyToContent.length > 80
              ? message.replyToContent.slice(0, 80) + "…"
              : message.replyToContent}
          </div>
        )}
        {displayMedia.length > 0 && (
          <div className={isUser ? "mb-1" : "mb-2"}>
            <MediaAttachments paths={displayMedia} />
          </div>
        )}
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{cleanContent}</div>
        ) : isStreaming ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className="inline-block size-2 animate-pulse rounded-full bg-primary" />
            thinking…
          </div>
        ) : hasContent ? (
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
            {message.progress && (
              <span className="streaming-caret" />
            )}
          </div>
        ) : message.progress ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className="inline-block size-2 animate-pulse rounded-full bg-primary" />
            thinking…
          </div>
        ) : null}
        {!isUser && hasContent && (
          <div className="mt-1 -mb-1">
            <MessageActions content={cleanContent} onRegenerate={onRegenerate} onReply={onReply} />
          </div>
        )}
        {isUser && (
          <div className="mt-1 -mb-1 opacity-0 transition-opacity group-hover:opacity-100">
            <div className="flex justify-end">
              <MessageActions content={cleanContent} onReply={onReply} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

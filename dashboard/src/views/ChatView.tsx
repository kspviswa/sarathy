import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Copy,
  RotateCcw,
  Square,
  WandSparkles,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { CodeBlock } from "@/components/CodeBlock";
import { ThinkingSection } from "@/components/ThinkingSection";
import { cn } from "@/lib/utils";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  progress?: boolean;
  toolHint?: string;
  toolHints?: string[];
  thinkingContent?: string;
  messageId?: string;
}

interface MessageActionsProps {
  content: string;
  onRegenerate?: () => void;
}

function MessageActions({ content, onRegenerate }: MessageActionsProps) {
  const [copied, setCopied] = useState(false);

  const copyMessage = useCallback(() => {
    void navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  return (
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
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
  onSend: (content: string) => Promise<void> | void;
  onStop: () => Promise<void> | void;
  onOpenFile?: (path: string) => void;
  onRegenerate?: () => void;
}) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const isNearBottomRef = useRef(true);

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

  async function send() {
    const content = input.trim();
    if (!content) return;
    setInput("");
    try {
      await onSend(content);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to send");
    }
  }

  return (
    <div className="flex h-full flex-col">
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
            />
          ))}
          {streaming &&
            (() => {
              const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");
              const hasContent = lastAssistant && lastAssistant.content.length > 0;
              return !hasContent ? (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <span className="inline-block size-2 animate-pulse rounded-full bg-primary" />
                  Sarathy is responding…
                </div>
              ) : null;
            })()}
        </div>
      </div>

      <div className="border-t bg-background/95 px-4 py-3 backdrop-blur">
        <div className="mx-auto flex w-full max-w-2xl items-end gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            placeholder="Message Sarathy…"
            className="max-h-32 min-h-12 flex-1 resize-none"
            rows={1}
          />
          {streaming ? (
            <Button variant="secondary" size="icon" onClick={() => void onStop()} title="Stop">
              <Square />
            </Button>
          ) : (
            <Button size="icon" onClick={() => void send()} disabled={!input.trim()}>
              <WandSparkles />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}

function MessageRow({
  message,
  onOpenFile,
  onRegenerate,
}: {
  message: ChatMessage;
  onOpenFile?: (path: string) => void;
  onRegenerate?: () => void;
}) {
  const isUser = message.role === "user";
  const isStreaming = message.progress && message.content.length === 0;
  const hasContent = message.content.length > 0;
  const showThinking =
    !isUser && (message.toolHints?.length || 0) + (message.thinkingContent?.length || 0) > 0;

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
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
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
              {message.content}
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
            <MessageActions content={message.content} onRegenerate={onRegenerate} />
          </div>
        )}
      </div>
    </div>
  );
}

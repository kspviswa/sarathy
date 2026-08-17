import { Square, WandSparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";

import { Logo } from "@/components/logo";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  progress?: boolean;
  toolHint?: string;
}

export function ChatView({
  messages,
  streaming,
  onSend,
  onStop,
}: {
  messages: ChatMessage[];
  streaming: boolean;
  onSend: (content: string) => Promise<void> | void;
  onStop: () => Promise<void> | void;
}) {
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
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
            <MessageRow key={i} message={m} />
          ))}
          {streaming ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="inline-block size-2 animate-pulse rounded-full bg-primary" />
              Sarathy is responding…
            </div>
          ) : null}
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

function MessageRow({ message }: { message: ChatMessage }) {
  const isUser = message.role === "user";
  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[85%] rounded-2xl px-4 py-2.5 text-[15px] leading-relaxed",
          isUser
            ? "bg-primary text-primary-foreground"
            : "border border-border bg-card text-card-foreground",
        )}
      >
        {message.toolHint && !isUser ? (
          <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <WandSparkles className="size-3" />
            {message.toolHint}
          </div>
        ) : null}
        {isUser ? (
          <div className="whitespace-pre-wrap break-words">{message.content}</div>
        ) : message.progress ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <span className="inline-block size-2 animate-pulse rounded-full bg-primary" />
            thinking…
          </div>
        ) : (
          <div className="md">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{message.content}</ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
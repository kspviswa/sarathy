import { Check, ChevronRight, Loader2, Wrench } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";

interface ThinkingSectionProps {
  toolHints: string[];
  thinkingContent: string;
  done?: boolean;
  isOpen?: boolean;
  onOpenFile?: (path: string) => void;
}

function formatElapsed(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

export function ThinkingSection({
  toolHints,
  thinkingContent,
  done = false,
  isOpen: controlledOpen,
  onOpenFile,
}: ThinkingSectionProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlledOpen ?? internalOpen;
  const startTimeRef = useRef(Date.now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (done) {
      setElapsed(Date.now() - startTimeRef.current);
      return;
    }
    const id = setInterval(() => {
      setElapsed(Date.now() - startTimeRef.current);
    }, 1000);
    return () => clearInterval(id);
  }, [done]);

  const hasContent = toolHints.length > 0 || thinkingContent.length > 0;
  if (!hasContent) return null;

  return (
    <div className="mt-1 border-t border-border/40">
      <button
        type="button"
        onClick={() => setInternalOpen(!internalOpen)}
        aria-expanded={isOpen}
        className="flex w-full items-center gap-1.5 py-2 text-left text-xs text-muted-foreground/80 transition-colors active:text-muted-foreground"
      >
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform duration-200", isOpen && "rotate-90")}
        />
        {done ? (
          <Check className="size-3 shrink-0 text-green-500" />
        ) : (
          <Loader2 className="size-3 shrink-0 animate-spin text-primary/60" />
        )}
        <span className="font-medium">
          {done ? `Thought for ${formatElapsed(elapsed)}` : "Thinking"}
        </span>
        {toolHints.length > 0 && (
          <span className="ml-auto text-muted-foreground/50">
            {toolHints.length} tool call{toolHints.length !== 1 ? "s" : ""}
          </span>
        )}
      </button>
      {isOpen && (
        <div className="space-y-2 pb-2.5">
          {thinkingContent && (
            <div className="text-xs leading-relaxed text-muted-foreground/80">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code: ({ children, className, ...props }) => {
                    const isBlock = className?.startsWith("language-");
                    if (isBlock) {
                      return <CodeBlock className={className} onOpenFile={onOpenFile}>{String(children)}</CodeBlock>;
                    }
                    return (
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]" {...props}>
                        {children}
                      </code>
                    );
                  },
                }}
              >
                {thinkingContent}
              </ReactMarkdown>
            </div>
          )}
          {toolHints.length > 0 && (
            <div className="space-y-1">
              {toolHints.map((hint, i) => (
                <div key={i} className="flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground/60">
                  <Wrench className="size-3 shrink-0 opacity-70" />
                  <span className="truncate">{hint}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
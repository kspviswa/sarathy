import { ChevronRight, Loader2, Wrench } from "lucide-react";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@/lib/utils";
import { CodeBlock } from "./CodeBlock";

interface ThinkingSectionProps {
  toolHints: string[];
  thinkingContent: string;
  isOpen?: boolean;
  onOpenFile?: (path: string) => void;
}

export function ThinkingSection({
  toolHints,
  thinkingContent,
  isOpen: controlledOpen,
  onOpenFile,
}: ThinkingSectionProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isOpen = controlledOpen ?? internalOpen;

  const hasContent = toolHints.length > 0 || thinkingContent.length > 0;
  if (!hasContent) return null;

  return (
    <div className="my-2 rounded-lg border border-border/50 bg-muted/30">
      <button
        onClick={() => setInternalOpen(!internalOpen)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-muted-foreground transition-colors hover:bg-muted/50"
      >
        <ChevronRight
          className={cn("size-3.5 shrink-0 transition-transform", isOpen && "rotate-90")}
        />
        <Loader2 className="size-3.5 shrink-0 animate-pulse text-primary/70" />
        <span className="font-medium">Thinking</span>
        {toolHints.length > 0 && (
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px]">
            {toolHints.length} tool call{toolHints.length !== 1 ? "s" : ""}
          </span>
        )}
      </button>
      {isOpen && (
        <div className="border-t border-border/50 px-3 py-2.5 text-xs">
          {thinkingContent && (
            <div className="mb-2 text-muted-foreground/80">
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                  code: ({ children, className, ...props }) => {
                    const isBlock = className?.startsWith("language-");
                    if (isBlock) {
                      return <CodeBlock className={className} onOpenFile={onOpenFile}>{String(children)}</CodeBlock>;
                    }
                    return (
                      <code className="rounded bg-muted px-1 py-0.5 font-mono text-[12px]" {...props}>
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
                <div key={i} className="flex items-center gap-1.5 text-muted-foreground/70">
                  <Wrench className="size-3 shrink-0" />
                  <span className="font-mono text-[11px]">{hint}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

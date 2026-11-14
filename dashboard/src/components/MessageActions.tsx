import { Check, Copy, RotateCcw } from "lucide-react";
import { useCallback, useState } from "react";

import { Button } from "@/components/ui/button";
import { useCoarsePointer } from "@/lib/useCoarsePointer";
import { cn } from "@/lib/utils";

/**
 * Reply / Copy / Regenerate affordances on a chat bubble (spec 175 §D).
 *
 * On a user (`bg-primary`) bubble, muted-foreground vanishes into the fill —
 * so `onPrimary` switches to primary-foreground-based colours. Hover-reveal
 * stays for fine pointers; coarse/touch keeps the row visible at ~70%.
 *
 * Native `title`/`aria-label` only — no Radix Tooltip — so both shells and
 * test harnesses can mount this without a TooltipProvider.
 */
export function MessageActions({
  content,
  onRegenerate,
  onReply,
  onPrimary = false,
}: {
  content: string;
  onRegenerate?: () => void;
  onReply?: () => void;
  /** Actions sit on a primary-filled (user) bubble. */
  onPrimary?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const coarse = useCoarsePointer();

  const copyMessage = useCallback(() => {
    void navigator.clipboard.writeText(content);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [content]);

  // Full primary-foreground (not /70): against terracotta/violet fills the
  // translucent form dips under WCAG 3:1 for icons (spec 175 §I).
  const iconClass = onPrimary
    ? "text-primary-foreground hover:bg-primary-foreground/15"
    : "text-muted-foreground hover:text-foreground";

  return (
    <div
      className={cn(
        "flex items-center gap-0.5 transition-opacity",
        // Touch / coarse pointer: always discoverable at ~70%. Fine pointers
        // keep the hover reveal; max-md covers phones that still report hover.
        coarse
          ? "opacity-70"
          : "opacity-0 group-hover:opacity-100 focus-within:opacity-100 max-md:opacity-70",
      )}
      data-testid="message-actions"
      data-on-primary={onPrimary ? "true" : "false"}
    >
      {onReply && (
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-7", iconClass)}
          onClick={onReply}
          aria-label="Reply"
          title="Reply"
          data-testid="message-reply"
        >
          <svg
            className="size-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <polyline points="9 14 4 9 9 4" />
            <path d="M20 20v-7a4 4 0 0 0-4-4H4" />
          </svg>
        </Button>
      )}
      <Button
        variant="ghost"
        size="icon"
        className={cn("size-7", iconClass)}
        onClick={copyMessage}
        title="Copy"
        aria-label="Copy"
        data-testid="message-action-copy"
      >
        {copied ? (
          <Check className="size-3.5" />
        ) : (
          <Copy className="size-3.5" />
        )}
      </Button>
      {onRegenerate && (
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-7", iconClass)}
          onClick={onRegenerate}
          title="Regenerate"
          aria-label="Regenerate"
          data-testid="message-action-regenerate"
        >
          <RotateCcw className="size-3.5" />
        </Button>
      )}
    </div>
  );
}

import { useEffect, useState } from "react";
import { Quote, X } from "lucide-react";

import { chipLabel, type QuoteChip } from "@/lib/quotes";

/**
 * Floating selection action bar.
 *
 * Selecting text inside an assistant message surfaces this bar with
 * "Add to follow-up". It hides whenever the selection collapses or moves
 * outside the message, and only shows for assistant text (the spec scopes
 * quote-and-ask to assistant messages).
 */
export function QuoteActionBar({
  visible,
  rect,
  onAdd,
}: {
  visible: boolean;
  rect: { top: number; left: number } | null;
  onAdd: () => void;
}) {
  if (!visible || !rect) return null;

  return (
    <button
      type="button"
      onMouseDown={(e) => {
        // Keep the selection alive: mousedown on a button would otherwise
        // collapse the selection before the click handler runs.
        e.preventDefault();
      }}
      onClick={onAdd}
      data-testid="quote-action-bar"
      className="fixed z-50 inline-flex items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-foreground shadow-lg"
      style={{ top: Math.max(8, rect.top - 40), left: Math.max(8, rect.left) }}
    >
      <Quote className="size-3.5" />
      Add to follow-up
    </button>
  );
}

/** Dismissible `@`-prefixed quote chips above the composer. */
export function QuoteChips({
  chips,
  onRemove,
}: {
  chips: QuoteChip[];
  onRemove: (id: string) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <div
      className="mb-2 flex flex-wrap gap-1.5"
      data-testid="quote-chips"
      aria-label="Quoted passages to include with your next message"
    >
      {chips.map((chip) => (
        <span
          key={chip.id}
          className="inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-muted/60 py-1 pl-2 pr-1 text-xs text-muted-foreground"
          data-testid="quote-chip"
        >
          <span className="max-w-[22rem] truncate">{chipLabel(chip)}</span>
          <button
            type="button"
            onClick={() => onRemove(chip.id)}
            className="rounded-full p-0.5 hover:bg-background hover:text-foreground"
            aria-label="Remove quoted passage"
          >
            <X className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * Tracks the current text selection inside a container element.
 *
 * Returns whether a usable selection exists plus its viewport rect, so the
 * action bar can be positioned above it. Listens on `mouseup` and `selectionchange`
 * and clears on collapse so the bar never lingers.
 */
export function useTextSelection(
  containerRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [visible, setVisible] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null);

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      return;
    }

    const update = () => {
      const selection = window.getSelection();
      const el = containerRef.current;
      if (!selection || selection.isCollapsed || selection.rangeCount === 0 || !el) {
        setVisible(false);
        return;
      }
      const range = selection.getRangeAt(0);
      // Only selections genuinely inside this container count.
      if (!el.contains(range.commonAncestorContainer)) {
        setVisible(false);
        return;
      }
      const text = selection.toString().replace(/\s+/g, " ").trim();
      if (!text) {
        setVisible(false);
        return;
      }
      const domRect = range.getBoundingClientRect();
      setRect({ top: domRect.top, left: domRect.left });
      setVisible(true);
    };

    document.addEventListener("selectionchange", update);
    document.addEventListener("mouseup", update);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("mouseup", update);
    };
  }, [containerRef, enabled]);

  return { visible, rect };
}
import { useEffect, useRef, useState } from "react";
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
 * Returns whether a usable selection exists, its viewport rect, and the selected
 * text itself (captured the moment the selection is made).
 *
 * Why all three:
 * - Touch selections do NOT reliably fire `selectionchange` (iOS especially) and
 *   never fire `mouseup`, so we also listen for `touchend` and `contextmenu`.
 *   Without those the selection bar simply never appears on a phone.
 * - Once shown, we hide on a short delay rather than instantly: tapping the bar
 *   collapses the live selection first, and an immediate hide would unmount the
 *   button before its click lands. The captured `text` is what the tap actually
 *   quotes, so the quote survives the collapse.
 */
export function useTextSelection(
  containerRef: React.RefObject<HTMLElement | null>,
  enabled: boolean,
) {
  const [visible, setVisible] = useState(false);
  const [rect, setRect] = useState<{ top: number; left: number } | null>(null);
  const [text, setText] = useState("");
  const hideTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) {
      setVisible(false);
      setText("");
      return;
    }

    const cancelHide = () => {
      if (hideTimer.current) {
        clearTimeout(hideTimer.current);
        hideTimer.current = null;
      }
    };

    const update = () => {
      const selection = window.getSelection();
      const el = containerRef.current;
      const usable =
        selection &&
        !selection.isCollapsed &&
        selection.rangeCount > 0 &&
        el &&
        el.contains(selection.getRangeAt(0).commonAncestorContainer);

      const selected = usable
        ? selection!.toString().replace(/\s+/g, " ").trim()
        : "";

      if (!usable || !selected) {
        // Defer: a tap on the action bar collapses the selection first.
        cancelHide();
        hideTimer.current = setTimeout(() => {
          setVisible(false);
          setText("");
        }, 300);
        return;
      }

      cancelHide();
      const domRect = selection!.getRangeAt(0).getBoundingClientRect();
      setRect({ top: domRect.top, left: domRect.left });
      setText(selected);
      setVisible(true);
    };

    // selectionchange + mouseup: pointer/desktop. touchend + contextmenu: touch.
    const events: Array<keyof DocumentEventMap> = [
      "selectionchange",
      "mouseup",
      "touchend",
      "contextmenu",
      "keyup",
    ];
    events.forEach((e) => document.addEventListener(e, update));
    return () => {
      cancelHide();
      events.forEach((e) => document.removeEventListener(e, update));
    };
  }, [containerRef, enabled]);

  return { visible, rect, text };
}
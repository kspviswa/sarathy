import {
  Bold,
  Code2,
  Eye,
  EyeOff,
  Italic,
  Link2,
  List,
} from "lucide-react";
import { useCallback, type RefObject } from "react";

import {
  ChatFontScaleControl,
  useComposerFontScale,
} from "@/components/ChatFontScaleControl";
import { MarkdownBubble } from "@/components/MarkdownBubble";
import {
  applyFormatAction,
  type FormatAction,
} from "@/lib/composerFormat";
import { cn } from "@/lib/utils";

/**
 * Formatting toolbar + preview toggle for the chat composer (spec 175 §C).
 *
 * Declared once and mounted by both shells. Wraps/inserts Markdown around the
 * current selection and restores focus + selection afterwards.
 *
 * Uses native `title`/`aria-label` (not Radix Tooltip) so the shared module
 * does not require a TooltipProvider in every shell/test harness.
 *
 * Spec 176 §B: A−/A+ sits next to the preview toggle and scales only composer
 * text (own persisted value).
 */
export function ComposerFormatToolbar({
  value,
  onChange,
  textareaRef,
  preview,
  onPreviewChange,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  preview: boolean;
  onPreviewChange: (next: boolean) => void;
  className?: string;
}) {
  const {
    scale: composerScale,
    increase: increaseComposer,
    decrease: decreaseComposer,
    reset: resetComposer,
  } = useComposerFontScale();
  const apply = useCallback(
    (action: FormatAction) => {
      const el = textareaRef.current;
      const start = el?.selectionStart ?? value.length;
      const end = el?.selectionEnd ?? start;
      const result = applyFormatAction(value, start, end, action);
      onChange(result.value);
      // Restore focus + selection after React commits the new value.
      requestAnimationFrame(() => {
        const target = textareaRef.current;
        if (!target) return;
        target.focus();
        target.setSelectionRange(result.selectionStart, result.selectionEnd);
      });
    },
    [onChange, textareaRef, value],
  );

  const buttons: Array<{
    action: FormatAction;
    label: string;
    icon: typeof Bold;
  }> = [
    { action: "bold", label: "Bold", icon: Bold },
    { action: "italic", label: "Italic", icon: Italic },
    { action: "code", label: "Inline code", icon: Code2 },
    { action: "list", label: "Bulleted list", icon: List },
    { action: "link", label: "Link", icon: Link2 },
  ];

  return (
    <div
      className={cn(
        "mb-1.5 flex items-center gap-0.5 overflow-x-auto",
        className,
      )}
      data-testid="composer-format-toolbar"
      role="toolbar"
      aria-label="Message formatting"
    >
      {buttons.map(({ action, label, icon: Icon }) => (
        <button
          key={action}
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => apply(action)}
          disabled={preview}
          aria-label={label}
          title={label}
          data-testid={`composer-format-${action}`}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-40"
        >
          <Icon className="size-3.5" />
        </button>
      ))}

      <div className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true" />

      <button
        type="button"
        onClick={() => onPreviewChange(!preview)}
        aria-label={preview ? "Edit" : "Preview"}
        aria-pressed={preview}
        title={preview ? "Back to editing" : "Preview Markdown"}
        data-testid="composer-preview-toggle"
        className={cn(
          "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium transition-colors",
          preview
            ? "bg-accent text-foreground"
            : "text-muted-foreground hover:bg-accent hover:text-foreground",
        )}
      >
        {preview ? (
          <EyeOff className="size-3.5" />
        ) : (
          <Eye className="size-3.5" />
        )}
        {preview ? "Edit" : "Preview"}
      </button>

      <div className="mx-1 h-4 w-px shrink-0 bg-border" aria-hidden="true" />

      <ChatFontScaleControl
        scale={composerScale}
        onIncrease={increaseComposer}
        onDecrease={decreaseComposer}
        onReset={resetComposer}
        compact
        testIdPrefix="composer-font"
        ariaLabel="Composer text size"
        className="shrink-0"
      />
    </div>
  );
}

/** Live Markdown preview pane — reuses MarkdownBubble's pipeline. */
export function ComposerMarkdownPreview({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "min-h-16 max-h-[200px] overflow-y-auto rounded-lg border border-border bg-muted/30 px-3.5 py-3 text-base",
        className,
      )}
      data-testid="composer-markdown-preview"
      data-chat-composer=""
      aria-live="polite"
    >
      {content.trim() ? (
        <MarkdownBubble content={content} />
      ) : (
        <span className="text-sm text-muted-foreground">Nothing to preview yet.</span>
      )}
    </div>
  );
}

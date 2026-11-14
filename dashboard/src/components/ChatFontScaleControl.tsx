import { useCallback, useEffect, useState } from "react";

import {
  CHAT_FONT_SCALE_DEFAULT,
  CHAT_FONT_SCALE_KEY,
  chatFontScaleStyle,
  nextChatFontScale,
  readChatFontScale,
  writeChatFontScale,
} from "@/lib/chatFontScale";
import {
  COMPOSER_FONT_SCALE_DEFAULT,
  COMPOSER_FONT_SCALE_KEY,
  composerFontScaleStyle,
  nextComposerFontScale,
  readComposerFontScale,
  writeComposerFontScale,
} from "@/lib/composerFontScale";
import { cn } from "@/lib/utils";

/**
 * A− / A+ / reset control for text size (spec 175 §F / 176 §A/§B).
 *
 * Shared by both shells. Persists to localStorage and exposes the current
 * scale so a parent can set the matching CSS custom property.
 */
export function useChatFontScale() {
  const [scale, setScaleState] = useState<number>(() => readChatFontScale());

  useEffect(() => {
    writeChatFontScale(scale);
  }, [scale]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== CHAT_FONT_SCALE_KEY) return;
      setScaleState(readChatFontScale());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setScale = useCallback((next: number) => {
    setScaleState(next);
  }, []);

  const increase = useCallback(() => {
    setScaleState((s) => nextChatFontScale(s, 1));
  }, []);

  const decrease = useCallback(() => {
    setScaleState((s) => nextChatFontScale(s, -1));
  }, []);

  const reset = useCallback(() => {
    setScaleState(CHAT_FONT_SCALE_DEFAULT);
  }, []);

  return {
    scale,
    setScale,
    increase,
    decrease,
    reset,
    style: chatFontScaleStyle(scale),
  };
}

function applyComposerScaleVar(scale: number) {
  if (typeof document === "undefined") return;
  document.documentElement.style.setProperty(
    "--composer-font-scale",
    String(scale),
  );
}

/** Independent composer size (spec 176 §B). */
export function useComposerFontScale() {
  const [scale, setScaleState] = useState<number>(() => {
    const initial = readComposerFontScale();
    applyComposerScaleVar(initial);
    return initial;
  });

  useEffect(() => {
    writeComposerFontScale(scale);
    applyComposerScaleVar(scale);
  }, [scale]);

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== COMPOSER_FONT_SCALE_KEY) return;
      setScaleState(readComposerFontScale());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const increase = useCallback(() => {
    setScaleState((s) => nextComposerFontScale(s, 1));
  }, []);

  const decrease = useCallback(() => {
    setScaleState((s) => nextComposerFontScale(s, -1));
  }, []);

  const reset = useCallback(() => {
    setScaleState(COMPOSER_FONT_SCALE_DEFAULT);
  }, []);

  return {
    scale,
    increase,
    decrease,
    reset,
    style: composerFontScaleStyle(scale),
  };
}

export function ChatFontScaleControl({
  scale,
  onIncrease,
  onDecrease,
  onReset,
  compact = false,
  className,
  testIdPrefix = "chat-font",
  ariaLabel = "Chat text size",
}: {
  scale: number;
  onIncrease: () => void;
  onDecrease: () => void;
  onReset: () => void;
  compact?: boolean;
  className?: string;
  /** Prefix for data-testid values (`chat-font` or `composer-font`). */
  testIdPrefix?: string;
  ariaLabel?: string;
}) {
  const pct = Math.round(scale * 100);
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/60",
        compact ? "h-9 px-0.5" : "h-9 px-1",
        className,
      )}
      data-testid={`${testIdPrefix}-scale`}
      role="group"
      aria-label={ariaLabel}
    >
      <button
        type="button"
        onClick={onDecrease}
        aria-label="Decrease text size"
        data-testid={`${testIdPrefix}-decrease`}
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <span className="text-xs font-semibold leading-none" aria-hidden="true">
          A−
        </span>
      </button>
      <button
        type="button"
        onClick={onReset}
        aria-label={`Reset text size (${pct}%)`}
        title="Reset text size"
        data-testid={`${testIdPrefix}-reset`}
        className="min-w-[2.25rem] rounded-md px-1 py-1 text-[11px] tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {pct}%
      </button>
      <button
        type="button"
        onClick={onIncrease}
        aria-label="Increase text size"
        data-testid={`${testIdPrefix}-increase`}
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <span className="text-sm font-semibold leading-none" aria-hidden="true">
          A+
        </span>
      </button>
    </div>
  );
}

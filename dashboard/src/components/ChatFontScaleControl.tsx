import { useCallback, useEffect, useState } from "react";

import {
  CHAT_FONT_SCALE_DEFAULT,
  chatFontScaleStyle,
  nextChatFontScale,
  readChatFontScale,
  writeChatFontScale,
  type ChatFontScale,
} from "@/lib/chatFontScale";
import { cn } from "@/lib/utils";

/**
 * A− / A+ / reset control for chat text size (spec 175 §F).
 *
 * Shared by both shells. Persists to localStorage and exposes the current
 * scale so a parent can set `--chat-font-scale` on the transcript wrapper.
 */
export function useChatFontScale() {
  const [scale, setScaleState] = useState<ChatFontScale>(() => readChatFontScale());

  useEffect(() => {
    writeChatFontScale(scale);
  }, [scale]);

  // Cross-tab sync.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "sarathy_chat_font_scale") return;
      setScaleState(readChatFontScale());
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setScale = useCallback((next: ChatFontScale) => {
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

export function ChatFontScaleControl({
  scale,
  onIncrease,
  onDecrease,
  onReset,
  compact = false,
  className,
}: {
  scale: ChatFontScale;
  onIncrease: () => void;
  onDecrease: () => void;
  onReset: () => void;
  compact?: boolean;
  className?: string;
}) {
  const pct = Math.round(scale * 100);
  return (
    <div
      className={cn(
        "inline-flex items-center gap-0.5 rounded-lg border border-border/60 bg-background/60",
        compact ? "h-9 px-0.5" : "h-9 px-1",
        className,
      )}
      data-testid="chat-font-scale"
      role="group"
      aria-label="Chat text size"
    >
      <button
        type="button"
        onClick={onDecrease}
        aria-label="Decrease text size"
        data-testid="chat-font-decrease"
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
        data-testid="chat-font-reset"
        className="min-w-[2.25rem] rounded-md px-1 py-1 text-[11px] tabular-nums text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        {pct}%
      </button>
      <button
        type="button"
        onClick={onIncrease}
        aria-label="Increase text size"
        data-testid="chat-font-increase"
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
      >
        <span className="text-sm font-semibold leading-none" aria-hidden="true">
          A+
        </span>
      </button>
    </div>
  );
}

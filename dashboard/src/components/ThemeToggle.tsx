import { Check, Feather, Leaf, Monitor, Moon, Sun, Sunset } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { useTheme } from "@/lib/theme";
import { THEMES, type Theme } from "@/lib/themes";
import { cn } from "@/lib/utils";

const ICONS: Record<Theme, typeof Sun> = {
  light: Sun,
  dark: Moon,
  system: Monitor,
  matcha: Leaf,
  ink: Feather,
  sand: Sunset,
};

const MENU_WIDTH = 224; // w-56
const MENU_GAP = 8;

/**
 * Theme picker wired to the `theme.tsx` context.
 *
 * This used to be a cycling button (light → dark → system). With named
 * palettes (matcha / ink / sand) cycling six stops is a guessing game, so it
 * now opens a small menu listing every theme with a swatch and a check.
 * `compact` renders just the icon (mobile header).
 *
 * The menu is PORTALLED to <body> and positioned `fixed` from the trigger's
 * rect. Both headers use `backdrop-blur`, which makes them a stacking context:
 * a child with `z-50` is still painted UNDER the later sibling (the main
 * content), so an absolutely-positioned menu inside the header was unclickable
 * — the greeting panel swallowed the pointer events.
 *
 * The trigger keeps `data-testid="theme-toggle"` / `data-theme` so the shell
 * tests and any external probe can still read the active preference.
 */
export function ThemeToggle({
  className,
  compact = false,
}: {
  className?: string;
  compact?: boolean;
}) {
  const { theme, setTheme } = useTheme();
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const Current = ICONS[theme] ?? Moon;
  const currentLabel = THEMES.find((t) => t.id === theme)?.label ?? "Dark";

  const openMenu = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const left = Math.max(
      MENU_GAP,
      Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - MENU_GAP),
    );
    setPos({ top: rect.bottom + MENU_GAP, left });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // A fixed menu would detach from its trigger while the page scrolls or
    // resizes; closing is cheaper and less surprising than chasing it.
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("resize", close);
      window.removeEventListener("scroll", close, true);
    };
  }, [open]);

  const menu =
    open && pos
      ? createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label="Theme"
            data-testid="theme-menu"
            style={{ position: "fixed", top: pos.top, left: pos.left, width: MENU_WIDTH }}
            className="z-[100] overflow-hidden rounded-xl border bg-popover p-1 text-popover-foreground shadow-xl"
          >
            <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
              Appearance
            </div>
            {THEMES.map((option) => {
              const Icon = ICONS[option.id];
              const active = option.id === theme;
              return (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={active}
                  onClick={() => {
                    setTheme(option.id);
                    setOpen(false);
                  }}
                  data-testid={`theme-option-${option.id}`}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent hover:text-accent-foreground",
                    active && "bg-accent/60 text-accent-foreground",
                  )}
                >
                  <span
                    className="size-3.5 shrink-0 rounded-full ring-1 ring-inset ring-black/15 dark:ring-white/25"
                    style={{ backgroundColor: option.swatch }}
                    aria-hidden="true"
                  />
                  <Icon className="size-3.5 shrink-0 opacity-70" aria-hidden="true" />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium leading-tight">{option.label}</span>
                    <span className="block truncate text-[11px] leading-tight text-muted-foreground">
                      {option.hint}
                    </span>
                  </span>
                  {active && <Check className="size-3.5 shrink-0 text-primary" aria-hidden="true" />}
                </button>
              );
            })}
          </div>,
          document.body,
        )
      : null;

  return (
    <div className={cn("relative", className)}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? setOpen(false) : openMenu())}
        className={cn(
          "inline-flex items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
          compact ? "size-9" : "h-9 gap-2 px-2.5",
        )}
        title={`Theme: ${currentLabel}`}
        aria-label={`Theme: ${currentLabel}`}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid="theme-toggle"
        data-theme={theme}
      >
        <Current className="size-4" />
        {!compact && <span className="text-xs font-medium">{currentLabel}</span>}
      </button>
      {menu}
    </div>
  );
}

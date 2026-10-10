import { Monitor, Moon, Sun } from "lucide-react";

import { useTheme } from "@/lib/theme";
import { cn } from "@/lib/utils";

const ORDER = ["light", "dark", "system"] as const;
const ICONS = { light: Sun, dark: Moon, system: Monitor } as const;
const LABELS = { light: "Light", dark: "Dark", system: "System" } as const;

/**
 * Theme toggle wired to the existing `theme.tsx` context.
 *
 * Cycles light → dark → system rather than using a binary switch, so the
 * `system` option (which the context already supports and persists) is
 * reachable. Persistence is the context's job; this only calls setTheme.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { theme, setTheme } = useTheme();
  const next = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length];
  const Icon = ICONS[theme];

  return (
    <button
      type="button"
      onClick={() => setTheme(next)}
      className={cn(
        "inline-flex size-9 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
        className,
      )}
      title={`Theme: ${LABELS[theme]} — click for ${LABELS[next]}`}
      aria-label={`Theme: ${LABELS[theme]}. Switch to ${LABELS[next]}`}
      data-testid="theme-toggle"
      data-theme={theme}
    >
      <Icon className="size-4" />
    </button>
  );
}
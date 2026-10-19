import { createContext, useContext, useEffect, useState, type ReactNode } from "react";

import { DEFAULT_THEME, THEMES, isTheme, themeMode, type Theme } from "@/lib/themes";

/**
 * Theme PREFERENCE provider. The registry itself lives in `lib/themes.ts`
 * (data only) so tests that mock this module still see the theme list.
 *
 * A named palette resolves to a light/dark MODE — so `dark:` utilities and
 * `color-scheme` keep working — and adds its `theme-<id>` class to <html>,
 * which overrides the colour variables in index.css.
 */
export type { Theme, ThemeOption } from "@/lib/themes";
export { THEMES, isTheme } from "@/lib/themes";

const THEME_KEY = "sarathy_theme";

interface ThemeContextValue {
  theme: Theme;
  resolved: "dark" | "light";
  setTheme: (t: Theme) => void;
}

const ThemeContext = createContext<ThemeContextValue>({
  theme: DEFAULT_THEME,
  resolved: "dark",
  setTheme: () => {},
});

function resolveTheme(theme: Theme): "dark" | "light" {
  const mode = themeMode(theme);
  if (mode === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return mode;
}

/** Apply a theme to <html>: dark class, palette class, color-scheme, meta. */
function applyTheme(theme: Theme, resolved: "dark" | "light") {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  for (const option of THEMES) {
    if (option.className) root.classList.remove(option.className);
  }
  const option = THEMES.find((t) => t.id === theme);
  if (option?.className) root.classList.add(option.className);
  root.style.colorScheme = resolved;
  root.dataset.theme = theme;

  // Mobile status bar / PWA chrome follows the active palette.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) {
    const content =
      option?.mode === "system"
        ? resolved === "dark"
          ? "#09090b"
          : "#fafafa"
        : option?.swatch;
    if (content) meta.setAttribute("content", content);
  }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_KEY);
    return isTheme(saved) ? saved : DEFAULT_THEME;
  });
  const [resolved, setResolved] = useState<"dark" | "light">(() => resolveTheme(theme));

  // Resolve the preference to a concrete mode (and track the OS for "system").
  useEffect(() => {
    if (themeMode(theme) !== "system") {
      setResolved(resolveTheme(theme));
      return;
    }
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => setResolved(mq.matches ? "dark" : "light");
    handler();
    mq.addEventListener("change", handler);
    return () => mq.removeEventListener("change", handler);
  }, [theme]);

  useEffect(() => {
    applyTheme(theme, resolved);
    localStorage.setItem(THEME_KEY, theme);
  }, [theme, resolved]);

  return (
    <ThemeContext.Provider value={{ theme, resolved, setTheme: setThemeState }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

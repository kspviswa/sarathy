/**
 * Theme registry — DATA ONLY, no React.
 *
 * Kept in its own module because several tests mock `@/lib/theme` (the
 * provider) wholesale; if the picker imported the list from there it would
 * receive `undefined` under those mocks. `lib/theme.tsx` re-exports these for
 * callers that already import the provider.
 *
 * `light` / `dark` / `system` are the original modes. `matcha`, `ink` and
 * `sand` are named PALETTES: each still resolves to a light or dark mode (so
 * `dark:` utilities and `color-scheme` behave), but additionally puts a
 * `theme-<id>` class on <html> which overrides the colour variables in
 * index.css. Keep the palette CSS AFTER the `.dark` block there — equal
 * specificity means source order decides.
 *
 * The pre-paint bootstrap script in index.html / mobile.html mirrors this
 * list, so a reload paints the saved palette before React mounts.
 */
export type Theme = "light" | "dark" | "system" | "matcha" | "ink" | "sand";

export interface ThemeOption {
  id: Theme;
  label: string;
  hint: string;
  /** Resolved colour mode; "system" follows prefers-color-scheme. */
  mode: "light" | "dark" | "system";
  /** Representative colour: picker swatch + <meta name="theme-color">. */
  swatch: string;
  /** Class added to <html> for a named palette. */
  className?: string;
}

export const THEMES: ThemeOption[] = [
  {
    id: "light",
    label: "Light",
    hint: "Clean paper white",
    mode: "light",
    swatch: "#fafafa",
  },
  {
    id: "dark",
    label: "Dark",
    hint: "Sarathy violet, low light",
    mode: "dark",
    swatch: "#09090b",
  },
  {
    id: "system",
    label: "System",
    hint: "Follow the device",
    mode: "system",
    swatch: "#8b8b93",
  },
  {
    id: "matcha",
    label: "Matcha",
    hint: "Warm green tea",
    mode: "light",
    swatch: "#5f8f52",
    className: "theme-matcha",
  },
  {
    id: "ink",
    label: "Ink",
    hint: "Deep navy, steel accent",
    mode: "dark",
    swatch: "#1a2333",
    className: "theme-ink",
  },
  {
    id: "sand",
    label: "Sand",
    hint: "Ivory and clay",
    mode: "light",
    swatch: "#b9744c",
    className: "theme-sand",
  },
];

export const DEFAULT_THEME: Theme = "dark";

export function isTheme(value: string | null): value is Theme {
  return !!value && THEMES.some((t) => t.id === value);
}

export function themeMode(theme: Theme): "light" | "dark" | "system" {
  return THEMES.find((t) => t.id === theme)?.mode ?? "dark";
}

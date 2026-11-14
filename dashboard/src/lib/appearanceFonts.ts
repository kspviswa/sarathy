/**
 * App + composed-text font faces (spec 176 §C).
 *
 * Lists come from the OS via `window.queryLocalFonts()` when available and
 * permitted; otherwise a documented web-safe fallback — never presented as
 * the system list.
 */

export const APP_FONT_KEY = "sarathy_app_font";
export const COMPOSED_FONT_KEY = "sarathy_composed_font";

/** Empty string = product default (restore current appearance). */
export const FONT_FACE_DEFAULT = "";

/**
 * Documented web-safe fallback. Shown only when Local Font Access is
 * unavailable or permission is denied — never labelled as "system fonts".
 */
export const WEB_SAFE_FALLBACK_FONTS = [
  "Arial",
  "Helvetica",
  "Times New Roman",
  "Times",
  "Georgia",
  "Courier New",
  "Courier",
  "Verdana",
  "Trebuchet MS",
  "Comic Sans MS",
  "Impact",
  "Palatino Linotype",
  "Lucida Sans Unicode",
  "Tahoma",
  "Geneva",
  "system-ui",
  "ui-sans-serif",
  "ui-serif",
  "ui-monospace",
  "serif",
  "sans-serif",
  "monospace",
] as const;

export type FontListSource = "system" | "fallback";

export interface FontListResult {
  families: string[];
  source: FontListSource;
  /** Human-readable reason when `source === "fallback"`. */
  note?: string;
}

declare global {
  interface Window {
    queryLocalFonts?: () => Promise<Array<{ family: string }>>;
  }
}

export function isLocalFontsAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.queryLocalFonts === "function";
}

/** Quote a family name for CSS `font-family` when it contains spaces. */
export function quoteFontFamily(family: string): string {
  const trimmed = family.trim();
  if (!trimmed) return "";
  if (/^[a-zA-Z0-9-]+$/.test(trimmed)) return trimmed;
  return `"${trimmed.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function readAppFont(): string {
  try {
    return localStorage.getItem(APP_FONT_KEY) ?? FONT_FACE_DEFAULT;
  } catch {
    return FONT_FACE_DEFAULT;
  }
}

export function readComposedFont(): string {
  try {
    return localStorage.getItem(COMPOSED_FONT_KEY) ?? FONT_FACE_DEFAULT;
  } catch {
    return FONT_FACE_DEFAULT;
  }
}

export function writeAppFont(family: string): void {
  try {
    if (!family) localStorage.removeItem(APP_FONT_KEY);
    else localStorage.setItem(APP_FONT_KEY, family);
  } catch {
    /* ignore */
  }
}

export function writeComposedFont(family: string): void {
  try {
    if (!family) localStorage.removeItem(COMPOSED_FONT_KEY);
    else localStorage.setItem(COMPOSED_FONT_KEY, family);
  } catch {
    /* ignore */
  }
}

/**
 * Apply CSS custom properties on `<html>`. Empty family clears the override
 * so the stylesheet default is restored exactly.
 */
export function applyAppearanceFonts(appFont: string, composedFont: string): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  if (appFont) {
    root.style.setProperty("--app-font-family", quoteFontFamily(appFont));
  } else {
    root.style.removeProperty("--app-font-family");
  }
  if (composedFont) {
    root.style.setProperty("--chat-font-family", quoteFontFamily(composedFont));
  } else {
    root.style.removeProperty("--chat-font-family");
  }
}

/** Load OS fonts via Local Font Access, or return the documented fallback. */
export async function loadFontFamilies(): Promise<FontListResult> {
  if (!isLocalFontsAvailable()) {
    return {
      families: [...WEB_SAFE_FALLBACK_FONTS],
      source: "fallback",
      note: "System font listing is unavailable in this browser. Showing a documented web-safe list instead — not your installed fonts.",
    };
  }
  try {
    const fonts = await window.queryLocalFonts!();
    const set = new Set<string>();
    for (const f of fonts) {
      const family = (f.family || "").trim();
      if (family) set.add(family);
    }
    const families = Array.from(set).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: "base" }),
    );
    if (families.length === 0) {
      return {
        families: [...WEB_SAFE_FALLBACK_FONTS],
        source: "fallback",
        note: "No fonts were returned by the system. Showing a documented web-safe list instead.",
      };
    }
    return { families, source: "system" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      families: [...WEB_SAFE_FALLBACK_FONTS],
      source: "fallback",
      note: `Could not read system fonts (${msg}). Showing a documented web-safe list instead — not your installed fonts.`,
    };
  }
}

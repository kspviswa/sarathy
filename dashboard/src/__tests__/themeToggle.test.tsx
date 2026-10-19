/**
 * Theme picker (spec: named palettes).
 *
 * `theme.tsx` holds the preference; `ThemeToggle` opens a menu listing every
 * theme. These tests pin both halves: choosing an option persists it and
 * applies the right classes to <html>, and the context resolves
 * light/dark/system correctly.
 *
 * The picker replaced a cycling button when matcha/ink/sand were added —
 * cycling six stops is a guessing game, so the old cycle assertions are gone
 * on purpose (behaviour changed, not regressed).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { ThemeToggle } from "@/components/ThemeToggle";
import { ThemeProvider, useTheme, THEMES } from "@/lib/theme";

const THEME_KEY = "sarathy_theme";

/** Render the picker inside the real provider, exposing the context too. */
function Harness({ compact = false }: { compact?: boolean }) {
  return (
    <ThemeProvider>
      <ThemeToggle compact={compact} />
      <ThemeReadout />
    </ThemeProvider>
  );
}

function ThemeReadout() {
  const { theme } = useTheme();
  return <span data-testid="current-theme">{theme}</span>;
}

function stubMatchMedia(matches: boolean) {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((q: string) => ({
      matches,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

beforeEach(() => {
  localStorage.clear();
  const root = document.documentElement;
  root.className = "";
  root.style.colorScheme = "";
  delete root.dataset.theme;
  stubMatchMedia(false);
});

describe("ThemeToggle", () => {
  it("renders a labelled trigger showing the active theme", () => {
    render(<Harness />);
    const btn = screen.getByTestId("theme-toggle");
    expect(btn).toHaveAttribute("aria-label", expect.stringContaining("Theme"));
    expect(btn).toHaveAttribute("data-theme", "dark");
    expect(btn).toHaveTextContent("Dark");
  });

  it("opens a menu listing every theme, including the new palettes", () => {
    render(<Harness />);
    expect(screen.queryByTestId("theme-menu")).not.toBeInTheDocument();
    act(() => {
      fireEvent.click(screen.getByTestId("theme-toggle"));
    });
    const menu = screen.getByTestId("theme-menu");
    expect(menu).toBeInTheDocument();
    for (const option of THEMES) {
      expect(screen.getByTestId(`theme-option-${option.id}`)).toBeInTheDocument();
    }
    expect(screen.getByText("Matcha")).toBeInTheDocument();
    expect(screen.getByText("Ink")).toBeInTheDocument();
    expect(screen.getByText("Sand")).toBeInTheDocument();
  });

  it("selects a palette, persists it, and marks it checked", () => {
    render(<Harness />);
    act(() => {
      fireEvent.click(screen.getByTestId("theme-toggle"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("theme-option-matcha"));
    });

    expect(localStorage.getItem(THEME_KEY)).toBe("matcha");
    expect(screen.getByTestId("current-theme")).toHaveTextContent("matcha");
    expect(screen.getByTestId("theme-toggle")).toHaveAttribute("data-theme", "matcha");
    // Menu closes on selection.
    expect(screen.queryByTestId("theme-menu")).not.toBeInTheDocument();

    const root = document.documentElement;
    expect(root.classList.contains("theme-matcha")).toBe(true);
    expect(root.classList.contains("dark")).toBe(false);
    expect(root.style.colorScheme).toBe("light");
    expect(root.dataset.theme).toBe("matcha");
  });

  it("applies a dark palette with the dark class and clears it when leaving", () => {
    localStorage.setItem(THEME_KEY, "ink");
    render(<Harness />);
    const root = document.documentElement;
    expect(root.classList.contains("theme-ink")).toBe(true);
    expect(root.classList.contains("dark")).toBe(true);
    expect(root.style.colorScheme).toBe("dark");

    act(() => {
      fireEvent.click(screen.getByTestId("theme-toggle"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("theme-option-sand"));
    });
    expect(root.classList.contains("theme-ink")).toBe(false);
    expect(root.classList.contains("theme-sand")).toBe(true);
    expect(root.classList.contains("dark")).toBe(false);
  });

  it("restores the persisted theme on mount", () => {
    localStorage.setItem(THEME_KEY, "sand");
    render(<Harness />);
    expect(screen.getByTestId("current-theme")).toHaveTextContent("sand");
    expect(screen.getByTestId("theme-toggle")).toHaveAttribute("data-theme", "sand");
    expect(document.documentElement.classList.contains("theme-sand")).toBe(true);
  });

  it("ignores a corrupt persisted value and falls back to dark", () => {
    localStorage.setItem(THEME_KEY, "chartreuse");
    render(<Harness />);
    expect(screen.getByTestId("theme-toggle")).toHaveAttribute("data-theme", "dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("applies the resolved theme to the document element", () => {
    localStorage.setItem(THEME_KEY, "light");
    render(<Harness />);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("resolves 'system' from prefers-color-scheme", () => {
    localStorage.setItem(THEME_KEY, "system");
    stubMatchMedia(true);
    render(<Harness />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    // The picker still reports the *preference*, not the resolved value.
    expect(screen.getByTestId("theme-toggle")).toHaveAttribute("data-theme", "system");
  });

  it("closes the menu on Escape", () => {
    render(<Harness />);
    act(() => {
      fireEvent.click(screen.getByTestId("theme-toggle"));
    });
    expect(screen.getByTestId("theme-menu")).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(document, { key: "Escape" });
    });
    expect(screen.queryByTestId("theme-menu")).not.toBeInTheDocument();
  });

  it("compact mode hides the label but keeps the trigger accessible", () => {
    render(<Harness compact />);
    const btn = screen.getByTestId("theme-toggle");
    expect(btn).toHaveAttribute("data-theme", "dark");
    expect(btn).not.toHaveTextContent("Dark");
    expect(btn).toHaveAttribute("aria-label", "Theme: Dark");
  });
});

/**
 * Theme toggle persistence (spec §H).
 *
 * The spec required a toggle button because `theme.tsx` had the context but no
 * UI. These tests pin both halves: the toggle cycles/persists, and the context
 * applies the theme to <html>.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";

import { ThemeToggle } from "@/components/ThemeToggle";
import { ThemeProvider, useTheme } from "@/lib/theme";

const THEME_KEY = "sarathy_theme";

/** Render the toggle inside the real provider, exposing the context too. */
function Harness() {
  return (
    <ThemeProvider>
      <ThemeToggle />
      <ThemeReadout />
    </ThemeProvider>
  );
}

function ThemeReadout() {
  const { theme } = useTheme();
  return <span data-testid="current-theme">{theme}</span>;
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  document.documentElement.style.colorScheme = "";
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((q: string) => ({
      matches: false,
      media: q,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
});

describe("ThemeToggle", () => {
  it("renders a labelled toggle button", () => {
    render(<Harness />);
    const btn = screen.getByTestId("theme-toggle");
    expect(btn).toBeInTheDocument();
    expect(btn).toHaveAttribute("aria-label", expect.stringContaining("Theme"));
  });

  it("cycles light → dark → system and persists each choice", () => {
    render(<Harness />);
    const btn = screen.getByTestId("theme-toggle");

    // Default is dark (the context's default when nothing is stored).
    expect(btn).toHaveAttribute("data-theme", "dark");

    // Declared cycle is light -> dark -> system -> light, so from the default
    // of "dark" the next stop is "system".
    act(() => {
      fireEvent.click(btn);
    });
    expect(btn).toHaveAttribute("data-theme", "system");
    expect(localStorage.getItem(THEME_KEY)).toBe("system");

    act(() => {
      fireEvent.click(btn);
    });
    expect(btn).toHaveAttribute("data-theme", "light");
    expect(localStorage.getItem(THEME_KEY)).toBe("light");

    act(() => {
      fireEvent.click(btn);
    });
    expect(btn).toHaveAttribute("data-theme", "dark");
    expect(localStorage.getItem(THEME_KEY)).toBe("dark");
  });

  it("cycles every preference and returns to the start", () => {
    localStorage.setItem(THEME_KEY, "light");
    render(<Harness />);
    const btn = screen.getByTestId("theme-toggle");

    const seen = ["light"];
    for (let i = 0; i < 3; i++) {
      act(() => {
        fireEvent.click(btn);
      });
      seen.push(btn.getAttribute("data-theme")!);
    }
    // light -> dark -> system -> light
    expect(seen).toEqual(["light", "dark", "system", "light"]);
  });

  it("restores the persisted theme on mount", () => {
    localStorage.setItem(THEME_KEY, "light");
    render(<Harness />);
    expect(screen.getByTestId("current-theme")).toHaveTextContent("light");
    expect(screen.getByTestId("theme-toggle")).toHaveAttribute("data-theme", "light");
  });

  it("ignores a corrupt persisted value and falls back to dark", () => {
    localStorage.setItem(THEME_KEY, "chartreuse");
    render(<Harness />);
    expect(screen.getByTestId("theme-toggle")).toHaveAttribute("data-theme", "dark");
  });

  it("applies the resolved theme to the document element", () => {
    localStorage.setItem(THEME_KEY, "light");
    render(<Harness />);
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("resolves 'system' from prefers-color-scheme", () => {
    localStorage.setItem(THEME_KEY, "system");
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockImplementation((q: string) => ({
        matches: true,
        media: q,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    );
    render(<Harness />);
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    // The toggle still reports the *preference*, not the resolved value.
    expect(screen.getByTestId("theme-toggle")).toHaveAttribute("data-theme", "system");
  });
});
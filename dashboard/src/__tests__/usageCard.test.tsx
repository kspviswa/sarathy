import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/api", () => ({
  api: {
    usageSummary: vi.fn(),
  },
  getToken: vi.fn(() => "test-token"),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  AuthError: class AuthError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

vi.mock("@/lib/theme", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/lib/utils", () => ({
  cn: (...args: any[]) => args.filter(Boolean).join(" "),
}));

vi.mock("@/components/logo", () => ({
  Logo: ({ size }: { size?: number }) => <div data-testid="logo" data-size={size} />,
}));

vi.mock("@/components/ui/card", () => {
  const Card = ({ children, className, ...props }: any) => <div className={className} {...props}>{children}</div>;
  const CardHeader = ({ children, className, ...props }: any) => <div className={className} {...props}>{children}</div>;
  const CardTitle = ({ children, className, ...props }: any) => <div className={className} {...props}>{children}</div>;
  const CardDescription = ({ children, className, ...props }: any) => <div className={className} {...props}>{children}</div>;
  const CardContent = ({ children, className, ...props }: any) => <div className={className} {...props}>{children}</div>;
  const CardFooter = ({ children, className, ...props }: any) => <div className={className} {...props}>{children}</div>;
  return { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter };
});

vi.mock("@/components/ui/badge", () => ({
  Badge: ({ children, className, variant, ...props }: any) => <span className={className} {...props}>{children}</span>,
}));

vi.mock("@/components/ui/select", async () => {
  const ReactMod = await import("react");
  const ChangeContext = ReactMod.createContext<((v: string) => void) | null>(null);
  const Select = ({ children, onValueChange, ...props }: any) => (
    <ChangeContext.Provider value={onValueChange}>
      <div {...props}>{children}</div>
    </ChangeContext.Provider>
  );
  const SelectItem = ({ children, value, ...props }: any) => {
    const onChange = ReactMod.useContext(ChangeContext);
    return (
      <div data-value={value} onClick={() => onChange?.(String(value))} {...props}>
        {children}
      </div>
    );
  };
  return {
    Select,
    SelectTrigger: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    SelectValue: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    SelectContent: ({ children, ...props }: any) => <div {...props}>{children}</div>,
    SelectItem,
  };
});

vi.mock("@/components/ui/separator", () => ({
  Separator: ({ className, ...props }: any) => <hr className={className} {...props} />,
}));

import { UsageCard } from "@/components/UsageCard";
import { api } from "@/lib/api";
import { formatTokens } from "@/lib/format";

const mockUsageSummary = {
  available: true,
  window_days: 7,
  all_time: false,
  earliest_ts: "2026-09-21T00:00:00Z",
  span_days: 60,
  totals: {
    requests: 10,
    prompt_tokens: 50000,
    cached_tokens: 15000,
    completion_tokens: 20000,
    total_tokens: 70000,
    cache_hit_pct: 30.0,
  },
  by_model: [
    {
      model: "openrouter/deepseek/deepseek-v4.1-flash",
      provider: "openrouter",
      requests: 6,
      prompt_tokens: 30000,
      cached_tokens: 10000,
      completion_tokens: 12000,
      cache_hit_pct: 33.3,
    },
    {
      model: "local/llama-3.1-8b",
      provider: "ollama",
      requests: 4,
      prompt_tokens: 20000,
      cached_tokens: 5000,
      completion_tokens: 8000,
      cache_hit_pct: 25.0,
    },
  ],
  timeseries: [
    { ts: "2026-09-15T00:00:00Z", prompt_tokens: 5000, cached_tokens: 1500, completion_tokens: 2000, cache_hit_pct: 30.0 },
    { ts: "2026-09-16T00:00:00Z", prompt_tokens: 8000, cached_tokens: 2400, completion_tokens: 3200, cache_hit_pct: 30.0 },
    { ts: "2026-09-17T00:00:00Z", prompt_tokens: 12000, cached_tokens: 3600, completion_tokens: 4800, cache_hit_pct: 30.0 },
    { ts: "2026-09-18T00:00:00Z", prompt_tokens: 10000, cached_tokens: 3000, completion_tokens: 4000, cache_hit_pct: 30.0 },
    { ts: "2026-09-19T00:00:00Z", prompt_tokens: 15000, cached_tokens: 4500, completion_tokens: 6000, cache_hit_pct: 30.0 },
  ],
};

const mockEmptySummary = {
  available: false,
  window_days: 7,
  all_time: false,
  earliest_ts: null,
  span_days: 0,
  totals: {
    requests: 0,
    prompt_tokens: 0,
    cached_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
    cache_hit_pct: 0.0,
  },
  by_model: [],
  timeseries: [],
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  (api.usageSummary as any).mockResolvedValue(mockUsageSummary);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("UsageCard — renders headline stats from mocked api.usageSummary", () => {
  it("renders the card with data-testid", async () => {
    render(<UsageCard />);

    // Wait for loading to complete
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const card = screen.getByTestId("usage-card");
    expect(card).toBeInTheDocument();
  });

  it("renders headline stats: Total tokens, Cached tokens, Cache hit %", async () => {
    render(<UsageCard />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Check for total tokens (formatted as 70.0K by formatNumber)
    expect(screen.getByText("70.0K")).toBeInTheDocument();
    expect(screen.getByText("Total Tokens")).toBeInTheDocument();

    // Check for cached tokens (formatted as 15.0K)
    expect(screen.getByText("15.0K")).toBeInTheDocument();
    expect(screen.getByText("Cached Tokens")).toBeInTheDocument();

    // Check for cache hit %
    expect(screen.getByText("30.0%")).toBeInTheDocument();
    expect(screen.getByText("Cache Hit %")).toBeInTheDocument();
  });

  it("renders per-model rows with truncated model IDs", async () => {
    render(<UsageCard />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Model names should be truncated
    expect(screen.getByText("openrouter/deepseek/deepseek-v4.1-flash")).toBeInTheDocument();
    // Actually, the truncate function keeps up to 40 chars
    // "openrouter/deepseek/deepseek-v4.1-flash" is 40 chars exactly
    // So it should show fully

    // Check provider names
    expect(screen.getByText("openrouter")).toBeInTheDocument();
    expect(screen.getByText("ollama")).toBeInTheDocument();

    // Check requests count
    expect(screen.getByText("6 req")).toBeInTheDocument();
    expect(screen.getByText("4 req")).toBeInTheDocument();

    // Check cache hit % per model
    expect(screen.getByText("33.3%")).toBeInTheDocument();
    expect(screen.getByText("25.0%")).toBeInTheDocument();
  });

  it("renders time-series SVG chart", async () => {
    render(<UsageCard />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Check that SVG chart is rendered (two SVGs for prompt and cached)
    const svgs = document.querySelectorAll("svg");
    expect(svgs.length).toBeGreaterThanOrEqual(2);
    svgs.forEach((svg) => {
      expect(svg).toHaveAttribute("viewBox");
    });

    // Check legend
    expect(screen.getByText("Cached")).toBeInTheDocument();
    expect(screen.getByText("Prompt")).toBeInTheDocument();
  });
});

describe("UsageCard — billions-scale totals", () => {
  it("abbreviates totals in the B range and keeps M for the next tier", async () => {
    (api.usageSummary as any).mockResolvedValue({
      ...mockUsageSummary,
      totals: {
        ...mockUsageSummary.totals,
        total_tokens: 1_220_000_000,
        cached_tokens: 900_000_000,
      },
    });
    render(<UsageCard />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByText("1.2B")).toBeInTheDocument();
    expect(screen.getByText("900.0M")).toBeInTheDocument();
  });
});

describe("formatTokens — shared abbreviation", () => {
  it("scales B → M → K → raw", () => {
    expect(formatTokens(1_220_000_000, "K")).toBe("1.2B");
    expect(formatTokens(1_220_000_000)).toBe("1.2B");
    expect(formatTokens(122_000_000)).toBe("122.0M");
    expect(formatTokens(122_000, "K")).toBe("122.0K");
    expect(formatTokens(122_000)).toBe("122.0k");
    expect(formatTokens(999)).toBe("999");
  });
});

describe("UsageCard — renders 'no data' state when available: false", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (api.usageSummary as any).mockResolvedValue(mockEmptySummary);
  });

  it("shows 'No usage data yet.' when available is false", async () => {
    render(<UsageCard />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByText("No usage data yet.")).toBeInTheDocument();
    // Should not show headline stats
    expect(screen.queryByText("Total Tokens")).not.toBeInTheDocument();
    expect(screen.queryByText("Cached Tokens")).not.toBeInTheDocument();
    expect(screen.queryByText("Cache Hit %")).not.toBeInTheDocument();
  });
});

describe("UsageCard — window selector", () => {
  it("has a select for 7d/30d", async () => {
    render(<UsageCard />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    // Trigger label + the option itself both show the selected window.
    expect(screen.getAllByText("Last 7 days").length).toBeGreaterThan(0);
    expect(screen.getByText("Last 30 days")).toBeInTheDocument();
  });
});

describe("UsageCard — windows follow the stored data span", () => {
  async function renderWithSpan(spanDays: number) {
    (api.usageSummary as any).mockResolvedValue({
      ...mockUsageSummary,
      span_days: spanDays,
    });
    render(<UsageCard />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });
  }

  it("offers only 7d / 30d / All time for a 60-day dataset", async () => {
    await renderWithSpan(60);

    expect(screen.getAllByText("Last 7 days").length).toBeGreaterThan(0);
    expect(screen.getByText("Last 30 days")).toBeInTheDocument();
    expect(screen.getByText("All time")).toBeInTheDocument();
    expect(screen.queryByText("Last 3 months")).not.toBeInTheDocument();
    expect(screen.queryByText("Last year")).not.toBeInTheDocument();
    expect(screen.getByText("Window: Last 7 days · all models")).toBeInTheDocument();
  });

  it("offers every window when the data spans 2000 days", async () => {
    await renderWithSpan(2000);

    for (const label of [
      "Last 7 days",
      "Last 30 days",
      "Last 3 months",
      "Last 6 months",
      "Last year",
      "Last 3 years",
      "Last 5 years",
      "All time",
    ]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
  });

  it("refetches with days=90 when Last 3 months is selected", async () => {
    await renderWithSpan(2000);

    await act(async () => {
      fireEvent.click(screen.getByText("Last 3 months"));
      await vi.runAllTimersAsync();
    });

    expect(api.usageSummary).toHaveBeenLastCalledWith(90, null);
    expect(screen.getByText("Window: Last 3 months · all models")).toBeInTheDocument();
  });

  it("refetches with days=0 when All time is selected", async () => {
    await renderWithSpan(2000);

    await act(async () => {
      fireEvent.click(screen.getByText("All time"));
      await vi.runAllTimersAsync();
    });

    expect(api.usageSummary).toHaveBeenLastCalledWith(0, null);
    expect(screen.getByText("Window: All time (2000 days) · all models")).toBeInTheDocument();
  });

  it("treats missing span metadata as no long windows (older gateways)", async () => {
    (api.usageSummary as any).mockResolvedValue({
      available: true,
      window_days: 7,
      totals: mockUsageSummary.totals,
      by_model: mockUsageSummary.by_model,
      timeseries: mockUsageSummary.timeseries,
    });
    render(<UsageCard />);
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.queryByText("Last 3 months")).not.toBeInTheDocument();
    expect(screen.getByText("All time")).toBeInTheDocument();
  });
});

describe("UsageCard — per-model filter", () => {
  it("offers an 'All models' option plus each model", async () => {
    render(<UsageCard />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(screen.getByText("All models")).toBeInTheDocument();
    // Both model ids appear (once in the filter, once in the per-model row).
    expect(screen.getAllByText("openrouter/deepseek/deepseek-v4.1-flash").length).toBeGreaterThan(0);
    expect(screen.getAllByText("local/llama-3.1-8b").length).toBeGreaterThan(0);
  });

  it("refetches filtered data when a per-model row is clicked", async () => {
    render(<UsageCard />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(api.usageSummary).toHaveBeenLastCalledWith(7, null);

    // The model id appears in the filter dropdown and in the per-model row;
    // pick the one wrapped in the clickable row button.
    const row = screen
      .getAllByText("local/llama-3.1-8b")
      .map((el) => el.closest("button"))
      .find(Boolean) as HTMLElement;
    expect(row).toBeTruthy();
    await act(async () => {
      fireEvent.click(row);
      await vi.runAllTimersAsync();
    });

    expect(api.usageSummary).toHaveBeenLastCalledWith(7, "local/llama-3.1-8b");
  });
});

describe("UsageCard — chart colors resolve against theme variables", () => {
  it("does not wrap theme vars in hsl() (theme uses oklch — hsl(var(--x)) is invalid and renders black)", async () => {
    render(<UsageCard />);

    await act(async () => {
      await vi.runAllTimersAsync();
    });

    const svgs = document.querySelectorAll("svg[aria-label='Token usage over time']");
    expect(svgs.length).toBeGreaterThan(0);

    const combined = Array.from(svgs).map((svg) => svg.outerHTML).join("");
    // The invalid hsl(var(--x)) pattern must never come back (theme vars are oklch).
    expect(combined).not.toMatch(/hsl\(var\(/);
    // Colors must reference the theme variables directly (they resolve to oklch).
    expect(combined).toContain("var(--primary)");
    expect(combined).toContain("var(--muted-foreground)");
  });
});
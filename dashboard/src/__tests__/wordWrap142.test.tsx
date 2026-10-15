/**
 * Spec 142 §A — long unbreakable tokens wrap instead of overflowing.
 *
 * Viswa: "could you also word wrap happens globally? I still find places like
 * jobs tab, dashboard tab showing long words (eg model names) overflow and
 * looking ugly."
 *
 * jsdom computes no layout, so overflow itself cannot be asserted here — that is
 * what `/tmp/probe_overflow142.py` is for (it measures every element on every
 * section of both SPAs in a real browser: 187 overflowing elements before this
 * change, 0 after). What these tests pin is the CAUSE: the base rule that makes
 * wrapping the default, and the handful of spots that opted OUT of it with
 * `truncate` / `whitespace-nowrap` / `shrink-0` where wrapping is the right
 * answer — each of which the probe measured as overflowing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

vi.mock("@/lib/api", () => ({
  api: {
    usageSummary: vi.fn(),
    jobs: vi.fn(),
    status: vi.fn(),
  },
  getToken: vi.fn(() => "test-token"),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  AuthError: class AuthError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}));

vi.mock("@/lib/theme", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/logo", () => ({
  Logo: ({ size }: { size?: number }) => <div data-testid="logo" data-size={size} />,
}));

import { UsageCard } from "@/components/UsageCard";
import { Combobox } from "@/components/ui/combobox";
import { api } from "@/lib/api";

/** A model id long enough to be the thing that overflows — Viswa's own example. */
const LONG_MODEL = "gemma4-12b-qat-uncensored-hauhaucs-balanced";

const summary = {
  available: true,
  window_days: 7,
  totals: {
    requests: 10,
    prompt_tokens: 50000,
    cached_tokens: 15000,
    completion_tokens: 20000,
    total_tokens: 469_800_000,
    cache_hit_pct: 30.0,
  },
  by_model: [
    {
      model: LONG_MODEL,
      provider: "openrouter",
      requests: 6,
      prompt_tokens: 30000,
      cached_tokens: 10000,
      completion_tokens: 12000,
      cache_hit_pct: 33.3,
    },
  ],
  timeseries: [
    { ts: "2026-09-15T00:00:00Z", prompt_tokens: 5000, cached_tokens: 1500, completion_tokens: 2000, cache_hit_pct: 30 },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  (api.usageSummary as any).mockResolvedValue(summary);
});

describe("the base rule makes wrapping the default (spec 142 §A)", () => {
  const css = readFileSync(resolve(__dirname, "../index.css"), "utf8");

  it("sets overflow-wrap on html, so it inherits everywhere", () => {
    // Set on `html` rather than `body` or `*`: `overflow-wrap` inherits, and one
    // declaration beats a rule per component.
    const htmlRule = css.slice(css.indexOf("@layer base"), css.indexOf("@layer utilities"));
    expect(htmlRule).toMatch(/html\s*\{[^}]*overflow-wrap:\s*anywhere/);
  });

  it("uses `anywhere`, not `break-word`", () => {
    // The distinction is the whole fix. Both break a word that cannot fit on its
    // own line, but only `anywhere` contributes to min-content sizing — so only
    // `anywhere` lets a flex/grid item SHRINK below its longest word instead of
    // pushing its container wider. `break-word` is exactly how the model-id badge
    // came to sit 86px outside its card.
    expect(css).toContain("overflow-wrap: anywhere");
    expect(css).not.toContain("overflow-wrap: break-word");
  });
});

describe("the per-model badge yields instead of spilling", () => {
  it("shows the model id whole, and never opts out of wrapping", async () => {
    render(<UsageCard />);
    await act(async () => {});

    const badge = screen.getByText(LONG_MODEL);
    expect(badge).toBeInTheDocument();

    const cls = badge.className;
    // The three properties that made this the one part of the row that could not
    // yield: nowrap forbade wrapping, shrink-0 forbade shrinking. Together they
    // forced the badge past the card edge on a narrow screen.
    expect(cls).not.toMatch(/whitespace-nowrap/);
    expect(cls).not.toMatch(/shrink-0/);
    // …and it is allowed to shrink, which is what `min-w-0` buys in a flex row.
    expect(cls).toMatch(/min-w-0/);
  });

  it("does not truncate the model id to 40 characters any more", async () => {
    // Truncating a model name hides the one thing the row exists to identify —
    // and wrapping it made the truncation pointless anyway.
    render(<UsageCard />);
    await act(async () => {});
    expect(screen.queryByText(/…/)).toBeNull();
  });
});

describe("the combobox trigger grows rather than clipping its value", () => {
  it("has no `truncate` and a minimum height instead of a fixed one", () => {
    render(
      <Combobox
        value={LONG_MODEL}
        onChange={() => {}}
        options={[{ value: LONG_MODEL, label: LONG_MODEL }]}
        placeholder="Pick"
      />,
    );
    const trigger = screen.getByRole("combobox");
    // `h-9` would clip the second line of a wrapped value; `truncate` would stop
    // it wrapping at all. Measured +99px of hidden value on the Config tab.
    expect(trigger.className).not.toMatch(/truncate/);
    expect(trigger.className).toMatch(/min-h-9/);
    // Exactly `h-9` as a class, not the `h-9` inside `min-h-9`.
    expect(trigger.className.split(/\s+/)).not.toContain("h-9");
    expect(screen.getByText(LONG_MODEL).className).not.toMatch(/truncate/);
  });
});

describe("the mobile job row gives the title the full width", () => {
  afterEach(() => vi.clearAllMocks());

  it("wraps the title instead of clipping it to one line", async () => {
    const { JobsView } = await import("@/mobile/JobsView");
    (api.jobs as any).mockResolvedValue({
      jobs: [
      {
        id: 138,
        title:
          "Charitham: Vedic/Sanskrit aesthetics for the Chronicle view — mood ribbon, filters and the book view",
        kind: "deploy",
        status: "completed",
        repo: "/home/kspviswa/portals/charitham",
        model: LONG_MODEL,
        created_at: "2026-10-10T10:00:00Z",
        updated_at: "2026-10-10T11:00:00Z",
        event_count: 3,
        last_event: {
          id: 1,
          ts: "2026-10-10T11:00:00Z",
          event_type: "verified",
          level: "info",
          message: "Verified by backend channel 2026-10-10T23:20Z. SHA 374d46b on origin/main",
        },
      },
      ],
    });

    render(<JobsView />);
    await act(async () => {});

    const title = screen.getByRole("heading", { level: 3 });
    // One line + ellipsis is what made a ~1000px title an unreadable stub: the
    // row used to give it ~146px, because a fixed 200px column on the right took
    // the rest. It now wraps to two lines, matching the desktop card.
    expect(title.className).not.toMatch(/truncate/);
    expect(title.className).toMatch(/line-clamp-2/);
    expect(title.textContent).toContain("Vedic/Sanskrit");
  });
});

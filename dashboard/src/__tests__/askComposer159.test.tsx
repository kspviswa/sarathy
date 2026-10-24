import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";

import { AskComposer } from "@/components/ask/AskComposer";
import { AskMediaButtons } from "@/components/ask/AskMediaButtons";
import { AskTurnCard } from "@/components/ask/AskTurnCard";
import { LightboxProvider } from "@/lib/lightbox";
import {
  ASK_MODES,
  ASK_SOURCE_KINDS,
  type AskMode,
  type AskSourceKind,
  type AskTurn,
  type AskUsage,
} from "@/lib/ask";

/**
 * Spec 159 §E — the desktop Ask composer.
 *
 * The five cases Viswa's complaints (and the spec) were written against:
 * the inline submit row, the red stop slot, the icon sources + mode popovers
 * and the segmented media bar.
 */

function renderComposer(overrides: {
  query?: string;
  mode?: AskMode;
  sources?: AskSourceKind[];
  streaming?: boolean;
  onSourcesChange?: (sources: AskSourceKind[]) => void;
} = {}) {
  const props = {
    query: overrides.query ?? "",
    onQueryChange: vi.fn(),
    mode: overrides.mode ?? ("speed" as AskMode),
    onModeChange: vi.fn(),
    sources: overrides.sources ?? (["web"] as AskSourceKind[]),
    onSourcesChange: overrides.onSourcesChange ?? vi.fn(),
    streaming: overrides.streaming ?? false,
    onSubmit: vi.fn(),
    onStop: vi.fn(),
    quoteChips: [{ id: "c1", text: "Paris is the capital." }],
    onRemoveQuote: vi.fn(),
  };
  render(<AskComposer {...props} />);
}

// ---------------------------------------------------------------------------
// A. One inline composer row on desktop
// ---------------------------------------------------------------------------

describe("AskComposer — spec 159 §A (one inline desktop row)", () => {
  it("ask-submit renders inside ask-input-row, on the same row as ask-query", () => {
    renderComposer();

    const row = screen.getByTestId("ask-input-row");
    expect(row).toBeInTheDocument();

    // The textarea and the submit both live in the one row.
    expect(within(row).getByTestId("ask-query")).toBeInTheDocument();
    const submit = within(row).getByTestId("ask-submit");
    expect(submit).toBeInTheDocument();
    expect(submit).toHaveAttribute("aria-label", "Ask");
    expect(submit).toHaveClass("rounded-full");
    expect(submit).toHaveClass("bg-primary");
    expect(submit).toHaveClass("text-primary-foreground");
  });
});

// ---------------------------------------------------------------------------
// A. The red stop takes the submit's slot while streaming
// ---------------------------------------------------------------------------

describe("AskComposer — spec 159 §A (the stop slot)", () => {
  it("while streaming the stop replaces the submit in the same row, in red", () => {
    renderComposer({ streaming: true, query: "hello" });

    const row = screen.getByTestId("ask-input-row");
    const stop = within(row).getByTestId("ask-stop");
    expect(stop).toBeInTheDocument();
    // The submit is gone — the stop owns the submit's slot.
    expect(within(row).queryByTestId("ask-submit")).not.toBeInTheDocument();

    expect(stop).toHaveAttribute("aria-label", "Stop");
    expect(stop).toHaveAttribute("title", "Stop generating");
    expect(stop).toHaveClass("rounded-full");
    expect(stop).toHaveClass("bg-destructive");
    expect(stop).toHaveClass("text-destructive-foreground");
  });
});

// ---------------------------------------------------------------------------
// B. Sources and mode become icon-bearing popovers
// ---------------------------------------------------------------------------

describe("AskComposer — spec 159 §B (icon sources + mode popovers)", () => {
  it("the sources trigger opens to rows carrying their icons and toggles via onSourcesChange", () => {
    const onSourcesChange = vi.fn();
    renderComposer({ sources: ["web"], onSourcesChange });

    const trigger = screen.getByTestId("ask-sources-trigger");
    expect(trigger).toBeInTheDocument();
    // The trigger is icon-bearing (globe + chevron).
    expect(trigger.querySelector("svg")).not.toBeNull();

    fireEvent.click(trigger);

    for (const option of ASK_SOURCE_KINDS) {
      const row = screen.getByTestId(`ask-source-${option.id}`);
      expect(row).toBeInTheDocument();
      // The row carries its icon.
      expect(row.querySelector("svg")).not.toBeNull();
      expect(row).toHaveAttribute("aria-pressed", String(option.id === "web"));
    }

    // Toggling a row calls onSourcesChange with the new set.
    fireEvent.click(screen.getByTestId("ask-source-academic"));
    expect(onSourcesChange).toHaveBeenCalled();
  });

  it("the mode trigger renders the active mode's icon and opens to three icon rows", () => {
    renderComposer({ mode: "quality" });

    const trigger = screen.getByTestId("ask-modes-trigger");
    expect(trigger).toBeInTheDocument();
    // The trigger carries the active mode's icon (Star for Deep) + its label.
    expect(trigger.querySelector("svg")).not.toBeNull();
    expect(trigger).toHaveTextContent("Deep");

    fireEvent.click(trigger);

    for (const option of ASK_MODES) {
      const row = screen.getByTestId(`ask-mode-${option.id}`);
      expect(row).toBeInTheDocument();
      // Every option row is icon-bearing.
      expect(row.querySelector("svg")).not.toBeNull();
      expect(row).toHaveAttribute("aria-pressed", String(option.id === "quality"));
    }
  });
});

// ---------------------------------------------------------------------------
// C. The media bar is a segmented action bar
// ---------------------------------------------------------------------------

describe("AskMediaButtons — spec 159 §C (segmented action bar)", () => {
  const turn: AskTurn = {
    id: "t1",
    query: "What is the capital of France?",
    mode: "speed",
    sources: ["web"],
    answer: "Paris is the capital of France.",
    sourcesList: [],
    steps: [],
    createdAt: 0,
  };

  it("renders an icon + label for both kinds and spins while searching", async () => {
    render(<AskMediaButtons turn={turn} turns={[turn]} threadId={null} onMediaLoaded={vi.fn()} />);

    const images = screen.getByTestId("ask-media-images-btn");
    const videos = screen.getByTestId("ask-media-videos-btn");

    // Icon + label for both kinds.
    expect(images).toBeInTheDocument();
    expect(videos).toBeInTheDocument();
    expect(images.querySelector("svg")).not.toBeNull();
    expect(videos.querySelector("svg")).not.toBeNull();
    expect(images).toHaveTextContent("Search images");
    expect(videos).toHaveTextContent("Search videos");

    // Loading state: spinner + "Searching images…".
    vi.stubGlobal("fetch", vi.fn(async (): Promise<Response> => new Promise<Response>(() => {})));
    fireEvent.click(images);

    expect(images).toBeInTheDocument();
    expect(images).toHaveTextContent("Searching images…");
    expect(images.querySelector("svg")).toHaveClass("animate-spin");
    expect(images).toBeDisabled();
  });
});

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// F. The usage footer is an icon + value strip, in the UsageFooter idiom
// ---------------------------------------------------------------------------

function makeTurn(overrides: Partial<AskTurn> = {}): AskTurn {
  return {
    id: "turn-1",
    query: "What is the capital of France?",
    mode: "speed",
    sources: ["web"],
    answer: "Paris is the capital of France.",
    sourcesList: [],
    steps: [],
    createdAt: 0,
    media: [],
    ...overrides,
  };
}

function renderTurn(turn: AskTurn) {
  return render(
    <LightboxProvider>
      <AskTurnCard
        turn={turn}
        streaming={false}
        phase="done"
        onReply={vi.fn()}
        onQuote={vi.fn()}
        onRewrite={vi.fn()}
        onSummarize={vi.fn()}
        turns={[turn]}
        threadId="thread-1"
        onMediaUpdate={vi.fn()}
        alwaysShowActions={true}
        isMobile={false}
      />
    </LightboxProvider>,
  );
}

/** The lucide name an icon's svg carries, e.g. `lucide-circle-dollar-sign`. */
function lucideClass(span: HTMLElement): string | null {
  const svg = span.querySelector("svg");
  if (!svg) return null;
  const match = /lucide-[a-z0-9-]+/.exec(svg.getAttribute("class") || "");
  return match ? match[0] : null;
}

describe("AskTurnCard — spec 159 §F (usage footer icons)", () => {
  const usage: AskUsage = {
    tokensIn: 940,
    tokensOut: 180,
    iterations: 2,
    latencyMs: 645,
    sources: 3,
    cost: 0.0042,
  };

  it("the cost fragment renders with its CircleDollarSign icon and the formatted value", () => {
    renderTurn(makeTurn({ usage }));

    const cost = screen.getByTestId("ask-usage-cost");
    expect(cost).toHaveTextContent("$0.0042");
    expect(lucideClass(cost)).toBe("lucide-circle-dollar-sign");
  });

  it("the other fragments each render their icon beside their value", () => {
    renderTurn(makeTurn({ usage }));

    const latency = screen.getByTestId("ask-usage-latency");
    expect(latency).toHaveTextContent("0.6 s");
    expect(lucideClass(latency)).toBe("lucide-timer");

    const iterations = screen.getByTestId("ask-usage-iterations");
    expect(iterations).toHaveTextContent("2 iterations");
    expect(lucideClass(iterations)).toBe("lucide-repeat2");

    const sources = screen.getByTestId("ask-usage-sources");
    expect(sources).toHaveTextContent("3 sources");
    expect(lucideClass(sources)).toBe("lucide-link2");

    const tokens = screen.getByTestId("ask-usage-tokens");
    expect(tokens).toHaveTextContent("940 in");
    expect(tokens).toHaveTextContent("180 out");
    expect(tokens).toHaveTextContent("1.1k total tokens");
    // in / out / total carry ArrowDownToLine, ArrowUpFromLine and Sigma.
    const svgClasses = Array.from(tokens.querySelectorAll("svg")).map(
      (svg) => /lucide-[a-z0-9-]+/.exec(svg.getAttribute("class") || "")?.[0],
    );
    expect(svgClasses).toEqual([
      "lucide-arrow-down-to-line",
      "lucide-arrow-up-from-line",
      "lucide-sigma",
    ]);
  });

  it("a turn without a reported cost renders no cost fragment", () => {
    renderTurn(makeTurn({ usage: { ...usage, cost: null } }));

    expect(screen.queryByTestId("ask-usage-cost")).not.toBeInTheDocument();
    // The rest of the strip is still there.
    expect(screen.getByTestId("ask-usage-latency")).toBeInTheDocument();
    expect(screen.getByTestId("ask-usage-tokens")).toBeInTheDocument();
  });
});

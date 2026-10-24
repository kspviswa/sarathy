import { describe, it, expect, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { AskComposer } from "@/components/ask/AskComposer";
import type { AskMode, AskSourceKind } from "@/lib/ask";

/**
 * Spec 163 — the mobile Ask composer.
 *
 * Viswa's report: "the composer on ask tab is still finicky. When I touch the
 * input box the screen immediately jumps and gets zoomed in … I still see the
 * stop button not in red color and somewhere down. Chat tab is better."
 *
 * Two defects, both in the mobile branch only:
 *  1. the textarea was 14px (`text-sm`), and iOS Safari auto-zooms the page
 *     whenever a focused field is below 16px;
 *  2. the mobile branch kept the PRE-spec-159 controls — a labelled "Ask"
 *     button, mode/source toggle groups, and an `outline` Stop that landed at
 *     the end of a wrapping row, i.e. not red and "somewhere down".
 *
 * The mobile shell now shares the desktop's controls and keeps the stop in the
 * submit's slot, at the right end of the controls row.
 */

function renderComposer(variant: "desktop" | "mobile", streaming = false) {
  render(
    <AskComposer
      query={streaming ? "hello" : ""}
      onQueryChange={vi.fn()}
      mode={"speed" as AskMode}
      onModeChange={vi.fn()}
      sources={["web"] as AskSourceKind[]}
      onSourcesChange={vi.fn()}
      streaming={streaming}
      onSubmit={vi.fn()}
      onStop={vi.fn()}
      quoteChips={[]}
      onRemoveQuote={vi.fn()}
      variant={variant}
    />,
  );
}

describe("AskComposer — spec 163 (mobile composer)", () => {
  it("the mobile textarea is 16px so iOS does not auto-zoom on focus", () => {
    renderComposer("mobile");
    const input = screen.getByTestId("ask-query");
    expect(input).toHaveClass("text-base");
    expect(input).not.toHaveClass("text-sm");
  });

  it("while streaming the stop sits in the controls row, red and in the submit slot", () => {
    renderComposer("mobile", true);

    const controls = screen.getByTestId("ask-controls-row");
    const stop = within(controls).getByTestId("ask-stop");

    expect(stop).toHaveAttribute("aria-label", "Stop");
    expect(stop).toHaveClass("bg-destructive");
    expect(stop).toHaveClass("text-destructive-foreground");
    expect(stop).toHaveClass("rounded-full");

    // The stop owns the slot — the submit is gone.
    expect(within(controls).queryByTestId("ask-submit")).not.toBeInTheDocument();

    // And it is the LAST control in the row, not wrapped onto a line of its own.
    const buttons = controls.querySelectorAll("button");
    expect(buttons[buttons.length - 1]).toBe(stop);
  });

  it("the mobile controls row carries the same sources/mode triggers as desktop", () => {
    renderComposer("mobile");
    const controls = screen.getByTestId("ask-controls-row");
    expect(within(controls).getByTestId("ask-sources-trigger")).toBeInTheDocument();
    expect(within(controls).getByTestId("ask-modes-trigger")).toBeInTheDocument();
    expect(within(controls).getByTestId("ask-submit")).toBeInTheDocument();
  });

  it("the desktop composer keeps its single inline row", () => {
    renderComposer("desktop", true);
    const row = screen.getByTestId("ask-input-row");
    expect(within(row).getByTestId("ask-query")).toBeInTheDocument();
    expect(within(row).getByTestId("ask-stop")).toHaveClass("bg-destructive");
    expect(screen.queryByTestId("ask-controls-row")).not.toBeInTheDocument();
  });
});

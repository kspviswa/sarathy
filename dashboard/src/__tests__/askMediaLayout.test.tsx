/**
 * Spec 153 — the Ask media layout: a sticky desktop rail, a mobile collapsible.
 *
 * The parent (AskTurnCard) decides which shell draws the media:
 * - desktop (`isMobile={false}`) → the sticky rail (`ask-media-rail`);
 * - mobile (`isMobile={true}`) → the collapsible (`ask-media-collapsible-trigger`
 *   + the strip inside, revealed on open).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { AskTurnCard } from "@/components/ask/AskTurnCard";
import { LightboxProvider } from "@/lib/lightbox";
import type { AskMedia, AskTurn } from "@/lib/ask";

function makeTurn(overrides: Partial<AskTurn> = {}): AskTurn {
  return {
    id: "turn-1",
    query: "What is the capital of France?",
    mode: "speed",
    sources: [],
    answer: "Paris is the capital of France.",
    sourcesList: [],
    steps: [],
    createdAt: 0,
    media: [],
    ...overrides,
  };
}

function imageMedia(count: number, startAt = 0): AskMedia[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "image" as const,
    url: `https://images.test/photo-${startAt + i}.jpg`,
    img_src: `https://images.test/photo-${startAt + i}.jpg`,
    title: `Photo ${startAt + i + 1}`,
  }));
}

function videoMedia(count: number, startAt = 0): AskMedia[] {
  return Array.from({ length: count }, (_, i) => ({
    kind: "video" as const,
    url: `https://video.test/watch/${startAt + i}`,
    thumb: `https://video.test/thumb-${startAt + i}.jpg`,
    title: `Video ${startAt + i + 1}`,
    iframe_src: `https://www.youtube.com/embed/v${startAt + i}`,
  }));
}

function renderTurn(turn: AskTurn, isMobile = false) {
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
        alwaysShowActions={false}
        isMobile={isMobile}
      />
    </LightboxProvider>,
  );
}

// ---------------------------------------------------------------------------
// Desktop — the sticky rail
// ---------------------------------------------------------------------------

describe("AskTurnCard — desktop media rail (spec 153 §A)", () => {
  it("a turn with media renders the rail and not the collapsible", () => {
    renderTurn(makeTurn({ media: imageMedia(2) }));

    expect(screen.getByTestId("ask-media-rail")).toBeInTheDocument();
    // The refresh buttons live at the top of the rail.
    expect(screen.getByTestId("ask-media-buttons")).toBeInTheDocument();
    // The one rule: the parent wraps the desktop aside in `hidden lg:block`
    // and never renders the mobile collapsible for this shell.
    expect(screen.queryByTestId("ask-media-collapsible-trigger")).not.toBeInTheDocument();
  });

  it("every rail thumb goes through the gateway proxy", () => {
    renderTurn(makeTurn({ media: imageMedia(2) }));

    const thumbs = screen.getAllByTestId("ask-media-thumb");
    expect(thumbs).toHaveLength(2);
    for (const thumb of thumbs) {
      const img = thumb.querySelector("img");
      const src = img?.getAttribute("src") ?? "";
      expect(src.startsWith("/api/media/proxy?url=")).toBe(true);
    }
  });

  it("the refresh buttons stay reachable on the mobile shell too", () => {
    renderTurn(makeTurn({ media: imageMedia(1) }), true);

    expect(screen.getByTestId("ask-media-buttons")).toBeInTheDocument();
    expect(screen.getByTestId("ask-media-collapsible-trigger")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Mobile — the collapsible
// ---------------------------------------------------------------------------

describe("AskTurnCard — mobile media collapsible (spec 153 §B)", () => {
  it("the trigger carries the counts and the media is absent until clicked", () => {
    renderTurn(makeTurn({ media: [...imageMedia(2), ...videoMedia(1)] }), true);

    const trigger = screen.getByTestId("ask-media-collapsible-trigger");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.getAttribute("aria-controls")).toBeTruthy();
    expect(trigger).toHaveTextContent("Media · 2 images · 1 video");

    // Collapsed by default — the media is not in the DOM.
    expect(screen.queryByTestId("ask-media-strip")).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("ask-media-strip")).toBeInTheDocument();
  });

  it("clicking the trigger reveals the thumbs inside the strip", () => {
    renderTurn(makeTurn({ media: imageMedia(2) }), true);

    const trigger = screen.getByTestId("ask-media-collapsible-trigger");
    fireEvent.click(trigger);

    const strip = screen.getByTestId("ask-media-strip");
    expect(strip).toBeInTheDocument();
    // The strip is the mobile layout: anchors, not rail thumbs.
    expect(strip.querySelectorAll("img")).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Neither — no media, no answer
// ---------------------------------------------------------------------------

describe("AskTurnCard — no media means no rail and no collapsible", () => {
  it("renders neither the rail nor the collapsible", () => {
    renderTurn(makeTurn({ answer: "", media: [] }));

    expect(screen.queryByTestId("ask-media-rail")).not.toBeInTheDocument();
    expect(screen.queryByTestId("ask-media-collapsible-trigger")).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The "View N more" tile
// ---------------------------------------------------------------------------

describe("AskMediaView — the rail's 'View N more' tile (spec 153 §A)", () => {
  it("opens the shared lightbox on the first of the hidden images", () => {
    renderTurn(makeTurn({ media: imageMedia(5) }));

    const thumbs = screen.getAllByTestId("ask-media-thumb");
    // Five images → first three are tiles, the rest live behind the "View N more" tile.
    expect(thumbs).toHaveLength(3);
    expect(screen.getByTestId("ask-media-more")).toHaveTextContent("View 2 more");

    fireEvent.click(screen.getByTestId("ask-media-more"));

    expect(screen.getByTestId("image-lightbox")).toBeInTheDocument();
    expect(screen.queryByTestId("ask-media-image-dialog")).not.toBeInTheDocument();
  });

  it("does not show the tile at four images or below", () => {
    renderTurn(makeTurn({ media: imageMedia(4) }));

    expect(screen.getAllByTestId("ask-media-thumb")).toHaveLength(4);
    expect(screen.queryByTestId("ask-media-more")).not.toBeInTheDocument();
  });
});

/**
 * Spec 154 — the five Ask regressions:
 * carousel, video links, image lightbox + Source, usage totals, sources collapse.
 */
import { describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { AskMediaView } from "@/components/ask/AskMediaView";
import * as AskMediaModule from "@/components/ask/AskMediaView";
import { AskTurnCard } from "@/components/ask/AskTurnCard";
import { LightboxProvider, useLightbox } from "@/lib/lightbox";
import { proxiedImage } from "@/lib/mediaProxy";
import {
  formatAskUsage,
  reduceAskFrame,
  initialAskState,
  type AskMedia,
  type AskSource,
  type AskTurn,
} from "@/lib/ask";

const videoHref = (
  AskMediaModule as { videoHref?: (item: AskMedia) => string | null }
).videoHref;

const IMAGE: AskMedia = {
  kind: "image",
  url: "https://images.test/page-with-the-photo",
  img_src: "https://cdn.test/actual.jpg",
  thumb: "https://cdn.test/thumb.jpg",
  title: "Actual image",
};

const VIDEO: AskMedia = {
  kind: "video",
  url: "https://video.test/watch/1",
  thumb: "https://video.test/thumb-1.jpg",
  title: "A video",
  iframe_src: "https://www.youtube.com/embed/abc123",
};

function mediaList(): AskMedia[] {
  return [
    IMAGE,
    { ...IMAGE, url: "https://images.test/2", img_src: "https://cdn.test/2.jpg" },
    { ...IMAGE, url: "https://images.test/3", img_src: "https://cdn.test/3.jpg" },
    VIDEO,
    { ...VIDEO, url: "https://video.test/watch/2" },
  ];
}

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
        alwaysShowActions={false}
        isMobile={false}
      />
    </LightboxProvider>,
  );
}

describe("Spec 154 A — the mobile strip is a horizontal carousel", () => {
  it("images and videos scroll in their own rows, not in a grid", () => {
    render(<AskMediaView media={mediaList()} variant="strip" />);

    const imageTrack = screen.getByTestId("ask-media-image-track");
    const videoTrack = screen.getByTestId("ask-media-video-track");

    for (const track of [imageTrack, videoTrack]) {
      expect(track.className).toContain("overflow-x-auto");
      expect(track.className).toContain("flex-row");
      expect(track.className).toContain("snap-x");
      expect(track.className).not.toContain("grid");
    }

    const imageTile = screen.getAllByTestId("ask-media-thumb")[0];
    expect(imageTile.className).toContain("shrink-0");
    expect(imageTile.className).toContain("snap-start");
    expect(imageTile.className).toContain("w-40");

    const videoTile = screen.getAllByTestId("ask-media-video-link")[0];
    expect(videoTile.className).toContain("shrink-0");
    expect(videoTile.className).toContain("snap-start");
    expect(videoTile.className).toContain("w-64");
  });

  it("the desktop rail stays a two-column grid", () => {
    render(<AskMediaView media={mediaList().slice(0, 3)} variant="rail" />);

    const rail = screen.getByTestId("ask-media-rail");
    expect(rail.querySelector(".grid-cols-2")).toBeInTheDocument();
    expect(screen.queryByTestId("ask-media-image-track")).not.toBeInTheDocument();
  });
});

describe("Spec 154 B — videos are direct links, never embeds", () => {
  it("a video tile is an anchor and no iframe exists anywhere", () => {
    const { container } = render(<AskMediaView media={mediaList()} variant="strip" />);

    const links = screen.getAllByTestId("ask-media-video-link");
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("target", "_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    }
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("a bare YouTube embed resolves to the watch page", () => {
    expect(typeof videoHref).toBe("function");
    if (!videoHref) return;
    const item: AskMedia = { kind: "video", url: "", iframe_src: "https://www.youtube.com/embed/abc123" };
    expect(videoHref(item)).toBe("https://www.youtube.com/watch?v=abc123");
    expect(
      videoHref({
        kind: "video",
        url: "",
        iframe_src: "https://www.youtube-nocookie.com/embed/xyz",
      }),
    ).toBe("https://www.youtube.com/watch?v=xyz");
  });

  it("a video with no URL at all is not clickable", () => {
    render(<AskMediaView media={[{ kind: "video", url: "", title: "Nowhere" }]} variant="strip" />);

    expect(screen.queryByTestId("ask-media-video-link")).toBeNull();
    expect(screen.getByTestId("ask-media-video-static")).toBeInTheDocument();
  });
});

function LightboxProbe() {
  const lightbox = useLightbox();
  return (
    <button
      type="button"
      data-testid="lightbox-probe"
      onClick={() =>
        lightbox?.open({
          src: "https://cdn.test/actual.jpg",
          href: "https://page.test/containing-page",
          title: "Actual",
        })
      }
    >
      open
    </button>
  );
}

describe("Spec 154 C — images open the real image in the shared lightbox", () => {
  it("the lightbox renders a Source link when the item has a page", () => {
    render(
      <LightboxProvider>
        <LightboxProbe />
      </LightboxProvider>,
    );

    fireEvent.click(screen.getByTestId("lightbox-probe"));

    expect(screen.getByTestId("image-lightbox")).toBeInTheDocument();
    expect(screen.getByTestId("lightbox-source")).toHaveAttribute(
      "href",
      "https://page.test/containing-page",
    );
    expect(screen.getByTestId("lightbox-source")).toHaveAttribute("target", "_blank");
  });

  it("the thumbnail opens the lightbox with the actual image and a Source link", () => {
    render(
      <LightboxProvider>
        <AskMediaView media={[IMAGE]} variant="strip" />
      </LightboxProvider>,
    );

    const thumb = screen.getByTestId("ask-media-thumb");
    expect(thumb.tagName).toBe("BUTTON");
    expect(document.querySelector(`a[href="${IMAGE.url}"]`)).toBeNull();

    fireEvent.click(thumb);

    const lightbox = screen.getByTestId("image-lightbox");
    const image = lightbox.querySelector("img");
    expect(image?.getAttribute("src")).toBe(proxiedImage(IMAGE.img_src as string));

    const source = screen.getByTestId("lightbox-source");
    expect(source).toHaveAttribute("href", IMAGE.url);
    expect(source).toHaveAttribute("target", "_blank");
  });

  it("the desktop rail image also opens the lightbox, not a dialog", () => {
    render(
      <LightboxProvider>
        <AskMediaView media={[IMAGE]} variant="rail" />
      </LightboxProvider>,
    );

    fireEvent.click(screen.getByTestId("ask-media-thumb"));

    expect(screen.getByTestId("image-lightbox")).toBeInTheDocument();
    expect(screen.queryByTestId("ask-media-image-dialog")).not.toBeInTheDocument();
    expect(screen.getByTestId("lightbox-source")).toHaveAttribute("href", IMAGE.url);
  });

  it("an image whose URL is its own page still offers a Source link", () => {
    render(
      <LightboxProvider>
        <AskMediaView
          media={[{ kind: "image", url: "https://cdn.test/only.jpg", img_src: "https://cdn.test/only.jpg" }]}
          variant="strip"
        />
      </LightboxProvider>,
    );

    fireEvent.click(screen.getByTestId("ask-media-thumb"));

    expect(screen.getByTestId("image-lightbox")).toBeInTheDocument();
    expect(screen.getByTestId("lightbox-source")).toHaveAttribute(
      "href",
      "https://cdn.test/only.jpg",
    );
  });
});

describe("Spec 154 D — per-turn totals", () => {
  it("prints in, out and total tokens, with no invented cost", () => {
    const text = formatAskUsage({
      tokensIn: 14700,
      tokensOut: 1900,
      iterations: 2,
      latencyMs: 26300,
      sources: 20,
    });

    expect(text).toContain("14.7k in");
    expect(text).toContain("1.9k out");
    expect(text).toContain("16.6k total tokens");
    expect(text).not.toContain("$");
    expect(text).not.toContain("undefined");
  });

  it("prints a cost only when one is provided", () => {
    const text = formatAskUsage({
      tokensIn: 100,
      tokensOut: 200,
      iterations: 1,
      latencyMs: 1000,
      sources: 2,
      cost: 0.0023,
    });

    expect(text).toContain("300 total tokens");
    expect(text).toContain("$0.0023");
  });

  it("accepts cost, costUsd or totalCost — first finite wins", () => {
    const withCost = reduceAskFrame(initialAskState, {
      type: "usage",
      data: {
        tokensIn: 1,
        tokensOut: 2,
        iterations: 1,
        latencyMs: 1,
        sources: 1,
        cost: null,
        costUsd: 0.004,
        totalCost: 9,
      },
    });
    expect(withCost.usage?.cost).toBe(0.004);

    const withoutCost = reduceAskFrame(initialAskState, {
      type: "usage",
      data: { tokensIn: 1, tokensOut: 2, iterations: 1, latencyMs: 1, sources: 1 },
    });
    expect(withoutCost.usage && "cost" in withoutCost.usage).toBe(false);
  });

  it("the turn footer renders the token fragments at the end", () => {
    renderTurn(
      makeTurn({
        usage: {
          tokensIn: 100,
          tokensOut: 200,
          iterations: 2,
          latencyMs: 645,
          sources: 1,
          cost: 0.0023,
        },
      }),
    );

    expect(screen.getByTestId("ask-usage-tokens")).toHaveTextContent(
      "100 in · 200 out · 300 total tokens",
    );
    expect(screen.getByTestId("ask-usage-cost")).toHaveTextContent("$0.0023");
    expect(screen.getByTestId("ask-usage")).toHaveTextContent("2 iterations");
  });
});

describe("Spec 154 E — sources live behind their own collapse", () => {
  const sources: AskSource[] = [1, 2, 3, 4].map((idx) => ({
    idx,
    title: `Source ${idx}`,
    url: `https://source.test/${idx}`,
    domain: "source.test",
  }));

  it("is closed by default, titled Sources (N), and expands to the cards", () => {
    renderTurn(makeTurn({ sourcesList: sources }));

    const trigger = screen.getByTestId("ask-sources-collapsible-trigger");
    expect(trigger).toHaveTextContent("Sources (4)");
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("ask-sources")).not.toBeInTheDocument();

    fireEvent.click(trigger);

    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("ask-sources")).toBeInTheDocument();
    expect(screen.getByTestId("ask-source-1")).toHaveTextContent("Source 1");
  });

  it("renders no collapse when there are no sources", () => {
    renderTurn(makeTurn({ sourcesList: [] }));

    expect(screen.queryByTestId("ask-sources-collapsible-trigger")).not.toBeInTheDocument();
  });
});

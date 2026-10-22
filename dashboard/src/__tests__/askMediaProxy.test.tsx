import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AskSources } from "@/components/ask/AskSources";
import { AskMediaView } from "@/components/ask/AskMediaView";
import { AskView } from "@/views/AskView";
import { AskView as MobileAskView } from "@/mobile/AskView";
import { proxiedImage } from "@/lib/mediaProxy";
import type { AskFrame, AskSource } from "@/lib/ask";

/**
 * The same-origin image proxy and the media that comes with it (spec 152).
 *
 * The browser must never be pointed at a third-party host: every remote
 * image the Ask UI draws goes through the gateway's proxy, and a favicon
 * that cannot be fetched falls back to the globe instead of leaving an
 * empty square.
 */

const SOURCES: AskSource[] = [
  { idx: 1, title: "One", url: "https://one.test/a", domain: "one.test" },
  { idx: 2, title: "Two", url: "https://two.test/b", domain: "two.test" },
  { idx: 3, title: "Three", url: "https://three.test/c", domain: "three.test" },
  { idx: 4, title: "Four", url: "https://four.test/d", domain: "four.test" },
];

/** The url the proxy is asked for, decoded out of the query. */
function proxiedTarget(src: string): string {
  const query = src.split("?url=")[1] ?? "";
  return decodeURIComponent(query);
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The helper
// ---------------------------------------------------------------------------

describe("proxiedImage", () => {
  it("sends a remote image through the gateway", () => {
    const url = proxiedImage("https://images.test/a.png");
    expect(url.startsWith("/api/media/proxy?url=")).toBe(true);
    expect(proxiedTarget(url)).toBe("https://images.test/a.png");
  });

  it("leaves a data URL, a blob URL and a same-origin path alone", () => {
    expect(proxiedImage("data:image/png;base64,AAAA")).toBe("data:image/png;base64,AAAA");
    expect(proxiedImage("blob:http://x/1234")).toBe("blob:http://x/1234");
    expect(proxiedImage("/api/media?path=/tmp/a.png")).toBe("/api/media?path=/tmp/a.png");
    expect(proxiedImage("")).toBe("");
    expect(proxiedImage(undefined)).toBe("");
  });
});

// ---------------------------------------------------------------------------
// The source cards
// ---------------------------------------------------------------------------

describe("AskSources — the favicons go through the proxy", () => {
  it("the browser is never pointed at the favicon service", () => {
    render(<AskSources sources={SOURCES} />);

    const images = Array.from(document.querySelectorAll("img"));
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) {
      const src = img.getAttribute("src") ?? "";
      expect(src.startsWith("/api/media/proxy?url=")).toBe(true);
      // The image is fetched from OUR origin — the third-party host is only
      // the target the gateway fetches, never the one the browser asks.
      expect(new URL(src, "http://dashboard.test").origin).toBe("http://dashboard.test");
      // The proxied target is the favicon service's URL.
      expect(proxiedTarget(src)).toContain("s2.googleusercontent.com");
    }
  });

  it("a broken favicon falls back to the globe", () => {
    render(<AskSources sources={[SOURCES[0]]} />);

    const img = document.querySelector("img") as HTMLImageElement;
    expect(img).toBeInTheDocument();
    fireEvent.error(img);

    // The globe took its place — no empty square.
    expect(screen.getByTestId("ask-favicon-fallback")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
  });

  it("the 'View N more' tile never shows empty squares", () => {
    render(<AskSources sources={SOURCES} />);

    const tile = screen.getByTestId("ask-sources-more");
    // The label is unchanged.
    expect(tile).toHaveTextContent("View 1 more");

    const images = Array.from(tile.querySelectorAll("img"));
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) {
      expect((img.getAttribute("src") ?? "").startsWith("/api/media/proxy?url=")).toBe(true);
    }

    // Every one of them falls back to the globe.
    for (const img of images) {
      fireEvent.error(img);
    }
    expect(tile.querySelectorAll("img")).toHaveLength(0);
    expect(tile.querySelectorAll('[data-testid="ask-favicon-fallback"]').length).toBe(
      images.length,
    );
    // The label is still there.
    expect(screen.getByTestId("ask-sources-more")).toHaveTextContent("View 1 more");
  });
});

// ---------------------------------------------------------------------------
// The media rail
// ---------------------------------------------------------------------------

describe("AskMediaView — the thumbnails go through the proxy", () => {
  const media = [
    {
      kind: "image" as const,
      url: "https://images.test/photo.jpg",
      img_src: "https://images.test/photo.jpg",
      title: "A photo",
    },
    {
      kind: "video" as const,
      url: "https://video.test/watch",
      thumb: "https://video.test/thumb.jpg",
      title: "A video",
      iframe_src: "https://www.youtube.com/embed/x",
    },
  ];

  it("the strip draws proxied image and video thumbnails", () => {
    render(<AskMediaView media={media} variant="strip" />);

    const images = Array.from(document.querySelectorAll("img"));
    expect(images.length).toBe(2);
    for (const img of images) {
      const src = img.getAttribute("src") ?? "";
      expect(src.startsWith("/api/media/proxy?url=")).toBe(true);
      // The bytes come from OUR origin, not from the result host.
      expect(new URL(src, "http://dashboard.test").origin).toBe("http://dashboard.test");
    }
    expect(proxiedTarget(images[0].getAttribute("src") ?? "")).toBe(
      "https://images.test/photo.jpg",
    );
    expect(proxiedTarget(images[1].getAttribute("src") ?? "")).toBe(
      "https://video.test/thumb.jpg",
    );
  });

  it("a broken thumbnail leaves a placeholder, not an empty box", () => {
    render(<AskMediaView media={media} variant="strip" />);

    const img = document.querySelector("img") as HTMLImageElement;
    fireEvent.error(img);

    expect(screen.getByTestId("ask-media-thumb-missing")).toBeInTheDocument();
  });

  it("the link still points at the original page", () => {
    render(<AskMediaView media={media} variant="strip" />);

    const link = document.querySelector('a[href="https://images.test/photo.jpg"]');
    expect(link).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// The media is fetched on its own (spec 152 §C)
// ---------------------------------------------------------------------------

const FRAMES: AskFrame[] = [
  { type: "init" },
  {
    type: "sources",
    data: [
      {
        idx: 1,
        title: "One",
        url: "https://one.test/a",
        domain: "one.test",
      },
    ],
  },
  { type: "response", data: "The answer." },
  { type: "done" },
];

/** A fetch mock that answers every Ask endpoint the SPA talks to. */
function mockAskFetch(options: { mediaFails?: boolean } = {}) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.startsWith("/api/ask/threads")) {
      return new Response(JSON.stringify({ threads: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url === "/api/ask/images" || url === "/api/ask/videos") {
      if (options.mediaFails) {
        return new Response(JSON.stringify({ error: "media backend unavailable" }), {
          status: 502,
          headers: { "Content-Type": "application/json" },
        });
      }
      const kind = url.endsWith("images") ? "images" : "videos";
      const body =
        kind === "images"
          ? {
              images: [
                {
                  url: "https://images.test/photo.jpg",
                  img_src: "https://images.test/photo.jpg",
                  title: "A photo",
                },
              ],
            }
          : {
              videos: [
                {
                  url: "https://video.test/watch",
                  img_src: "https://video.test/thumb.jpg",
                  title: "A video",
                  iframe_src: "https://www.youtube.com/embed/x",
                },
              ],
            };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    // The answer stream.
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const frame of FRAMES) {
          controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

async function askAQuestion(view: React.ReactElement) {
  render(view);
  await act(async () => {
    fireEvent.change(screen.getByTestId("ask-query"), {
      target: { value: "What is the capital of France?" },
    });
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("ask-submit"));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByTestId("ask-answer")).toBeInTheDocument());
}

describe("Ask — the media is included by default", () => {
  it("the images and the videos are fetched without a tap", async () => {
    const { calls } = mockAskFetch();

    await askAQuestion(<AskView />);

    await waitFor(() => expect(calls).toContain("/api/ask/images"));
    expect(calls).toContain("/api/ask/videos");
  });

  it("the media is drawn under the answer, through the proxy", async () => {
    mockAskFetch();

    await askAQuestion(<AskView />);

    await waitFor(() => expect(screen.getByTestId("ask-media-strip")).toBeInTheDocument());

    const images = Array.from(
      screen.getByTestId("ask-media-strip").querySelectorAll("img"),
    );
    expect(images.length).toBe(2);
    for (const img of images) {
      expect((img.getAttribute("src") ?? "").startsWith("/api/media/proxy?url=")).toBe(
        true,
      );
    }
  });

  it("the media request carries the thread and the turn, so it is stored", async () => {
    const { fetchMock } = mockAskFetch();

    await askAQuestion(<AskView />);

    await waitFor(() => {
      const call = fetchMock.mock.calls.find(
        (c) => String(c[0]) === "/api/ask/images",
      );
      expect(call).toBeTruthy();
      const body = JSON.parse(((call?.[1] as any)?.body ?? "{}") as string);
      expect(body.thread_id).toBeTruthy();
      expect(body.turn_id).toBeTruthy();
      expect(body.query).toBe("What is the capital of France?");
      // The thread's conversation grounds the search — and the turn itself
      // is in it ONCE.
      expect(body.chatHistory).toEqual([
        ["human", "What is the capital of France?"],
        ["assistant", "The answer."],
      ]);
    });
  });

  it("a media failure is silent — the answer still stands", async () => {
    mockAskFetch({ mediaFails: true });

    await askAQuestion(<AskView />);

    // Give the failing requests a chance to land.
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByTestId("ask-answer")).toHaveTextContent("The answer.");
    expect(screen.queryByText(/Could not load images/)).toBeNull();
    expect(screen.queryByText(/Could not load videos/)).toBeNull();
    expect(screen.queryByTestId("ask-error")).toBeNull();
  });

  it("the mobile shell fetches the media too — the same shared module", async () => {
    const { calls } = mockAskFetch();

    await askAQuestion(<MobileAskView />);

    await waitFor(() => expect(calls).toContain("/api/ask/images"));
    expect(calls).toContain("/api/ask/videos");
  });
});

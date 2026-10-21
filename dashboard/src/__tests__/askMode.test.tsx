import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import React from "react";

import {
  ASK_MODES,
  ASK_SOURCE_KINDS,
  describeAskStep,
  formatAskUsage,
  initialAskState,
  loadAskHistory,
  parseAskFrames,
  pushAskHistory,
  reduceAskFrame,
  splitAnswerCitations,
  useAskStream,
  type AskFrame,
  type AskState,
} from "@/lib/ask";
import { AskView } from "@/views/AskView";
import { AskView as MobileAskView } from "@/mobile/AskView";

/**
 * Ask mode (spec 145 §D/§F).
 *
 * The reducer is the contract, so it is tested frame by frame; the two views
 * are then checked to render the SAME state — the parity the shared module
 * exists for.
 */

const FRAMES: AskFrame[] = [
  { type: "init" },
  { type: "phase", data: { phase: "classifying" } },
  { type: "phase", data: { phase: "researching" } },
  { type: "step", data: { kind: "searching", queries: ["capital of France"] } },
  {
    type: "step",
    data: { kind: "reading", url: "https://en.wikipedia.org/wiki/Paris", title: "Paris" },
  },
  {
    type: "sources",
    data: [
      {
        idx: 1,
        title: "Paris - Wikipedia",
        url: "https://en.wikipedia.org/wiki/Paris",
        domain: "en.wikipedia.org",
      },
    ],
  },
  { type: "response", data: "Paris is the capital of France" },
  { type: "response", data: "[1]." },
  {
    type: "usage",
    data: { tokensIn: 126, tokensOut: 21, iterations: 2, latencyMs: 645, sources: 1 },
  },
  { type: "done" },
];

/** A stream the test drives by hand, so the live state is observable. */
function controllableStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
  });

  return {
    response: new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/x-ndjson" },
    }),
    push(frame: AskFrame) {
      controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
    },
    close() {
      controller.close();
    },
  };
}

/** A stream that delivers everything at once. */
function oneShotStream(frames: AskFrame[]) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
      }
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "Content-Type": "application/x-ndjson" },
  });
}

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The reducer — every frame type
// ---------------------------------------------------------------------------

describe("Ask reducer — every frame type", () => {
  const fold = (frames: AskFrame[], start: AskState = initialAskState) =>
    frames.reduce((state, frame) => reduceAskFrame(state, frame), start);

  it("init opens the stream", () => {
    const state = fold([{ type: "init" }]);
    expect(state.streaming).toBe(true);
    expect(state.phase).toBe("idle");
  });

  it("phase carries the engine's own vocabulary", () => {
    expect(fold([{ type: "phase", data: { phase: "classifying" } }]).phase).toBe(
      "classifying",
    );
    expect(fold([{ type: "phase", data: { phase: "researching" } }]).phase).toBe(
      "researching",
    );
    expect(fold([{ type: "phase", data: { phase: "writing" } }]).phase).toBe("writing");
    // An unknown phase is dropped, not forwarded.
    expect(fold([{ type: "phase", data: { phase: "vibing" } }]).phase).toBe("idle");
  });

  it("step collects searching and reading steps", () => {
    const state = fold([
      { type: "step", data: { kind: "searching", queries: ["a", "b"] } },
      { type: "step", data: { kind: "reading", url: "https://x.test/1", title: "One" } },
    ]);

    expect(state.steps).toHaveLength(2);
    expect(state.steps[0]).toEqual({ kind: "searching", queries: ["a", "b"] });
    expect(state.steps[1]).toEqual({
      kind: "reading",
      url: "https://x.test/1",
      title: "One",
    });
  });

  it("sources keep their citation index", () => {
    const state = fold([
      {
        type: "sources",
        data: [
          { idx: 1, title: "One", url: "https://x.test/1", domain: "x.test" },
          { idx: 2, title: "Two", url: "https://y.test/2", domain: "y.test" },
        ],
      },
    ]);

    expect(state.sources).toHaveLength(2);
    expect(state.sources[0].idx).toBe(1);
    expect(state.sources[1].domain).toBe("y.test");
  });

  it("response deltas concatenate into the answer", () => {
    const state = fold([
      { type: "response", data: "Paris " },
      { type: "response", data: "is the capital" },
    ]);
    expect(state.answer).toBe("Paris is the capital");
  });

  it("usage carries the counters", () => {
    const state = fold([
      {
        type: "usage",
        data: { tokensIn: 10, tokensOut: 20, iterations: 3, latencyMs: 1234, sources: 7 },
      },
    ]);

    expect(state.usage).toEqual({
      tokensIn: 10,
      tokensOut: 20,
      iterations: 3,
      latencyMs: 1234,
      sources: 7,
    });
  });

  it("done closes the stream", () => {
    const state = fold([{ type: "init" }, { type: "done" }]);
    expect(state.streaming).toBe(false);
    expect(state.phase).toBe("done");
  });

  it("error is terminal and carries a message and a code", () => {
    const state = fold([
      { type: "init" },
      { type: "error", data: { message: "boom", code: "search_failed" } },
    ]);

    expect(state.streaming).toBe(false);
    expect(state.phase).toBe("error");
    expect(state.error).toEqual({ message: "boom", code: "search_failed" });
  });

  it("an unknown frame changes nothing", () => {
    const before = fold([{ type: "init" }]);
    const after = reduceAskFrame(before, { type: "who-knows", data: { x: 1 } });
    expect(after).toBe(before);
  });

  it("the whole frame sequence folds into the finished state", () => {
    const state = fold(FRAMES);

    expect(state.answer).toBe("Paris is the capital of France[1].");
    expect(state.sources).toHaveLength(1);
    expect(state.steps).toHaveLength(2);
    expect(state.usage?.iterations).toBe(2);
    expect(state.streaming).toBe(false);
    expect(state.phase).toBe("done");
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe("Ask helpers", () => {
  it("the NDJSON reader splits frames and keeps the remainder", () => {
    const { frames, rest } = parseAskFrames('{"type":"init"}\n{"type":"resp');
    expect(frames).toEqual([{ type: "init" }]);
    expect(rest).toBe('{"type":"resp');
  });

  it("citations are split out of the answer text", () => {
    const parts = splitAnswerCitations("Paris[1] is nice[2][3].");
    expect(parts.filter((p) => p.type === "citation")).toHaveLength(3);
    expect(parts.map((p) => p.value).join("")).toBe("Paris[1] is nice[2][3].");
  });

  it("the usage footer reads like the design", () => {
    expect(
      formatAskUsage({
        tokensIn: 100,
        tokensOut: 2000,
        iterations: 6,
        latencyMs: 4200,
        sources: 12,
      }),
    ).toBe("4.2 s · 6 iterations · 12 sources · 2.1k tokens");
  });

  it("a step reads as a line", () => {
    expect(describeAskStep({ kind: "searching", queries: ["a"] })).toContain("a");
    expect(
      describeAskStep({ kind: "reading", url: "https://example.com/x", title: "X" }),
    ).toBe("reading example.com");
  });

  it("the history rail is capped at 50 and survives a reload", () => {
    const entries = Array.from({ length: 60 }, (_, index) => ({
      id: `id-${index}`,
      query: `q${index}`,
      mode: "speed" as const,
      sources: ["web" as const],
      answer: "",
      createdAt: index,
    }));

    pushAskHistory([], entries[0]);
    for (const entry of entries.slice(1)) pushAskHistory(loadAskHistory(), entry);

    const stored = loadAskHistory();
    expect(stored).toHaveLength(50);
    expect(stored[0].query).toBe("q59");
  });

  it("the mode and source lists are the ones the backend understands", () => {
    expect(ASK_MODES.map((m) => m.id)).toEqual(["speed", "balanced", "quality"]);
    expect(ASK_SOURCE_KINDS.map((s) => s.id)).toEqual([
      "web",
      "discussions",
      "academic",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------

describe("Ask view — desktop and mobile render the same state", () => {
  it("the desktop view renders the answer, its citations and the sources", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(oneShotStream(FRAMES)));

    render(<AskView />);

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

    const answer = screen.getByTestId("ask-answer");
    expect(answer).toHaveTextContent("Paris is the capital of France");

    // The [1] marker became a link to the source.
    const citation = screen.getByTestId("ask-citation-1");
    expect(citation).toHaveAttribute("href", "https://en.wikipedia.org/wiki/Paris");
    expect(citation).toHaveAttribute("target", "_blank");

    // The numbered source list is there and clickable.
    const source = screen.getByTestId("ask-source-1");
    expect(source).toHaveTextContent("Paris - Wikipedia");
    expect(source.querySelector("a")).toHaveAttribute(
      "href",
      "https://en.wikipedia.org/wiki/Paris",
    );

    // The research steps are collapsed until asked for.
    expect(screen.getByTestId("ask-steps")).toBeInTheDocument();
    expect(screen.queryByTestId("ask-step-list")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByTestId("ask-steps-toggle"));
      await Promise.resolve();
    });
    expect(screen.getByTestId("ask-step-list")).toBeInTheDocument();

    // The usage footer.
    expect(screen.getByTestId("ask-usage")).toHaveTextContent("2 iterations");
  });

  it("the mobile view renders the same answer, citations and sources", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(oneShotStream(FRAMES)));

    render(<MobileAskView />);

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

    expect(screen.getByTestId("ask-answer")).toHaveTextContent(
      "Paris is the capital of France",
    );
    expect(screen.getByTestId("ask-citation-1")).toHaveAttribute(
      "href",
      "https://en.wikipedia.org/wiki/Paris",
    );
    expect(screen.getByTestId("ask-source-1")).toHaveTextContent("Paris - Wikipedia");
    expect(screen.getByTestId("ask-usage")).toHaveTextContent("2 iterations");
  });

  it("the Stop button appears while streaming and disappears after done", async () => {
    const stream = controllableStream();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(stream.response));

    render(<AskView />);

    await act(async () => {
      fireEvent.change(screen.getByTestId("ask-query"), { target: { value: "hello" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ask-submit"));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId("ask-stop")).toBeInTheDocument());

    await act(async () => {
      stream.push({ type: "init" });
      stream.push({ type: "response", data: "partial" });
      await Promise.resolve();
    });

    expect(screen.getByTestId("ask-stop")).toBeInTheDocument();

    await act(async () => {
      stream.push({ type: "done" });
      stream.close();
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.queryByTestId("ask-stop")).toBeNull());
  });

  it("a backend that is down shows the error, not an empty answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: "ask backend unavailable" } }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      ),
    );

    render(<AskView />);

    await act(async () => {
      fireEvent.change(screen.getByTestId("ask-query"), { target: { value: "hello" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ask-submit"));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId("ask-error")).toBeInTheDocument());
    expect(screen.getByTestId("ask-error")).toHaveTextContent("ask backend unavailable");
    expect(screen.queryByTestId("ask-stop")).toBeNull();
  });

  it("the mode selector and the source toggles are there", () => {
    render(<AskView />);

    expect(screen.getByTestId("ask-mode-speed")).toBeInTheDocument();
    expect(screen.getByTestId("ask-mode-balanced")).toBeInTheDocument();
    expect(screen.getByTestId("ask-mode-quality")).toBeInTheDocument();
    expect(screen.getByTestId("ask-source-web")).toBeInTheDocument();
    expect(screen.getByTestId("ask-source-discussions")).toBeInTheDocument();
    expect(screen.getByTestId("ask-source-academic")).toBeInTheDocument();

    // The toggles flip.
    const academic = screen.getByTestId("ask-source-academic");
    expect(academic).toHaveAttribute("aria-pressed", "false");
    fireEvent.click(academic);
    expect(academic).toHaveAttribute("aria-pressed", "true");
  });
});

/**
 * The shared hook is the only place the transport lives — both shells call it,
 * so a regression there shows up in both at once.
 */
describe("useAskStream", () => {
  it("exposes the state, the history and the controls", () => {
    function Probe() {
      const { state, history, run, stop, reset, reopen, forget } = useAskStream();
      return (
        <div>
          <span data-testid="probe-phase">{state.phase}</span>
          <span data-testid="probe-streaming">{String(state.streaming)}</span>
          <span data-testid="probe-history">{history.length}</span>
          <button type="button" onClick={() => void run({ query: "x", mode: "speed", sources: ["web"] })}>
            run
          </button>
          <button type="button" onClick={() => void stop()}>
            stop
          </button>
          <button type="button" onClick={reset}>
            reset
          </button>
          <button
            type="button"
            onClick={() =>
              reopen({
                id: "x",
                query: "old",
                mode: "speed",
                sources: ["web"],
                answer: "the old answer",
                createdAt: 0,
              })
            }
          >
            reopen
          </button>
          <button type="button" onClick={() => forget("x")}>
            forget
          </button>
        </div>
      );
    }

    render(<Probe />);

    expect(screen.getByTestId("probe-phase")).toHaveTextContent("idle");
    expect(screen.getByTestId("probe-streaming")).toHaveTextContent("false");

    fireEvent.click(screen.getByText("reopen"));
    expect(screen.getByTestId("probe-phase")).toHaveTextContent("done");

    fireEvent.click(screen.getByText("reset"));
    expect(screen.getByTestId("probe-phase")).toHaveTextContent("idle");
  });
});

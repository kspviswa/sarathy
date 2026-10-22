import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  ASK_MODES,
  ASK_SOURCE_KINDS,
  appendAskTurn,
  createAskThread,
  describeAskStep,
  formatAskUsage,
  initialAskState,
  normaliseCitationMarkers,
  parseAskFrames,
  phaseLabel,
  preprocessAskCitations,
  reduceAskFrame,
  splitAnswerCitations,
  useAskStream,
  ASK_HISTORY_KEY,
  ASK_HISTORY_TURNS,
  ASK_THREADS_KEY,
  buildAskHistory,
  type AskFrame,
  type AskState,
  type AskThread,
  type AskTurn,
} from "@/lib/ask";
import { AskResearchProgress } from "@/components/ask/AskResearchProgress";
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

/**
 * A fetch mock that answers the Ask thread endpoints and replays the
 * stream.
 *
 * The thread list is fetched on every mount (the history is server-side
 * now), so a mock that answered EVERY call with the stream would hand the
 * list a body it cannot read — and the same Response cannot be read twice.
 */
function mockAskFetch(stream: Response | AskFrame[]) {
  const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/ask/threads")) {
      return new Response(JSON.stringify({ threads: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return Array.isArray(stream) ? oneShotStream(stream) : stream;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The calls that asked the engine something — the thread list excluded. */
function askCalls(fetchMock: ReturnType<typeof mockAskFetch>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/ask");
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
    // Two research steps from the wire, plus the DERIVED `found` step the
    // reducer adds when the `sources` frame lands (spec §D.3).
    expect(state.steps).toHaveLength(3);
    expect(state.usage?.iterations).toBe(2);
    expect(state.streaming).toBe(false);
    expect(state.phase).toBe("done");
  });

  it("the reasoning step is kept, and a grown plan updates it in place", () => {
    const state = fold([
      { type: "step", data: { kind: "reasoning", reasoning: "Looking for" } },
      { type: "step", data: { kind: "reasoning", reasoning: "Looking for Paris" } },
    ]);

    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]).toEqual({
      kind: "reasoning",
      reasoning: "Looking for Paris",
    });
  });

  it("the `found` step is derived from the sources frame", () => {
    const state = fold([
      { type: "step", data: { kind: "searching", queries: ["a"] } },
      {
        type: "sources",
        data: [
          { idx: 1, title: "One", url: "https://x.test/1", domain: "x.test" },
          { idx: 2, title: "Two", url: "https://y.test/2", domain: "y.test" },
        ],
      },
    ]);

    expect(state.steps).toHaveLength(2);
    expect(state.steps[1]).toEqual({ kind: "found", count: 2 });
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

  it("the history rail is gone from the browser — the threads are the server's", () => {
    // The v1 flat history had a fifty-entry cap and lived in the browser.
    // Both are gone: the Ask history is the gateway's now (job 150 §B).
    expect(ASK_HISTORY_KEY).toBe("sarathy.ask.history");
    expect(ASK_THREADS_KEY).toBe("sarathy.ask.threads");
  });

  it("the mode and source lists are the ones the backend understands", () => {
    expect(ASK_MODES.map((m) => m.id)).toEqual(["speed", "balanced", "quality"]);
    expect(ASK_SOURCE_KINDS.map((s) => s.id)).toEqual([
      "web",
      "discussions",
      "academic",
    ]);
  });

  it("the phase line speaks Uttaram's three words (spec §D.2)", () => {
    expect(phaseLabel("classifying")).toBe("Classifying query…");
    expect(phaseLabel("researching")).toBe("Brainstorming…");
    expect(phaseLabel("writing")).toBe("Generating answer…");
  });
});

// ---------------------------------------------------------------------------
// The citation markers (complaint #4 / #7)
// ---------------------------------------------------------------------------

describe("Ask citations", () => {
  it("a [n] marker becomes a link to the sentinel the renderer intercepts", () => {
    expect(preprocessAskCitations("Paris[1] is nice[2].")).toBe(
      "Paris[1](#cite-1) is nice[2](#cite-2).",
    );
  });

  it("a [n,m] marker becomes one link per number", () => {
    expect(preprocessAskCitations("Both[1,2] agree.")).toBe(
      "Both[1](#cite-1)[2](#cite-2) agree.",
    );
  });

  it("a real markdown link is left alone", () => {
    const text = "See [1](https://example.com/a) for details.";
    expect(preprocessAskCitations(text)).toBe(text);
  });

  it("the copy action puts the plain [n] markers back", () => {
    expect(normaliseCitationMarkers("Paris[1](#cite-1) and [2](#cite-2)")).toBe(
      "Paris[1] and [2]",
    );
  });
});

// ---------------------------------------------------------------------------
// The thread model (spec §D.1)
// ---------------------------------------------------------------------------

describe("Ask threads", () => {
  const turn = (id: string, query = `q-${id}`): AskTurn => ({
    id,
    query,
    mode: "speed",
    sources: ["web"],
    answer: `a-${id}`,
    sourcesList: [],
    steps: [],
    createdAt: 1_700_000_000_000,
  });

  it("a turn opens a thread whose title is the first query", () => {
    const thread = createAskThread(turn("t1", "What is the capital of France?"));
    expect(thread.turns).toHaveLength(1);
    expect(thread.title).toBe("What is the capital of France?");
  });

  it("a long title is clipped", () => {
    const thread = createAskThread(turn("t1", "x".repeat(200)));
    expect(thread.title.length).toBeLessThanOrEqual(81);
  });

  it("appending a turn keeps it in the same thread", () => {
    const first = createAskThread(turn("t1"));
    const threads = appendAskTurn([first], first.id, turn("t2"));

    expect(threads).toHaveLength(1);
    expect(threads[0].turns.map((t) => t.id)).toEqual(["t1", "t2"]);
    // The title stays the FIRST question.
    expect(threads[0].title).toBe("q-t1");
    // The count the history rail shows follows the turns.
    expect(threads[0].turnCount).toBe(2);
  });

  it("a turn for an unknown thread opens a new one", () => {
    const threads = appendAskTurn([], "thread-x", turn("t1"));
    expect(threads).toHaveLength(1);
    expect(threads[0].id).toBe("thread-x");
  });

  it("the thread list is NOT capped any more", () => {
    // The fifty-thread cap was a symptom of the browser-local store: the
    // history is the server's now, and it holds them all.
    let threads: AskThread[] = [];
    for (let i = 0; i < 60; i += 1) {
      threads = appendAskTurn(threads, `thread-${i}`, turn(`t${i}`));
    }
    expect(threads).toHaveLength(60);
  });
});

// ---------------------------------------------------------------------------
// The views
// ---------------------------------------------------------------------------

describe("Ask view — desktop and mobile render the same state", () => {
  it("the desktop view renders the answer, its citations and the sources", async () => {
    mockAskFetch(FRAMES);

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
    mockAskFetch(FRAMES);

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
    mockAskFetch(stream.response);

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

// ---------------------------------------------------------------------------
// The answer is REAL markdown (complaint #4) and the citations are live
// ---------------------------------------------------------------------------

const MARKDOWN_ANSWER = [
  "# Paris",
  "",
  "It is the **capital** of France[1], and [9] is not a source.",
  "",
  "- one",
  "- two",
  "",
  "```py",
  "print('hi')",
  "```",
  "",
  "| a | b |",
  "| --- | --- |",
  "| 1 | 2 |",
  "",
].join("\n");

const MARKDOWN_FRAMES: AskFrame[] = [
  { type: "init" },
  { type: "phase", data: { phase: "writing" } },
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
  { type: "response", data: MARKDOWN_ANSWER },
  { type: "done" },
];

async function askARound(view: React.ReactElement, query = "What is the capital of France?") {
  render(view);
  await act(async () => {
    fireEvent.change(screen.getByTestId("ask-query"), { target: { value: query } });
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("ask-submit"));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByTestId("ask-answer")).toBeInTheDocument());
}

describe("Ask view — the answer is real markdown, not raw text", () => {
  it("renders headings, bold, lists, code fences and GFM tables as real DOM", async () => {
    mockAskFetch(MARKDOWN_FRAMES);

    await askARound(<AskView />);

    const answer = screen.getByTestId("ask-answer-markdown");
    expect(answer.querySelector("h1")).toHaveTextContent("Paris");
    expect(answer.querySelector("strong")).toHaveTextContent("capital");
    expect(answer.querySelector("ul > li")).toBeInTheDocument();
    expect(answer.querySelector("pre > code")).toHaveTextContent("print('hi')");
    expect(answer.querySelector("table > tbody > tr")).toBeInTheDocument();
  });

  it("a [n] marker is a pill that links to the source; an unknown one stays text", async () => {
    mockAskFetch(MARKDOWN_FRAMES);

    await askARound(<AskView />);

    const pill = screen.getByTestId("ask-citation-1");
    expect(pill).toHaveAttribute("href", "https://en.wikipedia.org/wiki/Paris");
    expect(pill).toHaveAttribute("target", "_blank");
    expect(pill).toHaveTextContent("[1]");

    // Out of range: no pill, just the marker.
    expect(screen.queryByTestId("ask-citation-9")).not.toBeInTheDocument();
    expect(screen.getByTestId("ask-answer-markdown")).toHaveTextContent("[9]");
  });

  it("the mobile view renders the same markdown", async () => {
    mockAskFetch(MARKDOWN_FRAMES);

    await askARound(<MobileAskView />);

    const answer = screen.getByTestId("ask-answer-markdown");
    expect(answer.querySelector("h1")).toHaveTextContent("Paris");
    expect(answer.querySelector("table > tbody > tr")).toBeInTheDocument();
    expect(screen.getByTestId("ask-citation-1")).toHaveAttribute(
      "href",
      "https://en.wikipedia.org/wiki/Paris",
    );
  });
});

// ---------------------------------------------------------------------------
// Quote and reply on Ask (spec §E)
// ---------------------------------------------------------------------------

describe("Ask view — quote and reply", () => {
  it("Reply seeds the composer with the replied-to turn", async () => {
    mockAskFetch(FRAMES);

    await askARound(<AskView />);

    fireEvent.click(screen.getByTestId("ask-action-reply"));

    expect(screen.getByTestId("ask-reply-context")).toHaveTextContent(
      "What is the capital of France?",
    );
  });

  it("the reply banner can be dismissed", async () => {
    mockAskFetch(FRAMES);

    await askARound(<AskView />);
    fireEvent.click(screen.getByTestId("ask-action-reply"));
    expect(screen.getByTestId("ask-reply-context")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("ask-reply-dismiss"));
    expect(screen.queryByTestId("ask-reply-context")).not.toBeInTheDocument();
  });

  it("Quote drops the answer on the composer as a chip", async () => {
    mockAskFetch(FRAMES);

    await askARound(<AskView />);
    fireEvent.click(screen.getByTestId("ask-action-quote"));

    expect(screen.getByTestId("quote-chip")).toHaveTextContent(
      "Paris is the capital of France[1].",
    );
  });

  it("the next request carries the reply's history and the quotes", async () => {
    const fetchMock = mockAskFetch(FRAMES);

    await askARound(<AskView />);

    // Reply to the finished turn, then ask a follow-up.
    fireEvent.click(screen.getByTestId("ask-action-reply"));
    await act(async () => {
      fireEvent.change(screen.getByTestId("ask-query"), {
        target: { value: "And its population?" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ask-submit"));
      await Promise.resolve();
    });

    const calls = askCalls(fetchMock);
    expect(calls).toHaveLength(2);
    const body = JSON.parse((calls[1][1]?.body ?? "{}") as string);
    expect(body.query).toBe("And its population?");
    // The replied-to turn's question and answer ground the follow-up.
    expect(body.history).toEqual([
      ["human", "What is the capital of France?"],
      ["assistant", "Paris is the capital of France[1]."],
    ]);
  });

  it("a quoted passage travels with the request", async () => {
    const fetchMock = mockAskFetch(FRAMES);

    await askARound(<AskView />);
    fireEvent.click(screen.getByTestId("ask-action-quote"));

    await act(async () => {
      fireEvent.change(screen.getByTestId("ask-query"), {
        target: { value: "More?" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ask-submit"));
      await Promise.resolve();
    });

    const calls = askCalls(fetchMock);
    const body = JSON.parse((calls[1][1]?.body ?? "{}") as string);
    expect(body.quotes).toHaveLength(1);
    expect(body.quotes[0].text).toBe("Paris is the capital of France[1].");
  });
});

/**
 * The shared hook is the only place the transport lives — both shells call it,
 * so a regression there shows up in both at once.
 */
describe("useAskStream", () => {
  it("exposes the state, the history and the controls", async () => {
    mockAskFetch(FRAMES);

    function Probe() {
      const { state, history, run, stop, reset } = useAskStream();
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
        </div>
      );
    }

    render(<Probe />);

    expect(screen.getByTestId("probe-phase")).toHaveTextContent("idle");
    expect(screen.getByTestId("probe-streaming")).toHaveTextContent("false");

    await act(async () => {
      fireEvent.click(screen.getByText("run"));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.getByTestId("probe-phase")).toHaveTextContent("done"));

    fireEvent.click(screen.getByText("reset"));
    expect(screen.getByTestId("probe-phase")).toHaveTextContent("idle");
  });
});

/**
 * Follow-up context (regression, 2026-10-21).
 *
 * A typed follow-up used to travel with NO history: `submit()` only built one
 * when the user had clicked "Reply" on an earlier turn, so "and the second
 * one?" reached the engine as a brand-new question. The thread is the
 * conversation, so the history is derived from it.
 */
describe("Ask follow-up history", () => {
  const turn = (over: Partial<AskTurn> = {}): AskTurn => ({
    id: "t1",
    query: "best budget laptops",
    mode: "speed",
    sources: ["web"],
    answer: "Three options: A, B, C.",
    sourcesList: [],
    steps: [],
    createdAt: 1,
    ...over,
  });

  it("a follow-up carries every earlier turn of the thread", () => {
    const history = buildAskHistory([turn()]);
    expect(history).toEqual([
      ["human", "best budget laptops"],
      ["assistant", "Three options: A, B, C."],
    ]);
  });

  it("a thread's first turn carries no history at all", () => {
    expect(buildAskHistory([])).toBeUndefined();
  });

  it("errored turns and empty answers are skipped", () => {
    const history = buildAskHistory([
      turn({ id: "t1" }),
      turn({ id: "t2", error: { message: "boom", code: "x" } }),
      turn({ id: "t3", answer: "   " }),
      turn({ id: "t4", query: "the second one?", answer: "B." }),
    ]);
    expect(history).toEqual([
      ["human", "best budget laptops"],
      ["assistant", "Three options: A, B, C."],
      ["human", "the second one?"],
      ["assistant", "B."],
    ]);
  });

  it("only the most recent turns travel, oldest dropped first", () => {
    const many = Array.from({ length: 10 }, (_, i) =>
      turn({ id: `t${i}`, query: `q${i}`, answer: `a${i}` }),
    );
    const history = buildAskHistory(many)!;
    expect(history).toHaveLength(ASK_HISTORY_TURNS * 2);
    expect(history[0]).toEqual(["human", `q${10 - ASK_HISTORY_TURNS}`]);
    expect(history[history.length - 1]).toEqual(["assistant", "a9"]);
  });

  it("stays inside the gateway's own cap (ASK_MAX_HISTORY = 20 items)", () => {
    const many = Array.from({ length: 30 }, (_, i) =>
      turn({ id: `t${i}`, query: `q${i}`, answer: `a${i}` }),
    );
    expect(buildAskHistory(many)!.length).toBeLessThanOrEqual(20);
  });
});

// ---------------------------------------------------------------------------
// Research progress — collapsed until asked for
// ---------------------------------------------------------------------------

describe("Ask research progress", () => {
  const steps = [
    { kind: "searching" as const, queries: ["capital of France"] },
    { kind: "reading" as const, url: "https://en.wikipedia.org/wiki/Paris", title: "Paris" },
  ];

  it("starts collapsed even while the turn streams", () => {
    render(<AskResearchProgress steps={steps} streaming />);

    expect(screen.getByTestId("ask-steps")).toHaveAttribute("data-expanded", "false");
    expect(screen.queryByTestId("ask-step-list")).toBeNull();
  });

  it("opens on demand and stays open when the stream ends", () => {
    const { rerender } = render(<AskResearchProgress steps={steps} streaming />);

    fireEvent.click(screen.getByTestId("ask-steps-toggle"));
    expect(screen.getByTestId("ask-step-list")).toBeInTheDocument();

    // The turn finishing must not fold the panel the reader just opened.
    rerender(<AskResearchProgress steps={steps} streaming={false} />);
    expect(screen.getByTestId("ask-step-list")).toBeInTheDocument();
  });
});

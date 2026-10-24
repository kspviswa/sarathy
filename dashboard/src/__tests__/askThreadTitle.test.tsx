import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import {
  getAskThreads,
  initialAskState,
  putAskThread,
  reduceAskFrame,
  renameAskThread,
  subscribeAskThreadList,
  type AskFrame,
  type AskThread,
  type AskTurn,
} from "@/lib/ask";
import { AskView } from "@/views/AskView";
import { AskView as MobileAskView } from "@/mobile/AskView";

/**
 * The LLM-authored thread title (spec 162).
 *
 * The question is the title until the engine names the thread; the `title`
 * frame then renames it — live, in the header and in the history — and the
 * server stores the same string, so a reopen agrees.
 */

const TITLE_FRAME: AskFrame = { type: "title", data: { title: "Capital of France" } };

const STREAM: AskFrame[] = [
  { type: "init" },
  { type: "phase", data: { phase: "writing" } },
  TITLE_FRAME,
  { type: "response", data: "Paris is the capital of France" },
  { type: "done" },
];

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

/** A fetch mock that answers the thread endpoints and replays the stream. */
function mockAskFetch(frames: AskFrame[]) {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/ask/threads")) {
      // A PATCH is the rename being persisted — echo a thread back.
      if (init?.method === "PATCH") {
        return new Response(JSON.stringify({ thread: { id: "t", title: "" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ threads: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    return oneShotStream(frames);
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

/** The PATCH calls — the title being written to the server. */
function patchCalls(fetchMock: ReturnType<typeof mockAskFetch>) {
  return fetchMock.mock.calls.filter(
    (call) => String(call[0]).startsWith("/api/ask/threads/") && call[1]?.method === "PATCH",
  );
}

function resetStore() {
  // The store is module state: empty it between tests.
  for (const thread of getAskThreads()) {
    putAskThread({ ...thread, title: "" });
  }
}

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

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
  resetStore();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

describe("reduceAskFrame — the title frame", () => {
  it("exposes the title and leaves the answer untouched", () => {
    const state = reduceAskFrame(initialAskState, TITLE_FRAME);
    expect(state.title).toBe("Capital of France");
    expect(state.answer).toBe("");
  });

  it("does not append the title to the answer", () => {
    let state = reduceAskFrame(initialAskState, TITLE_FRAME);
    state = reduceAskFrame(state, { type: "response", data: "Paris." });
    expect(state.answer).toBe("Paris.");
    expect(state.answer).not.toContain("Capital of France");
  });

  it("the first title wins — a later frame does not override it", () => {
    let state = reduceAskFrame(initialAskState, TITLE_FRAME);
    state = reduceAskFrame(state, { type: "title", data: { title: "Something Else" } });
    expect(state.title).toBe("Capital of France");
  });

  it("an empty or non-string title changes nothing", () => {
    expect(reduceAskFrame(initialAskState, { type: "title", data: { title: "  " } }).title).toBe(
      "",
    );
    expect(reduceAskFrame(initialAskState, { type: "title", data: { title: 7 } }).title).toBe("");
    expect(reduceAskFrame(initialAskState, { type: "title" }).title).toBe("");
  });

  it("a long title is clipped", () => {
    const state = reduceAskFrame(initialAskState, {
      type: "title",
      data: { title: "x".repeat(200) },
    });
    expect(state.title.length).toBeLessThanOrEqual(80);
  });
});

// ---------------------------------------------------------------------------
// renameAskThread
// ---------------------------------------------------------------------------

describe("renameAskThread", () => {
  it("updates the store and fires its listeners", () => {
    const thread: AskThread = {
      id: "t1",
      title: "what is the capital?",
      turns: [turn("t1")],
      createdAt: 1,
      updatedAt: 1,
      turnCount: 1,
      groupId: null,
    };
    putAskThread(thread);

    const listener = vi.fn();
    const unsubscribe = subscribeAskThreadList(listener);
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 200 })));

    renameAskThread("t1", "Capital of France");

    expect(listener).toHaveBeenCalled();
    expect(getAskThreads().find((item) => item.id === "t1")?.title).toBe("Capital of France");
    unsubscribe();
  });

  it("PATCHes the endpoint with the title", () => {
    putAskThread({
      id: "t1",
      title: "what is the capital?",
      turns: [turn("t1")],
      createdAt: 1,
      updatedAt: 1,
      turnCount: 1,
      groupId: null,
    });
    const fetchMock = vi.fn(
      async (_input: unknown, _init?: RequestInit) => new Response("{}", { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    renameAskThread("t1", "Capital of France");

    const patch = fetchMock.mock.calls.find(
      (call) =>
        String(call[0]) === "/api/ask/threads/t1" &&
        (call[1] as RequestInit | undefined)?.method === "PATCH",
    );
    expect(patch).toBeTruthy();
    const init = patch?.[1] as RequestInit | undefined;
    expect(JSON.parse(String(init?.body))).toEqual({ title: "Capital of France" });
  });

  it("never throws when the PATCH fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("offline");
      }),
    );

    expect(() => renameAskThread("t1", "Capital of France")).not.toThrow();
    await Promise.resolve();
    expect(warn).toHaveBeenCalled();
  });

  it("an empty title is ignored", () => {
    const fetchMock = vi.fn(async (..._args: unknown[]) => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    renameAskThread("t1", "   ");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The whole path — the stream renames the thread
// ---------------------------------------------------------------------------

describe("a streamed title frame renames the thread", () => {
  it("the desktop header shows the LLM title, not the question", async () => {
    const fetchMock = mockAskFetch(STREAM);
    render(<AskView />);

    await act(async () => {
      fireEvent.change(screen.getByTestId("ask-query"), {
        target: { value: "what is the capital of France?" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ask-submit"));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId("ask-answer")).toBeInTheDocument());

    // The header carries the LLM title.
    await waitFor(() =>
      expect(screen.getByTestId("ask-header-title")).toHaveTextContent("Capital of France"),
    );
    expect(screen.getByTestId("ask-header-title")).not.toHaveTextContent(
      "what is the capital of France?",
    );

    // The rename was persisted, once.
    expect(patchCalls(fetchMock)).toHaveLength(1);
  });

  it("the mobile header shows the same title", async () => {
    mockAskFetch(STREAM);
    render(<MobileAskView />);

    await act(async () => {
      fireEvent.change(screen.getByTestId("ask-query"), {
        target: { value: "what is the capital of France?" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ask-submit"));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId("ask-answer")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByTestId("ask-header-title")).toHaveTextContent("Capital of France"),
    );
  });

  it("a stream with no title frame keeps the question as the title", async () => {
    const noTitle = STREAM.filter((frame) => frame.type !== "title");
    mockAskFetch(noTitle);
    render(<AskView />);

    await act(async () => {
      fireEvent.change(screen.getByTestId("ask-query"), {
        target: { value: "what is the capital of France?" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ask-submit"));
      await Promise.resolve();
    });

    await waitFor(() => expect(screen.getByTestId("ask-answer")).toBeInTheDocument());
    await waitFor(() =>
      expect(screen.getByTestId("ask-header-title")).toHaveTextContent(
        "what is the capital of France?",
      ),
    );
  });
});

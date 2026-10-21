import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

import {
  ASK_ORPHANED_KEY,
  ASK_THREADS_KEY,
  getAskListMode,
  loadAskThread,
  loadAskThreads,
  migrateAskThreads,
  setActiveAskThreadId,
  setAskListMode,
  subscribeAskHistoryRequest,
  type AskFrame,
} from "@/lib/ask";
import { AskThreadList } from "@/components/ask/AskThreadList";
import { SessionsPanel } from "@/components/SessionsPanel";
import { AskView } from "@/views/AskView";
import { AskView as MobileAskView } from "@/mobile/AskView";

/**
 * The Ask threads live on the server now (job 150).
 *
 * The Ask history used to live in the browser's `localStorage`, and there
 * was no way to start a new ask once a thread was open — every query landed
 * in the same thread forever. These tests cover the server-backed store,
 * the one-time migration of the old key, the "New ask" button and the
 * history shortcut.
 */

const FRAMES: AskFrame[] = [
  { type: "init" },
  { type: "phase", data: { phase: "researching" } },
  {
    type: "step",
    data: { kind: "searching", queries: ["capital of France"] },
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

// ---------------------------------------------------------------------------
// A tiny in-memory gateway
// ---------------------------------------------------------------------------

interface StoredTurn {
  id: string;
  query: string;
  answer: string;
  mode: string;
  sources: string[];
  sourcesList: unknown[];
  steps: unknown[];
  createdAt: number;
}

interface StoredThread {
  title: string;
  turns: StoredTurn[];
  /** When the thread was last touched — the list is newest first. */
  updatedAt: number;
}

interface Gateway {
  threads: Map<string, StoredThread>;
  posts: Array<Record<string, unknown>>;
  deletes: string[];
  fetchMock: ReturnType<typeof vi.fn>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function ndjson(frames: AskFrame[]): Response {
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
 * A stand-in for the gateway's Ask thread endpoints.
 *
 * It behaves like the real ones: the list ships no turn bodies, a thread
 * that is unknown is a 404, and a finished stream records the turn under
 * the thread and turn ids the request carried.
 */
function installGateway(): Gateway {
  const gateway: Gateway = {
    threads: new Map(),
    posts: [],
    deletes: [],
    fetchMock: vi.fn(),
  };

  gateway.fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url === "/api/ask/threads" && method === "GET") {
      return json({
        threads: Array.from(gateway.threads.entries()).map(([id, thread]) => ({
          id,
          title: thread.title,
          createdAt: 1,
          updatedAt: thread.updatedAt,
          turnCount: thread.turns.length,
        })),
      });
    }

    if (url === "/api/ask/threads" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      gateway.posts.push(body);
      const turns = (body.turns ?? []) as StoredTurn[];
      gateway.threads.set(String(body.id), {
        title: String(body.title ?? ""),
        turns,
        updatedAt: gateway.threads.size + 1,
      });
      return json(
        {
          thread: {
            id: body.id,
            title: body.title,
            createdAt: 1,
            updatedAt: 2,
            turnCount: turns.length,
          },
        },
        201,
      );
    }

    if (url.startsWith("/api/ask/threads/") && method === "GET") {
      const id = decodeURIComponent(url.slice("/api/ask/threads/".length));
      const thread = gateway.threads.get(id);
      if (!thread) return json({ error: "not found", code: "not_found" }, 404);
      return json({
        thread: {
          id,
          title: thread.title,
          createdAt: 1,
          updatedAt: 2,
          turnCount: thread.turns.length,
        },
        turns: thread.turns,
      });
    }

    if (url.startsWith("/api/ask/threads/") && method === "DELETE") {
      const id = decodeURIComponent(url.slice("/api/ask/threads/".length));
      gateway.deletes.push(id);
      if (!gateway.threads.has(id)) {
        return json({ error: "not found", code: "not_found" }, 404);
      }
      gateway.threads.delete(id);
      return json({ ok: true });
    }

    if (url === "/api/ask" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const threadId = String(body.thread_id ?? "");
      const thread = gateway.threads.get(threadId) ?? {
        title: String(body.query ?? ""),
        turns: [],
        updatedAt: gateway.threads.size + 1,
      };
      thread.turns.push({
        id: String(body.turn_id ?? ""),
        query: String(body.query ?? ""),
        answer: "Paris is the capital of France",
        mode: String(body.mode ?? "speed"),
        sources: body.sources ?? ["web"],
        sourcesList: [
          {
            idx: 1,
            title: "Paris - Wikipedia",
            url: "https://en.wikipedia.org/wiki/Paris",
            domain: "en.wikipedia.org",
          },
        ],
        steps: [{ kind: "searching", queries: [body.query] }],
        createdAt: 1,
      });
      gateway.threads.set(threadId, thread);
      return ndjson(FRAMES);
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  vi.stubGlobal("fetch", gateway.fetchMock);
  return gateway;
}

/** A thread already on the server. */
function seedThread(gateway: Gateway, id: string, title: string): void {
  gateway.threads.set(id, {
    title,
    updatedAt: gateway.threads.size + 1,
    turns: [
      {
        id: `${id}-turn-1`,
        query: title,
        answer: "Paris is the capital of France[1].",
        mode: "speed",
        sources: ["web"],
        sourcesList: [
          {
            idx: 1,
            title: "Paris - Wikipedia",
            url: "https://en.wikipedia.org/wiki/Paris",
            domain: "en.wikipedia.org",
          },
        ],
        steps: [{ kind: "searching", queries: [title] }],
        createdAt: 1,
      },
    ],
  });
}

/** Type a question and wait for the answer. */
async function askAQuestion(text: string): Promise<void> {
  await act(async () => {
    fireEvent.change(screen.getByTestId("ask-query"), { target: { value: text } });
  });
  await act(async () => {
    fireEvent.click(screen.getByTestId("ask-submit"));
    await Promise.resolve();
  });
  await waitFor(() => expect(screen.getByTestId("ask-answer")).toBeInTheDocument());
}

beforeEach(() => {
  localStorage.clear();
  setActiveAskThreadId(null);
  setAskListMode("chats");
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// The store — the server is the source of truth
// ---------------------------------------------------------------------------

describe("The Ask thread store", () => {
  it("reads the thread list from the API, not from localStorage", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    const threads = await loadAskThreads();

    expect(threads.map((thread) => thread.id)).toEqual(["t1"]);
    expect(threads[0].title).toBe("Capital of France?");
    expect(threads[0].turnCount).toBe(1);
    // The list ships no turn bodies — that is what the detail call is for.
    expect(threads[0].turns).toEqual([]);
    // The gateway was asked, the browser's storage was not.
    expect(gateway.fetchMock).toHaveBeenCalledWith(
      "/api/ask/threads",
      expect.objectContaining({ headers: expect.any(Object) }),
    );
    expect(localStorage.getItem(ASK_THREADS_KEY)).toBeNull();
  });

  it("the history list shows the server's threads", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");
    seedThread(gateway, "t2", "Best budget laptops?");

    render(<AskThreadList onOpenThread={() => {}} />);

    await waitFor(() => expect(screen.getByTestId("ask-thread-item")).toBeInTheDocument());
    const rows = screen.getAllByTestId("ask-thread-item");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveAttribute("data-thread-id", "t2");
    expect(screen.getByText("Best budget laptops?")).toBeInTheDocument();
  });

  it("a thread's turns come back with its sources and its steps", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    const thread = await loadAskThread("t1");

    expect(thread?.turns).toHaveLength(1);
    expect(thread?.turns[0].answer).toBe("Paris is the capital of France[1].");
    expect(thread?.turns[0].sourcesList).toHaveLength(1);
    expect(thread?.turns[0].steps).toHaveLength(1);
  });

  it("an unknown thread is not an error — there is simply nothing to show", async () => {
    installGateway();
    await expect(loadAskThread("nope")).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The one-time migration of the browser's history
// ---------------------------------------------------------------------------

describe("The one-time migration", () => {
  it("carries the browser's threads over and then removes the key", async () => {
    const gateway = installGateway();
    localStorage.setItem(
      ASK_THREADS_KEY,
      JSON.stringify([
        {
          id: "old-1",
          title: "First question",
          createdAt: 1,
          updatedAt: 1,
          turns: [
            {
              id: "turn-1",
              query: "First question",
              answer: "the old answer",
              mode: "speed",
              sources: ["web"],
              sourcesList: [],
              steps: [],
              createdAt: 1,
            },
          ],
        },
      ]),
    );

    await migrateAskThreads();

    // The thread was POSTed to the server...
    expect(gateway.posts).toHaveLength(1);
    expect(gateway.posts[0].id).toBe("old-1");
    expect(gateway.posts[0].turns).toHaveLength(1);
    // ...and the browser's copy is gone.
    expect(localStorage.getItem(ASK_THREADS_KEY)).toBeNull();
  });

  it("does not run twice", async () => {
    const gateway = installGateway();
    localStorage.setItem(
      ASK_THREADS_KEY,
      JSON.stringify([
        {
          id: "old-1",
          title: "First question",
          createdAt: 1,
          updatedAt: 1,
          turns: [
            {
              id: "turn-1",
              query: "First question",
              answer: "the old answer",
              mode: "speed",
              sources: ["web"],
              sourcesList: [],
              steps: [],
              createdAt: 1,
            },
          ],
        },
      ]),
    );

    await migrateAskThreads();
    await migrateAskThreads();

    expect(gateway.posts).toHaveLength(1);
  });

  it("keeps the history when the server refuses it", async () => {
    const gateway = installGateway();
    gateway.fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
      const method = (init?.method ?? "GET").toUpperCase();
      if (String(input) === "/api/ask/threads" && method === "GET") {
        return json({ threads: [] });
      }
      // The save fails: the history must survive it.
      return json({ error: "nope", code: "nope" }, 500);
    });
    vi.stubGlobal("fetch", gateway.fetchMock);

    localStorage.setItem(
      ASK_THREADS_KEY,
      JSON.stringify([
        {
          id: "old-1",
          title: "First question",
          createdAt: 1,
          updatedAt: 1,
          turns: [
            {
              id: "turn-1",
              query: "First question",
              answer: "the old answer",
              mode: "speed",
              sources: ["web"],
              sourcesList: [],
              steps: [],
              createdAt: 1,
            },
          ],
        },
      ]),
    );

    await migrateAskThreads();

    // The history is still there: a failed migration must not lose it.
    expect(localStorage.getItem(ASK_THREADS_KEY)).not.toBeNull();
  });

  it("never deletes a payload it could not read — it parks it", async () => {
    const gateway = installGateway();
    // A shape this build does not understand: threads with no readable turns.
    const unknown = JSON.stringify([{ id: "old-1", turns: [{ nope: true }] }]);
    localStorage.setItem(ASK_THREADS_KEY, unknown);

    await migrateAskThreads();

    // Nothing was posted (there was nothing readable)...
    expect(gateway.posts).toHaveLength(0);
    // ...and the payload was NOT destroyed: it is parked, and the original
    // key keeps its copy so a later build can still read it.
    expect(localStorage.getItem(ASK_ORPHANED_KEY)).toBe(unknown);
    expect(localStorage.getItem(ASK_THREADS_KEY)).toBe(unknown);
  });

  it("removes a key that holds an empty history", async () => {
    installGateway();
    localStorage.setItem(ASK_THREADS_KEY, "[]");

    await migrateAskThreads();

    expect(localStorage.getItem(ASK_THREADS_KEY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The New ask button — the dead end that is being fixed
// ---------------------------------------------------------------------------

describe("The New ask button", () => {
  it("appears only once a thread is loaded", async () => {
    const gateway = installGateway();
    void gateway;

    render(<AskView />);

    // Nothing is open: typing creates a thread, so there is no button.
    expect(screen.queryByTestId("ask-new-thread")).toBeNull();

    await askAQuestion("What is the capital of France?");

    expect(screen.getByTestId("ask-new-thread")).toBeInTheDocument();
  });

  it("starts a FRESH thread — the old one stays in the history", async () => {
    const gateway = installGateway();

    render(<AskView />);
    await askAQuestion("What is the capital of France?");

    const firstThread = Array.from(gateway.threads.keys())[0];
    expect(gateway.threads.size).toBe(1);

    // The escape hatch: the plus button empties the canvas.
    fireEvent.click(screen.getByTestId("ask-new-thread"));
    await waitFor(() => expect(screen.getByTestId("ask-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("ask-new-thread")).toBeNull();

    // The next question opens a NEW thread.
    await askAQuestion("And its population?");

    expect(gateway.threads.size).toBe(2);
    expect(Array.from(gateway.threads.keys())).toContain(firstThread);
  });

  it("an opened thread shows the plus button, so the user can get out", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    render(<AskView />);
    act(() => {
      setActiveAskThreadId("t1");
    });

    await waitFor(() => expect(screen.getByTestId("ask-answer")).toBeInTheDocument());
    expect(screen.getByTestId("ask-new-thread")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Opening a thread restores it
// ---------------------------------------------------------------------------

describe("Opening a thread", () => {
  it("restores the turns, the sources and the research steps", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    render(<AskView />);
    act(() => {
      setActiveAskThreadId("t1");
    });

    await waitFor(() => expect(screen.getByTestId("ask-answer")).toBeInTheDocument());
    expect(screen.getByTestId("ask-answer")).toHaveTextContent(
      "Paris is the capital of France",
    );
    // The citation and its source came back with the turn.
    expect(screen.getByTestId("ask-citation-1")).toHaveAttribute(
      "href",
      "https://en.wikipedia.org/wiki/Paris",
    );
    expect(screen.getByTestId("ask-source-1")).toHaveTextContent("Paris - Wikipedia");
    // The research timeline came back too.
    expect(screen.getByTestId("ask-steps")).toBeInTheDocument();
  });

  it("a follow-up carries the thread's history", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    render(<AskView />);
    act(() => {
      setActiveAskThreadId("t1");
    });
    await waitFor(() => expect(screen.getByTestId("ask-answer")).toBeInTheDocument());

    await act(async () => {
      fireEvent.change(screen.getByTestId("ask-query"), {
        target: { value: "And its population?" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ask-submit"));
      await Promise.resolve();
    });

    const call = gateway.fetchMock.mock.calls.find(
      (entry: unknown[]) => String(entry[0]) === "/api/ask",
    );
    const body = JSON.parse(String((call?.[1] as RequestInit)?.body ?? "{}"));
    expect(body.thread_id).toBe("t1");
    expect(body.history).toEqual([
      ["human", "Capital of France?"],
      ["assistant", "Paris is the capital of France[1]."],
    ]);
  });
});

// ---------------------------------------------------------------------------
// The history shortcut
// ---------------------------------------------------------------------------

describe("The history shortcut", () => {
  it("is an icon button with an accessible name, on a cold Ask tab", () => {
    installGateway();

    render(<AskView />);

    const button = screen.getByTestId("ask-history");
    expect(button).toBeInTheDocument();
    expect(button).toHaveAttribute("aria-label", "Ask history");
    expect(button).toHaveAttribute("title", "Ask history");
    // A lucide icon, not a glyph.
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.textContent).toBe("");
  });

  it("selects the Asks list of the Sessions surface", async () => {
    installGateway();

    render(<AskView />);
    expect(getAskListMode()).toBe("chats");

    fireEvent.click(screen.getByTestId("ask-history"));

    expect(getAskListMode()).toBe("asks");
  });

  it("the Sessions surface shows the Ask threads when the shortcut fired", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    render(<AskView />);
    fireEvent.click(screen.getByTestId("ask-history"));

    render(<SessionsPanel chats={<div>the chats</div>} onOpenAsk={() => {}} />);

    await waitFor(() => expect(screen.getByTestId("ask-thread-item")).toBeInTheDocument());
    expect(screen.getByText("Capital of France?")).toBeInTheDocument();
  });

  it("raises the request the shell answers", () => {
    installGateway();
    const heard: number[] = [];
    const unsubscribe = subscribeAskHistoryRequest(() => heard.push(heard.length));

    render(<AskView />);
    fireEvent.click(screen.getByTestId("ask-history"));

    expect(heard).toHaveLength(1);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

describe("Deleting a thread", () => {
  it("asks first, then deletes it on the server", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);

    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-thread-forget")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-thread-forget"));

    await waitFor(() => expect(gateway.deletes).toEqual(["t1"]));
    expect(confirm).toHaveBeenCalled();
    // The row is gone.
    await waitFor(() => expect(screen.queryByTestId("ask-thread-item")).toBeNull());
  });

  it("a cancelled confirmation deletes nothing", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);

    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-thread-forget")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-thread-forget"));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(gateway.deletes).toEqual([]);
    expect(screen.getByTestId("ask-thread-item")).toBeInTheDocument();
  });

  it("clears the canvas when the open thread is the one deleted", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");
    vi.stubGlobal("confirm", vi.fn(() => true));

    render(<AskView />);
    act(() => {
      setActiveAskThreadId("t1");
    });
    await waitFor(() => expect(screen.getByTestId("ask-answer")).toBeInTheDocument());

    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-thread-forget")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("ask-thread-forget"));

    await waitFor(() => expect(gateway.deletes).toEqual(["t1"]));
    // The canvas empties — the thread it was showing is gone.
    await waitFor(() => expect(screen.getByTestId("ask-empty")).toBeInTheDocument());
  });
});

// ---------------------------------------------------------------------------
// Parity — the two shells render the SAME components
// ---------------------------------------------------------------------------

describe("Desktop and mobile parity", () => {
  it("both canvases carry the same header controls", () => {
    installGateway();

    const desktop = render(<AskView />);
    expect(screen.getByTestId("ask-header")).toBeInTheDocument();
    expect(screen.getByTestId("ask-history")).toBeInTheDocument();
    expect(screen.queryByTestId("ask-new-thread")).toBeNull();
    desktop.unmount();

    render(<MobileAskView />);
    expect(screen.getByTestId("ask-header")).toBeInTheDocument();
    expect(screen.getByTestId("ask-history")).toBeInTheDocument();
    expect(screen.queryByTestId("ask-new-thread")).toBeNull();
  });

  it("both canvases show the plus button once a thread is open", async () => {
    installGateway();

    const desktop = render(<AskView />);
    await askAQuestion("What is the capital of France?");
    expect(screen.getByTestId("ask-new-thread")).toBeInTheDocument();
    desktop.unmount();

    // The active-thread pointer is module level, so the second shell starts
    // on a clean slate — only one shell runs at a time in production.
    act(() => setActiveAskThreadId(null));

    render(<MobileAskView />);
    await askAQuestion("What is the capital of France?");
    expect(screen.getByTestId("ask-new-thread")).toBeInTheDocument();
  });
});

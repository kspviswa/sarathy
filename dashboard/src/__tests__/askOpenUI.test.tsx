/**
 * Spec 155 Phase A — the Ask answer renders an `openui-lang` fence as a live
 * widget through the SAME adapter Chat uses, and a widget button starts the
 * next Ask turn.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AskAnswer } from "@/components/ask/AskAnswer";
import { AskSurface } from "@/components/ask/AskSurface";
import type { AskFrame, AskSource } from "@/lib/ask";

const FENCE = (body: string) => ["```openui-lang", body, "```"].join("\n");

const WIDGET = FENCE(
  [
    "root = Stack([title])",
    'title = TextContent("Deploy status")',
  ].join("\n"),
);

const SOURCE: AskSource = {
  idx: 1,
  title: "Paris - Wikipedia",
  url: "https://en.wikipedia.org/wiki/Paris",
  domain: "en.wikipedia.org",
};

describe("AskAnswer openUI rendering", () => {
  it("plain answers render exactly one markdown mount and no widget", () => {
    render(<AskAnswer answer="Paris is the capital of France." sources={[]} />);

    expect(screen.getAllByTestId("ask-answer-markdown")).toHaveLength(1);
    expect(screen.queryByTestId("ask-answer-block")).not.toBeInTheDocument();
    expect(screen.getByText("Paris is the capital of France.")).toBeInTheDocument();
  });

  it("renders an openui-lang fence as a widget, not as DSL prose", async () => {
    render(<AskAnswer answer={`Before the block.\n\n${WIDGET}`} sources={[]} />);

    expect(await screen.findByTestId("ask-answer-block", {}, { timeout: 10_000 })).toBeInTheDocument();
    expect(await screen.findByText("Deploy status", {}, { timeout: 10_000 })).toBeInTheDocument();

    const prose = screen.getByTestId("ask-answer-markdown");
    expect(prose).toHaveTextContent("Before the block.");
    expect(prose.textContent).not.toContain("root = Stack");
    expect(screen.queryByTestId("ui-block-raw")).not.toBeInTheDocument();
  });

  it("keeps citation pills in the prose chunk before a widget", async () => {
    const answer = `Paris is the capital.[1]\n\n${WIDGET}`;
    render(<AskAnswer answer={answer} sources={[SOURCE]} />);

    const pill = screen.getByTestId("ask-citation-1");
    expect(pill).toHaveAttribute("href", "https://en.wikipedia.org/wiki/Paris");

    // The marker inside the widget body was never rewritten into a pill.
    expect(screen.queryByTestId("ask-citation-2")).not.toBeInTheDocument();
    expect(await screen.findByTestId("ask-answer-block", {}, { timeout: 10_000 })).toBeInTheDocument();
  });

  it("still renders an ordinary fenced code block through CodeBlock", () => {
    render(
      <AskAnswer
        answer={["Run this:", "", "```python", "print('hi')", "```"].join("\n")}
        sources={[]}
      />,
    );

    expect(screen.queryByTestId("ask-answer-block")).not.toBeInTheDocument();
    expect(screen.getByText("print('hi')").closest("pre")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Widget button → follow-up Ask turn (the real submit path)
// ---------------------------------------------------------------------------

const BUTTON_WIDGET = FENCE(
  [
    "root = Stack([btn])",
    'btn = Button("Tell me more", @ToAssistant("Tell me more about Paris"))',
  ].join("\n"),
);

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

function mockAskFetch(frames: AskFrame[]) {
  const fetchMock = vi.fn(async (input: unknown, _init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("/api/ask/threads")) {
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

function askCalls(fetchMock: ReturnType<typeof mockAskFetch>) {
  return fetchMock.mock.calls.filter((call) => String(call[0]) === "/api/ask");
}

const FRAMES: AskFrame[] = [
  { type: "init" },
  {
    type: "response",
    data: `Paris is the capital.\n\n${BUTTON_WIDGET}`,
  },
  { type: "done" },
];

beforeEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Ask widget actions", () => {
  it("a widget button submits its message as the next Ask turn", async () => {
    const fetchMock = mockAskFetch(FRAMES);
    render(<AskSurface />);

    await act(async () => {
      fireEvent.change(screen.getByTestId("ask-query"), {
        target: { value: "What is the capital of France?" },
      });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("ask-submit"));
      await Promise.resolve();
    });
    await waitFor(() => expect(askCalls(fetchMock)).toHaveLength(1));
    await waitFor(() => expect(screen.getByTestId("ask-answer")).toBeInTheDocument());

    const button = await screen.findByRole(
      "button",
      { name: /tell me more/i },
      { timeout: 10_000 },
    );

    fireEvent.click(button);

    await waitFor(() => expect(askCalls(fetchMock)).toHaveLength(2));
    const body = JSON.parse(String(askCalls(fetchMock)[1][1]?.body ?? "{}"));
    expect(body.query).toBe("Tell me more about Paris");
  }, 20_000);
});

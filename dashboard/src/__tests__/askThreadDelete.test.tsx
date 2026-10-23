import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

import { AskThreadList } from "@/components/ask/AskThreadList";
import { useCoarsePointer } from "@/lib/useCoarsePointer";
import { setActiveAskThreadId, getActiveAskThreadId, setAskListMode } from "@/lib/ask";

/**
 * Job 158 — deleting an Ask history entry.
 *
 * The trash button used to be `opacity-0` until hover, so it was invisible
 * on a touch device and easy to miss on a desktop. It is now always visible,
 * a left swipe reveals the same action on a coarse pointer, and BOTH paths
 * pass through one confirmation dialog.
 *
 * The coarse-pointer hook is mocked rather than faking `matchMedia`: the
 * component asks the hook, so mocking the hook is what actually switches the
 * two behaviours the spec describes.
 */

vi.mock("@/lib/useCoarsePointer", () => ({ useCoarsePointer: vi.fn(() => false) }));

const mockedCoarse = vi.mocked(useCoarsePointer);

// ---------------------------------------------------------------------------
// A tiny gateway — only what this list touches
// ---------------------------------------------------------------------------

interface Gateway {
  threads: Map<string, string>;
  deletes: string[];
  fetchMock: ReturnType<typeof vi.fn>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installGateway(): Gateway {
  const gateway: Gateway = { threads: new Map(), deletes: [], fetchMock: vi.fn() };

  gateway.fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url === "/api/ask/threads" && method === "GET") {
      return json({
        threads: Array.from(gateway.threads.entries()).map(([id, title], index) => ({
          id,
          title,
          createdAt: 1,
          updatedAt: index + 1,
          turnCount: 1,
        })),
      });
    }

    if (url === "/api/ask/groups" && method === "GET") {
      return json({ groups: [] });
    }

    if (url.startsWith("/api/ask/threads/") && method === "DELETE") {
      const id = decodeURIComponent(url.slice("/api/ask/threads/".length));
      gateway.deletes.push(id);
      gateway.threads.delete(id);
      return json({ ok: true });
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  vi.stubGlobal("fetch", gateway.fetchMock);
  return gateway;
}

function seedThread(gateway: Gateway, id: string, title: string): void {
  gateway.threads.set(id, title);
}

/** Render the list with the pointer type the test wants. */
function renderList(coarse: boolean) {
  mockedCoarse.mockReturnValue(coarse);
  return render(<AskThreadList onOpenThread={() => {}} />);
}

/** A left swipe on the row, past the open threshold. */
function swipeLeft(row: HTMLElement, distance = 60): void {
  fireEvent.pointerDown(row, { clientX: 220, clientY: 120 });
  fireEvent.pointerMove(row, { clientX: 220 - distance / 2, clientY: 120 });
  fireEvent.pointerMove(row, { clientX: 220 - distance, clientY: 120 });
  fireEvent.pointerUp(row, { clientX: 220 - distance, clientY: 120 });
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  setActiveAskThreadId(null);
  setAskListMode("chats");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Ask thread delete — desktop (fine pointer)", () => {
  it("shows the delete control without hover, and it is not opacity-0", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    renderList(false);
    await waitFor(() => expect(screen.getByTestId("ask-thread-forget")).toBeInTheDocument());

    const button = screen.getByTestId("ask-thread-forget");
    // The old control was `opacity-0 … group-hover:opacity-100`.
    expect(button.className).not.toMatch(/opacity-0/);
    expect(button.className).not.toMatch(/group-hover:opacity-100/);
    // It is still the same testid the other suites and automation use.
    expect(button).toHaveAttribute("aria-label", 'Delete "Capital of France?"');
  });

  it("asks before deleting: Cancel is a true no-op", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    renderList(false);
    await waitFor(() => expect(screen.getByTestId("ask-thread-forget")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-thread-forget"));
    await waitFor(() => expect(screen.getByTestId("ask-thread-delete-dialog")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-thread-delete-cancel"));

    await waitFor(() => expect(screen.queryByTestId("ask-thread-delete-dialog")).toBeNull());
    expect(gateway.deletes).toEqual([]);
    expect(screen.getByTestId("ask-thread-item")).toHaveAttribute("data-thread-id", "t1");
  });

  it("confirming deletes that thread and the row disappears", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    renderList(false);
    await waitFor(() => expect(screen.getByTestId("ask-thread-forget")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-thread-forget"));
    await waitFor(() => expect(screen.getByTestId("ask-thread-delete-confirm")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("ask-thread-delete-confirm"));

    await waitFor(() => expect(gateway.deletes).toEqual(["t1"]));
    await waitFor(() => expect(screen.queryByTestId("ask-thread-item")).toBeNull());
  });

  it("clears the active thread when the deleted one is the open one", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    renderList(false);
    await waitFor(() => expect(screen.getByTestId("ask-thread-forget")).toBeInTheDocument());

    act(() => setActiveAskThreadId("t1"));
    expect(getActiveAskThreadId()).toBe("t1");

    fireEvent.click(screen.getByTestId("ask-thread-forget"));
    await waitFor(() => expect(screen.getByTestId("ask-thread-delete-confirm")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("ask-thread-delete-confirm"));

    await waitFor(() => expect(gateway.deletes).toEqual(["t1"]));
    expect(getActiveAskThreadId()).toBeNull();
  });

  it("is inert on a fine pointer: no swipe action is mounted", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    renderList(false);
    await waitFor(() => expect(screen.getByTestId("ask-thread-item")).toBeInTheDocument());

    swipeLeft(screen.getByTestId("ask-thread-item"));

    expect(screen.queryByTestId("ask-thread-swipe-delete")).toBeNull();
  });
});

describe("Ask thread delete — touch (coarse pointer)", () => {
  it("a left swipe past the threshold reveals the Delete action", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    renderList(true);
    await waitFor(() => expect(screen.getByTestId("ask-thread-item")).toBeInTheDocument());

    expect(screen.getByTestId("ask-thread-swipe-delete")).toBeInTheDocument();
    swipeLeft(screen.getByTestId("ask-thread-item"));

    const row = screen.getByTestId("ask-thread-item").closest("li")!;
    expect(row).toHaveAttribute("data-swipe-open", "true");
  });

  it("a vertical drag is ignored, so the list still scrolls", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    renderList(true);
    await waitFor(() => expect(screen.getByTestId("ask-thread-item")).toBeInTheDocument());

    const row = screen.getByTestId("ask-thread-item");
    fireEvent.pointerDown(row, { clientX: 220, clientY: 100 });
    fireEvent.pointerMove(row, { clientX: 214, clientY: 200 });
    fireEvent.pointerUp(row, { clientX: 214, clientY: 200 });

    expect(screen.getByTestId("ask-thread-item").closest("li")).not.toHaveAttribute(
      "data-swipe-open",
      "true",
    );
  });

  it("a short swipe snaps back instead of opening", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    renderList(true);
    await waitFor(() => expect(screen.getByTestId("ask-thread-item")).toBeInTheDocument());

    swipeLeft(screen.getByTestId("ask-thread-item"), 20);

    expect(screen.getByTestId("ask-thread-item").closest("li")).not.toHaveAttribute(
      "data-swipe-open",
      "true",
    );
  });

  it("only one row is open at a time", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");
    seedThread(gateway, "t2", "Best budget laptops?");

    renderList(true);
    await waitFor(() => expect(screen.getAllByTestId("ask-thread-item")).toHaveLength(2));

    const [first, second] = screen.getAllByTestId("ask-thread-item");

    swipeLeft(first);
    expect(first.closest("li")).toHaveAttribute("data-swipe-open", "true");

    swipeLeft(second);
    expect(second.closest("li")).toHaveAttribute("data-swipe-open", "true");
    expect(first.closest("li")).not.toHaveAttribute("data-swipe-open", "true");
  });

  it("tapping the body of an open row closes it instead of opening the thread", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");
    const onOpenThread = vi.fn();

    mockedCoarse.mockReturnValue(true);
    render(<AskThreadList onOpenThread={onOpenThread} />);
    await waitFor(() => expect(screen.getByTestId("ask-thread-item")).toBeInTheDocument());

    const row = screen.getByTestId("ask-thread-item");
    swipeLeft(row);
    expect(row.closest("li")).toHaveAttribute("data-swipe-open", "true");

    fireEvent.click(row);

    expect(onOpenThread).not.toHaveBeenCalled();
    expect(row.closest("li")).not.toHaveAttribute("data-swipe-open", "true");
  });

  it("confirming a swipe-delete deletes that thread", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    renderList(true);
    await waitFor(() => expect(screen.getByTestId("ask-thread-item")).toBeInTheDocument());

    swipeLeft(screen.getByTestId("ask-thread-item"));
    fireEvent.click(screen.getByTestId("ask-thread-swipe-delete"));

    // The swipe action confirms through the SAME dialog as the button.
    await waitFor(() => expect(screen.getByTestId("ask-thread-delete-confirm")).toBeInTheDocument());
    expect(gateway.deletes).toEqual([]);

    fireEvent.click(screen.getByTestId("ask-thread-delete-confirm"));

    await waitFor(() => expect(gateway.deletes).toEqual(["t1"]));
    await waitFor(() => expect(screen.queryByTestId("ask-thread-item")).toBeNull());
  });
});

describe("Ask thread delete — empty state", () => {
  it("shows the empty message once the last thread is deleted, without throwing", async () => {
    const gateway = installGateway();
    seedThread(gateway, "t1", "Capital of France?");

    renderList(false);
    await waitFor(() => expect(screen.getByTestId("ask-thread-forget")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-thread-forget"));
    await waitFor(() => expect(screen.getByTestId("ask-thread-delete-confirm")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("ask-thread-delete-confirm"));

    await waitFor(() => expect(gateway.deletes).toEqual(["t1"]));
    await waitFor(() => expect(screen.getByTestId("ask-threads-empty")).toBeInTheDocument());
    expect(screen.queryByTestId("ask-thread-delete-dialog")).toBeNull();
  });
});

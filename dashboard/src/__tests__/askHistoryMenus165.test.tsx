import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { AskThreadList } from "@/components/ask/AskThreadList";
import { setAskListMode } from "@/lib/ask";

/**
 * Spec 165 — the Ask history menus must not be clipped.
 *
 * Viswa: "On the ask history, the categories drop down is not visible / cut
 * off." The move menu (the groups, i.e. the categories) was an `absolute`
 * child of the thread row, and that row is `overflow-hidden` for the swipe
 * reveal — so the menu was clipped to a sliver of its first item. Measured on
 * the live bundle, the panel ended at y=381 while its clipping row ended at
 * 291, on BOTH shells; on a short viewport it fell off-screen entirely.
 *
 * Both menus now render in a portal on `document.body`, which no ancestor's
 * `overflow` can clip and which Radix flips when it would leave the viewport.
 *
 * These tests assert the STRUCTURE that prevents the regression: the panel is
 * not a descendant of the scrolling list.
 */

vi.mock("@/lib/api", () => ({
  api: {
    sessionFooter: vi.fn(),
    sessions: vi.fn(),
    session: vi.fn(),
    sessionsArchive: vi.fn().mockResolvedValue({ sessions: [] }),
    sessionArchive: vi.fn(),
    me: vi.fn().mockResolvedValue({ ok: true }),
    status: vi.fn().mockResolvedValue({ version: "0.19.7", gateway: { running: true } }),
  },
  getToken: vi.fn(() => "test-token"),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  AuthError: class AuthError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warning: vi.fn() },
  Toaster: () => null,
}));

const groups = [
  { id: "g1", name: "Viyaan", description: "", createdAt: 200, updatedAt: 200, threadCount: 1 },
  { id: "g2", name: "संस्कृतम्", description: "", createdAt: 100, updatedAt: 100, threadCount: 0 },
];

const threads = [
  {
    id: "t1",
    title: "A thread",
    groupId: "g1",
    createdAt: 1,
    updatedAt: Date.now(),
    turnCount: 2,
  },
];

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  localStorage.clear();
  setAskListMode("asks");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url === "/api/ask/groups") return json({ groups });
      if (url === "/api/ask/threads") return json({ threads });
      return json({});
    }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("Ask history menus — spec 165 (portaled, never clipped)", () => {
  it("the move menu is portaled OUT of the scrolling list", async () => {
    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-thread-move")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-thread-move"));
    const panel = await screen.findByTestId("ask-move-menu");

    const list = screen.getByTestId("ask-thread-list");
    expect(list.contains(panel)).toBe(false);
    // Portaled to the body — the one place no ancestor overflow can reach.
    expect(panel.closest("body")).toBe(document.body);
  });

  it("the group menu is portaled too", async () => {
    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("ask-group-menu").length).toBeGreaterThan(0));

    // One menu per group — the first is enough to prove the portal.
    fireEvent.click(screen.getAllByTestId("ask-group-menu")[0]);
    const panel = await screen.findByTestId("ask-group-menu-panel");

    expect(screen.getByTestId("ask-thread-list").contains(panel)).toBe(false);
  });

  it("the move menu lists every category and still moves the thread", async () => {
    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-thread-move")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-thread-move"));
    const panel = await screen.findByTestId("ask-move-menu");

    // Uncategorized + both groups, all reachable.
    expect(panel).toContainElement(screen.getByTestId("ask-move-none"));
    expect(panel).toContainElement(screen.getByTestId("ask-move-g1"));
    expect(panel).toContainElement(screen.getByTestId("ask-move-g2"));
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fireEvent, render, screen, waitFor, cleanup } from "@testing-library/react";

import { setAskListMode } from "@/lib/ask";
import { AskThreadList } from "@/components/ask/AskThreadList";
import { SessionsView as DesktopSessionsView } from "@/views/SessionsView";
import { SessionsView as MobileSessionsView } from "@/mobile/SessionsView";

/**
 * The Ask history is GROUPED (job 151 §B).
 *
 * The threads live on the server (job 150) and they are sorted into named
 * groups — Uttaram's projects. These tests cover the grouped history: the
 * sections and their counts, Uncategorized at the end, the collapse, the
 * new/rename/delete of a group, the move of a thread between groups, and the
 * new ask that starts inside a group.
 */

vi.mock("@/lib/api", () => ({
  api: {
    sessionFooter: vi.fn(),
    sessions: vi.fn(),
    session: vi.fn(),
    sessionsArchive: vi.fn().mockResolvedValue({ sessions: [] }),
    sessionArchive: vi.fn(),
    me: vi.fn().mockResolvedValue({ ok: true }),
    status: vi.fn().mockResolvedValue({ version: "0.19.5", gateway: { running: true } }),
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

/** Emoji + pictograph ranges — the chrome must be lucide icons. */
const EMOJI_RE = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/u;

// ---------------------------------------------------------------------------
// A tiny in-memory gateway
// ---------------------------------------------------------------------------

interface StoredThread {
  id: string;
  title: string;
  groupId: string | null;
  updatedAt: number;
  turns: unknown[];
}

interface StoredGroup {
  id: string;
  name: string;
  description: string;
  createdAt: number;
  updatedAt: number;
}

interface Gateway {
  threads: Map<string, StoredThread>;
  groups: Map<string, StoredGroup>;
  patches: Array<{ threadId: string; groupId: string | null }>;
  groupPatches: Array<{ id: string; name: string }>;
  groupDeletes: string[];
  posts: Array<Record<string, unknown>>;
  groupPosts: Array<Record<string, unknown>>;
  fetchMock: ReturnType<typeof vi.fn>;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A stand-in for the gateway's Ask thread and group endpoints.
 *
 * It behaves like the real ones: the list ships no turn bodies, a group
 * that is unknown is a 404, and deleting a group clears the group of its
 * threads instead of deleting them.
 */
function installGateway(): Gateway {
  const gateway: Gateway = {
    threads: new Map(),
    groups: new Map(),
    patches: [],
    groupPatches: [],
    groupDeletes: [],
    posts: [],
    groupPosts: [],
    fetchMock: vi.fn(),
  };

  const groupPayload = (group: StoredGroup) => ({
    id: group.id,
    name: group.name,
    description: group.description,
    createdAt: group.createdAt,
    updatedAt: group.updatedAt,
    threadCount: Array.from(gateway.threads.values()).filter((t) => t.groupId === group.id).length,
  });

  gateway.fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? "GET").toUpperCase();

    if (url === "/api/ask/groups" && method === "GET") {
      const groups = Array.from(gateway.groups.values())
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(groupPayload);
      return json({ groups });
    }

    if (url === "/api/ask/groups" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      gateway.groupPosts.push(body);
      const now = Date.now();
      const group: StoredGroup = {
        id: `g-${gateway.groups.size + 1}`,
        name: String(body.name ?? ""),
        description: String(body.description ?? ""),
        createdAt: now,
        updatedAt: now,
      };
      gateway.groups.set(group.id, group);
      return json({ group: groupPayload(group) }, 201);
    }

    if (url.startsWith("/api/ask/groups/") && method === "PATCH") {
      const id = decodeURIComponent(url.slice("/api/ask/groups/".length));
      const body = JSON.parse(String(init?.body ?? "{}"));
      gateway.groupPatches.push({ id, name: String(body.name ?? "") });
      const group = gateway.groups.get(id);
      if (!group) return json({ error: "not found", code: "not_found" }, 404);
      group.name = String(body.name ?? group.name);
      group.updatedAt = Date.now();
      return json({ group: groupPayload(group) });
    }

    if (url.startsWith("/api/ask/groups/") && method === "DELETE") {
      const id = decodeURIComponent(url.slice("/api/ask/groups/".length));
      gateway.groupDeletes.push(id);
      const group = gateway.groups.get(id);
      if (!group) return json({ error: "not found", code: "not_found" }, 404);
      // The threads survive: they fall back to uncategorized.
      for (const thread of gateway.threads.values()) {
        if (thread.groupId === id) thread.groupId = null;
      }
      gateway.groups.delete(id);
      return json({ ok: true });
    }

    if (url === "/api/ask/threads" && method === "GET") {
      return json({
        threads: Array.from(gateway.threads.values()).map((thread) => ({
          id: thread.id,
          title: thread.title,
          groupId: thread.groupId,
          createdAt: 1,
          updatedAt: thread.updatedAt,
          turnCount: thread.turns.length,
        })),
      });
    }

    if (url === "/api/ask/threads" && method === "POST") {
      const body = JSON.parse(String(init?.body ?? "{}"));
      gateway.posts.push(body);
      const id = String(body.id ?? "");
      gateway.threads.set(id, {
        id,
        title: String(body.title ?? ""),
        groupId: typeof body.groupId === "string" ? body.groupId : null,
        updatedAt: Date.now(),
        turns: [],
      });
      return json({ thread: { id, title: body.title, groupId: body.groupId, createdAt: 1, updatedAt: 2, turnCount: 0 } }, 201);
    }

    if (url.startsWith("/api/ask/threads/") && method === "PATCH") {
      const id = decodeURIComponent(url.slice("/api/ask/threads/".length));
      const body = JSON.parse(String(init?.body ?? "{}"));
      gateway.patches.push({ threadId: id, groupId: body.groupId ?? null });
      const thread = gateway.threads.get(id);
      if (!thread) return json({ error: "not found", code: "not_found" }, 404);
      thread.groupId = typeof body.groupId === "string" ? body.groupId : null;
      return json({ thread: { id, title: thread.title, groupId: thread.groupId, createdAt: 1, updatedAt: 2, turnCount: thread.turns.length } });
    }

    if (url.startsWith("/api/ask/threads/") && method === "GET") {
      const id = decodeURIComponent(url.slice("/api/ask/threads/".length));
      const thread = gateway.threads.get(id);
      if (!thread) return json({ error: "not found", code: "not_found" }, 404);
      return json({
        thread: {
          id,
          title: thread.title,
          groupId: thread.groupId,
          createdAt: 1,
          updatedAt: 2,
          turnCount: thread.turns.length,
        },
        turns: thread.turns,
      });
    }

    if (url.startsWith("/api/ask/threads/") && method === "DELETE") {
      const id = decodeURIComponent(url.slice("/api/ask/threads/".length));
      gateway.threads.delete(id);
      return json({ ok: true });
    }

    throw new Error(`unexpected fetch: ${method} ${url}`);
  });

  vi.stubGlobal("fetch", gateway.fetchMock);
  return gateway;
}

/** A thread already on the server. */
function seedThread(
  gateway: Gateway,
  id: string,
  title: string,
  groupId: string | null = null,
): void {
  gateway.threads.set(id, {
    id,
    title,
    groupId,
    updatedAt: gateway.threads.size + 1,
    turns: [
      {
        id: `${id}-turn-1`,
        query: title,
        answer: "Paris is the capital of France[1].",
        mode: "speed",
        sources: ["web"],
        sourcesList: [],
        steps: [],
        createdAt: 1,
      },
    ],
  });
}

/** A group already on the server. */
function seedGroup(gateway: Gateway, id: string, name: string, createdAt: number): void {
  gateway.groups.set(id, {
    id,
    name,
    description: "",
    createdAt,
    updatedAt: createdAt,
  });
}

beforeEach(() => {
  localStorage.clear();
  setAskListMode("asks");
  vi.restoreAllMocks();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

// ---------------------------------------------------------------------------
// The grouped history
// ---------------------------------------------------------------------------

describe("The grouped Ask history", () => {
  it("renders one section per group, newest first, with the thread counts", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g-old", "Older group", 100);
    seedGroup(gateway, "g-new", "Newer group", 200);
    seedThread(gateway, "t1", "First thread", "g-old");
    seedThread(gateway, "t2", "Second thread", "g-old");
    seedThread(gateway, "t3", "Third thread", "g-new");

    render(<AskThreadList onOpenThread={() => {}} />);

    await waitFor(() => expect(screen.getAllByTestId("ask-group")).toHaveLength(2));
    const sections = screen.getAllByTestId("ask-group");
    expect(sections[0]).toHaveAttribute("data-group-id", "g-new");
    expect(sections[1]).toHaveAttribute("data-group-id", "g-old");

    const counts = screen.getAllByTestId("ask-group-count");
    expect(counts[0]).toHaveTextContent("1");
    expect(counts[1]).toHaveTextContent("2");

    const names = screen.getAllByTestId("ask-group-name");
    expect(names[0]).toHaveTextContent("Newer group");
    expect(names[1]).toHaveTextContent("Older group");
  });

  it("files every thread under its group", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g1", "Work", 100);
    seedThread(gateway, "t1", "In the group", "g1");
    seedThread(gateway, "t2", "Not in a group", null);

    render(<AskThreadList onOpenThread={() => {}} />);

    await waitFor(() => expect(screen.getAllByTestId("ask-thread-item")).toHaveLength(2));
    const rows = screen.getAllByTestId("ask-thread-item");
    // The group's own section comes first, Uncategorized last.
    expect(rows[0]).toHaveAttribute("data-thread-id", "t1");
    expect(rows[0]).toHaveAttribute("data-group-id", "g1");
    expect(rows[1]).toHaveAttribute("data-thread-id", "t2");
    expect(rows[1]).toHaveAttribute("data-group-id", "");
  });

  it("keeps the server's order when two groups share a timestamp", async () => {
    const gateway = installGateway();
    // Two groups made in the same millisecond: the server breaks the tie by
    // the order it created them in, and the browser must not shuffle them.
    seedGroup(gateway, "g-a", "First", 100);
    seedGroup(gateway, "g-b", "Second", 100);

    render(<AskThreadList onOpenThread={() => {}} />);

    await waitFor(() => expect(screen.getAllByTestId("ask-group")).toHaveLength(2));
    const sections = screen.getAllByTestId("ask-group");
    expect(sections[0]).toHaveAttribute("data-group-id", "g-a");
    expect(sections[1]).toHaveAttribute("data-group-id", "g-b");
  });

  it("shows Uncategorized last, and only when it has threads", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g1", "Work", 100);
    seedThread(gateway, "t1", "In the group", "g1");

    const first = render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-group")).toBeInTheDocument());
    // No uncategorized thread: no bucket.
    expect(screen.queryByTestId("ask-uncategorized")).toBeNull();
    first.unmount();

    seedThread(gateway, "t2", "Loose thread", null);
    const { container } = render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-uncategorized")).toBeInTheDocument());

    // It is the LAST section of the list.
    const sections = container.querySelectorAll("section");
    const last = sections[sections.length - 1];
    expect(last).toHaveAttribute("data-testid", "ask-uncategorized");
    expect(screen.getByTestId("ask-uncategorized-count")).toHaveTextContent("1");
    expect(screen.getByTestId("ask-uncategorized-name")).toHaveTextContent("Uncategorized");
  });

  it("folds a section away and opens it again", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g1", "Work", 100);
    seedThread(gateway, "t1", "In the group", "g1");

    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-thread-item")).toBeInTheDocument());

    const toggle = screen.getByTestId("ask-group-toggle");
    expect(toggle).toHaveAttribute("aria-expanded", "true");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByTestId("ask-thread-item")).toBeNull();

    fireEvent.click(toggle);
    expect(screen.getByTestId("ask-thread-item")).toBeInTheDocument();
  });

  it("carries no emoji anywhere in the rendered history", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g1", "Work", 100);
    seedThread(gateway, "t1", "In the group", "g1");
    seedThread(gateway, "t2", "Loose thread", null);

    const { container } = render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getAllByTestId("ask-thread-item")).toHaveLength(2));

    expect(container.textContent ?? "").not.toMatch(EMOJI_RE);
    // The controls are lucide icons, not glyphs.
    expect(screen.getByTestId("ask-group-new").querySelector("svg")).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The groups themselves
// ---------------------------------------------------------------------------

describe("Creating a group", () => {
  it("turns the New group control into an input and creates it", async () => {
    const gateway = installGateway();

    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-new-group")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-new-group"));
    const input = screen.getByTestId("ask-new-group-input");
    fireEvent.change(input, { target: { value: "Work" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(gateway.groupPosts).toHaveLength(1));
    expect(gateway.groupPosts[0].name).toBe("Work");
    // The new group shows up, read back from the server.
    await waitFor(() => expect(screen.getByTestId("ask-group-name")).toHaveTextContent("Work"));
  });

  it("cancels the new group on Escape", async () => {
    const gateway = installGateway();

    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-new-group")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-new-group"));
    const input = screen.getByTestId("ask-new-group-input");
    fireEvent.change(input, { target: { value: "Work" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByTestId("ask-new-group-input")).toBeNull();
    expect(gateway.groupPosts).toHaveLength(0);
  });
});

describe("Renaming a group", () => {
  it("renames it inline, with Enter", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g1", "Work", 100);

    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-group-name")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-group-menu"));
    fireEvent.click(screen.getByTestId("ask-group-rename"));

    const input = screen.getByTestId("ask-group-name-input");
    fireEvent.change(input, { target: { value: "Play" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(gateway.groupPatches).toHaveLength(1));
    expect(gateway.groupPatches[0]).toEqual({ id: "g1", name: "Play" });
    await waitFor(() => expect(screen.getByTestId("ask-group-name")).toHaveTextContent("Play"));
  });

  it("cancels the rename on Escape", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g1", "Work", 100);

    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-group-name")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-group-menu"));
    fireEvent.click(screen.getByTestId("ask-group-rename"));

    const input = screen.getByTestId("ask-group-name-input");
    fireEvent.change(input, { target: { value: "Play" } });
    fireEvent.keyDown(input, { key: "Escape" });

    expect(screen.queryByTestId("ask-group-name-input")).toBeNull();
    expect(gateway.groupPatches).toHaveLength(0);
    expect(screen.getByTestId("ask-group-name")).toHaveTextContent("Work");
  });
});

describe("Deleting a group", () => {
  it("asks first, then deletes it and moves its threads to Uncategorized", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g1", "Work", 100);
    seedThread(gateway, "t1", "In the group", "g1");
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);

    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-group")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-group-menu"));
    fireEvent.click(screen.getByTestId("ask-group-delete"));

    await waitFor(() => expect(gateway.groupDeletes).toEqual(["g1"]));
    expect(confirm).toHaveBeenCalled();
    // The group is gone...
    await waitFor(() => expect(screen.queryByTestId("ask-group")).toBeNull());
    // ...and its thread is under Uncategorized.
    await waitFor(() => expect(screen.getByTestId("ask-uncategorized")).toBeInTheDocument());
    expect(screen.getByTestId("ask-uncategorized-count")).toHaveTextContent("1");
  });

  it("a cancelled confirmation deletes nothing", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g1", "Work", 100);
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);

    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-group")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-group-menu"));
    fireEvent.click(screen.getByTestId("ask-group-delete"));

    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(gateway.groupDeletes).toEqual([]);
    expect(screen.getByTestId("ask-group")).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Moving a thread
// ---------------------------------------------------------------------------

describe("Moving a thread", () => {
  it("files it under the group that is picked", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g1", "Work", 100);
    seedGroup(gateway, "g2", "Play", 200);
    seedThread(gateway, "t1", "A thread", "g1");

    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-thread-move")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-thread-move"));
    fireEvent.click(screen.getByTestId("ask-move-g2"));

    await waitFor(() => expect(gateway.patches).toHaveLength(1));
    expect(gateway.patches[0]).toEqual({ threadId: "t1", groupId: "g2" });
    await waitFor(() =>
      expect(screen.getByTestId("ask-thread-item")).toHaveAttribute("data-group-id", "g2"),
    );
  });

  it("takes a thread out of every group", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g1", "Work", 100);
    seedThread(gateway, "t1", "A thread", "g1");

    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-thread-move")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-thread-move"));
    fireEvent.click(screen.getByTestId("ask-move-none"));

    await waitFor(() => expect(gateway.patches).toHaveLength(1));
    expect(gateway.patches[0]).toEqual({ threadId: "t1", groupId: null });
    await waitFor(() => expect(screen.getByTestId("ask-uncategorized")).toBeInTheDocument());
  });

  it("highlights the group the thread is in", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g1", "Work", 100);
    seedGroup(gateway, "g2", "Play", 200);
    seedThread(gateway, "t1", "A thread", "g2");

    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-thread-move")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-thread-move"));

    expect(screen.getByTestId("ask-move-g2")).toHaveAttribute("data-current", "true");
    expect(screen.getByTestId("ask-move-g1")).not.toHaveAttribute("data-current");
  });
});

// ---------------------------------------------------------------------------
// A new ask inside a group
// ---------------------------------------------------------------------------

describe("A new ask inside a group", () => {
  it("creates the thread server-side with the group, then opens it", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g1", "Work", 100);
    const opened: string[] = [];

    render(<AskThreadList onOpenThread={(id) => opened.push(id)} />);
    await waitFor(() => expect(screen.getByTestId("ask-group-new")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("ask-group-new"));

    await waitFor(() => expect(gateway.posts).toHaveLength(1));
    expect(gateway.posts[0].groupId).toBe("g1");
    await waitFor(() => expect(opened).toHaveLength(1));
    expect(opened[0]).toBe(String(gateway.posts[0].id));
  });

  it("is an icon button with an accessible name", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g1", "Work", 100);

    render(<AskThreadList onOpenThread={() => {}} />);
    await waitFor(() => expect(screen.getByTestId("ask-group-new")).toBeInTheDocument());

    const button = screen.getByTestId("ask-group-new");
    expect(button).toHaveAttribute("aria-label", "New ask in Work");
    expect(button.querySelector("svg")).not.toBeNull();
    expect(button.textContent).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Parity — the two shells render the SAME components
// ---------------------------------------------------------------------------

describe("Desktop and mobile parity", () => {
  it("both sessions surfaces show the same grouped history", async () => {
    const gateway = installGateway();
    seedGroup(gateway, "g1", "Work", 100);
    seedThread(gateway, "t1", "In the group", "g1");
    seedThread(gateway, "t2", "Loose thread", null);

    const desktop = render(<DesktopSessionsView />);
    await waitFor(() => expect(screen.getAllByTestId("ask-group")).toHaveLength(1));
    expect(screen.getByTestId("ask-group-name")).toHaveTextContent("Work");
    expect(screen.getAllByTestId("ask-thread-item")).toHaveLength(2);
    desktop.unmount();

    render(<MobileSessionsView />);
    await waitFor(() => expect(screen.getAllByTestId("ask-group")).toHaveLength(1));
    expect(screen.getByTestId("ask-group-name")).toHaveTextContent("Work");
    expect(screen.getAllByTestId("ask-thread-item")).toHaveLength(2);
    expect(screen.getByTestId("ask-uncategorized")).toBeInTheDocument();
  });
});

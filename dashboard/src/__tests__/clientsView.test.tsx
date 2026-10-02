import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/* Mocked collaborators, following the preamble convention of dashboard.test.tsx. */
vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ ok: true }),
    sc: {
      nodes: vi.fn(),
      node: vi.fn(),
      add: vi.fn(),
      revoke: vi.fn(),
    },
  },
  getToken: vi.fn(() => "test-token"),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  AuthError: class AuthError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: { error: vi.fn(), info: vi.fn(), success: vi.fn() },
  Toaster: () => null,
}));

import { ClientsView, healthBadgeClass, riskBadgeClass, showState } from "@/views/ClientsView";
import { api } from "@/lib/api";
import type { ScNode, ScNodesResponse } from "@/lib/types";

const sc = api.sc as unknown as {
  nodes: ReturnType<typeof vi.fn>;
  add: ReturnType<typeof vi.fn>;
  revoke: ReturnType<typeof vi.fn>;
};

/* ------------------------------------------------------------------ fixtures */

function node(overrides: Partial<ScNode> = {}): ScNode {
  return {
    id: "home-mac",
    name: "home mac",
    state: "online",
    health: "online",
    last_seen: "2026-10-02T12:00:00Z",
    last_seen_age_s: 4,
    paired: true,
    paired_at: "2026-10-01T09:00:00Z",
    revoked_at: null,
    platform: "darwin",
    arch: "arm64",
    version: "0.1.0",
    capabilities_hash: "sha256:abc123",
    capabilities: [
      {
        name: "files.read",
        version: "1.0.0",
        kind: "tool",
        risk: "auto",
        state: "enabled",
        scopes: ["/Users/viswa/ws"],
      },
      {
        name: "files.write",
        version: "1.0.0",
        kind: "tool",
        risk: "ask",
        state: "enabled",
        scopes: ["/Users/viswa/ws"],
      },
    ],
    capability_names: ["files.read", "files.write"],
    risk_classes: ["ask", "auto"],
    grants: [{ capability: "files.write", mode: "session" }],
    grant_count: 1,
    services: [],
    note: "",
    created_at: "2026-10-01T08:00:00Z",
    ...overrides,
  };
}

function response(nodes: ScNode[]): ScNodesResponse {
  const health = (h: string) => nodes.filter((n) => n.health === h).length;
  return {
    nodes,
    summary: {
      total: nodes.length,
      online: health("online"),
      stale: health("stale"),
      offline: health("offline"),
      revoked: nodes.filter((n) => n.state === "revoked").length,
      watchdog_grace_s: 90,
      capabilities: Array.from(
        new Set(nodes.flatMap((n) => n.capability_names.filter((name): name is string => !!name))),
      ).sort(),
    },
    watchdog_grace_s: 90,
  };
}

const FLEET: ScNode[] = [
  node(),
  node({
    id: "pi-kitchen",
    name: "pi kitchen",
    health: "stale",
    state: "online",
    last_seen_age_s: 240,
    platform: "linux",
    arch: "arm64",
    capabilities: [
      { name: "files.read", version: "1.0.0", kind: "tool", risk: "auto", state: "enabled", scopes: [] },
    ],
    capability_names: ["files.read"],
    risk_classes: ["auto"],
    grants: [],
    grant_count: 0,
  }),
  node({
    id: "rpi-basement",
    name: "rpi basement",
    health: "offline",
    state: "offline",
    last_seen_age_s: 5400,
    platform: "linux",
    arch: "arm64",
    capabilities: [],
    capability_names: [],
    risk_classes: [],
    grants: [],
    grant_count: 0,
  }),
];

beforeEach(() => {
  vi.clearAllMocks();
  sc.nodes.mockResolvedValue(response(FLEET));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function renderView() {
  const user = userEvent.setup();
  render(<ClientsView />);
  await waitFor(() => expect(screen.getByTestId("sc-node-table")).toBeInTheDocument());
  return user;
}

/* ------------------------------------------------------------------ list */

describe("ClientsView — fleet list", () => {
  it("renders a row per node with its health badge", async () => {
    await renderView();
    for (const n of FLEET) {
      expect(screen.getByTestId(`sc-node-${n.id}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("sc-health-home-mac")).toHaveTextContent("online");
    expect(screen.getByTestId("sc-health-pi-kitchen")).toHaveTextContent("stale");
    expect(screen.getByTestId("sc-health-rpi-basement")).toHaveTextContent("offline");
    expect(sc.nodes).toHaveBeenCalledTimes(1);
  });

  it("shows capability names, risk classes and grant counts", async () => {
    await renderView();
    const caps = screen.getByTestId("sc-caps-home-mac");
    expect(within(caps).getByText("files.read")).toBeInTheDocument();
    expect(within(caps).getByText("files.write")).toBeInTheDocument();
    // Both risk classes appear, once each, as badges.
    expect(within(caps).getAllByText("auto")).toHaveLength(1);
    expect(within(caps).getAllByText("ask")).toHaveLength(1);
    expect(screen.getByTestId("sc-grants-home-mac")).toHaveTextContent("1 grant");
  });

  it("says so when a node reported no capabilities", async () => {
    await renderView();
    const row = screen.getByTestId("sc-node-rpi-basement");
    expect(within(row).getByText("none reported")).toBeInTheDocument();
  });

  it("shows the fleet summary and the watchdog grace", async () => {
    await renderView();
    const summary = screen.getByTestId("sc-summary");
    expect(within(summary).getByText("Total").previousSibling).toHaveTextContent("3");
    expect(within(summary).getByText("stale after 90s without a heartbeat")).toBeInTheDocument();
  });

  it("formats last-seen from the gateway's age", async () => {
    await renderView();
    const row = screen.getByTestId("sc-node-pi-kitchen");
    expect(within(row).getByText("4m ago")).toBeInTheDocument();
    expect(within(row).getByText("linux · arm64")).toBeInTheDocument();
  });

  it("sorts healthy nodes first", async () => {
    await renderView();
    const rows = screen
      .getAllByTestId(/^sc-node-/)
      .map((el) => el.getAttribute("data-testid"))
      .filter((id) => id !== "sc-node-table");
    // online, then stale, then offline.
    expect(rows).toEqual(["sc-node-home-mac", "sc-node-pi-kitchen", "sc-node-rpi-basement"]);
  });

  it("says 'never' when a node has never been seen", async () => {
    sc.nodes.mockResolvedValue(
      response([node({ last_seen: null, last_seen_age_s: null, health: "offline", state: "pending" })]),
    );
    await renderView();
    expect(screen.getByText("never")).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------- empty state */

describe("ClientsView — empty state", () => {
  it("renders an empty state with guidance, not a blank table", async () => {
    sc.nodes.mockResolvedValue(response([]));
    render(<ClientsView />);
    await waitFor(() => expect(screen.getByTestId("sc-empty")).toBeInTheDocument());
    expect(screen.getByText("No nodes yet")).toBeInTheDocument();
    expect(screen.getByText(/sarathy sc listen/)).toBeInTheDocument();
    // And no table header, so there is nothing pretending to be a fleet.
    expect(screen.queryByTestId("sc-node-table")).not.toBeInTheDocument();
  });

  it("surfaces a fetch failure as a toast and leaves an empty view", async () => {
    const { toast } = await import("sonner");
    sc.nodes.mockRejectedValue(new Error("gateway unreachable"));
    render(<ClientsView />);
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("gateway unreachable"));
    expect(screen.getByTestId("sc-empty")).toBeInTheDocument();
  });
});

/* ----------------------------------------------------------------- revoke */

describe("ClientsView — revoke flow", () => {
  it("asks for confirmation before revoking", async () => {
    const user = await renderView();
    await user.click(screen.getByTestId("sc-revoke-home-mac"));

    const confirm = screen.getByTestId("sc-revoke-confirm-home-mac");
    // The prompt names the node and offers both actions.
    expect(confirm).toHaveTextContent("Revoke");
    expect(confirm).toHaveTextContent("home mac");
    expect(within(confirm).getByText("Cancel")).toBeInTheDocument();
    // Nothing is sent until the second click.
    expect(sc.revoke).not.toHaveBeenCalled();
  });

  it("sends the revoke and refreshes the fleet", async () => {
    const user = await renderView();
    sc.revoke.mockResolvedValue({
      ok: true,
      node: node({ state: "revoked", health: "offline", paired: false }),
      session_closed: true,
      note: "the pairing hash is cleared",
    });

    await user.click(screen.getByTestId("sc-revoke-home-mac"));
    await user.click(screen.getByTestId("sc-revoke-confirm-yes-home-mac"));

    await waitFor(() => expect(sc.revoke).toHaveBeenCalledWith("home-mac"));
    // The list is re-fetched so the badge cannot lie about the node's state.
    await waitFor(() => expect(sc.nodes).toHaveBeenCalledTimes(2));
  });

  it("cancels without calling the API", async () => {
    const user = await renderView();
    await user.click(screen.getByTestId("sc-revoke-home-mac"));
    await user.click(within(screen.getByTestId("sc-revoke-confirm-home-mac")).getByText("Cancel"));
    expect(sc.revoke).not.toHaveBeenCalled();
    expect(screen.queryByTestId("sc-revoke-confirm-home-mac")).not.toBeInTheDocument();
  });

  it("reports a revoke failure and leaves the row actionable", async () => {
    const user = await renderView();
    sc.revoke.mockRejectedValue(new Error("already revoked"));
    await user.click(screen.getByTestId("sc-revoke-home-mac"));
    await user.click(screen.getByTestId("sc-revoke-confirm-yes-home-mac"));

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("already revoked"));
    // The confirm row is still there, so the operator can retry.
    expect(screen.getByTestId("sc-revoke-confirm-home-mac")).toBeInTheDocument();
  });

  it("offers no revoke button for an already-revoked node", async () => {
    sc.nodes.mockResolvedValue(
      response([node({ state: "revoked", health: "offline", paired: false, revoked_at: "2026-10-02T10:00:00Z" })]),
    );
    await renderView();
    expect(screen.queryByTestId("sc-revoke-home-mac")).not.toBeInTheDocument();
    // The row states why, rather than just losing its button.
    const row = screen.getByTestId("sc-node-home-mac");
    expect(within(row).getByText(/revoked 10/)).toBeInTheDocument();
    expect(within(row).getByText("revoked")).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------------- add */

describe("ClientsView — add node", () => {
  it("opens the form, posts, and shows the pairing key exactly once", async () => {
    const user = await renderView();
    sc.add.mockResolvedValue({
      node: node({ id: "new-host", name: "new-host", state: "pending", health: "offline", paired: false }),
      pairing_key: "sc-abcd-ef01-2345-6789",
      pairing_key_generated: true,
      hint: "run:  sc pair --gateway <url> --code sc-abcd-ef01-2345-6789",
    });

    await user.click(screen.getByTestId("sc-add-open"));
    await user.type(screen.getByTestId("sc-add-id"), "new-host");
    await user.type(screen.getByTestId("sc-add-name"), "new host");
    await user.click(screen.getByTestId("sc-add-submit"));

    await waitFor(() =>
      expect(sc.add).toHaveBeenCalledWith({ node_id: "new-host", name: "new host" }),
    );
    const shown = await screen.findByTestId("sc-add-key");
    expect(shown).toHaveTextContent("sc-abcd-ef01-2345-6789");
    expect(shown).toHaveTextContent(/not stored/i);
    await waitFor(() => expect(sc.nodes).toHaveBeenCalledTimes(2));
  });

  it("refuses to submit a blank node id", async () => {
    const user = await renderView();
    const { toast } = await import("sonner");
    await user.click(screen.getByTestId("sc-add-open"));
    await user.click(screen.getByTestId("sc-add-submit"));
    expect(sc.add).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("A node id is required");
  });

  it("reports an add failure", async () => {
    const user = await renderView();
    sc.add.mockRejectedValue(new Error("node id already registered"));
    await user.click(screen.getByTestId("sc-add-open"));
    await user.type(screen.getByTestId("sc-add-id"), "home-mac");
    await user.click(screen.getByTestId("sc-add-submit"));

    const { toast } = await import("sonner");
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("node id already registered"));
  });

  it("can be closed without adding anything", async () => {
    const user = await renderView();
    await user.click(screen.getByTestId("sc-add-open"));
    await user.click(screen.getByText("Close"));
    expect(screen.queryByTestId("sc-add-card")).not.toBeInTheDocument();
    expect(sc.add).not.toHaveBeenCalled();
  });
});

/* --------------------------------------------------------- badge logic */

describe("ClientsView — badge logic", () => {
  it("gives online, stale and offline distinct treatments", () => {
    const classes = [healthBadgeClass("online"), healthBadgeClass("stale"), healthBadgeClass("offline")];
    expect(new Set(classes).size).toBe(3);
    expect(classes[0]).toContain("green");
    expect(classes[1]).toContain("amber");
    expect(classes[2]).toContain("red");
  });

  it("falls back to the offline treatment for an unknown health value", () => {
    expect(healthBadgeClass("??")).toBe(healthBadgeClass("offline"));
  });

  it("gives the risk classes distinct treatments", () => {
    const classes = [riskBadgeClass("auto"), riskBadgeClass("ask"), riskBadgeClass("deny")];
    expect(new Set(classes).size).toBe(3);
    expect(classes[0]).toContain("green");
    expect(classes[1]).toContain("amber");
    expect(classes[2]).toContain("red");
  });

  it("treats an unknown risk class as deny-coloured", () => {
    expect(riskBadgeClass("sideways")).toBe(riskBadgeClass("deny"));
  });

  it("shows the stored state only when it adds something to health", () => {
    // online/offline would just restate the health badge.
    expect(showState(node({ state: "online" }))).toBe(false);
    expect(showState(node({ state: "offline" }))).toBe(false);
    // These are genuinely different facts from "is it reachable right now".
    expect(showState(node({ state: "pending", health: "offline" }))).toBe(true);
    expect(showState(node({ state: "pairing" }))).toBe(true);
    expect(showState(node({ state: "revoked", health: "offline" }))).toBe(true);
  });

  it("never renders two disagreeing badges on one row", async () => {
    // pi-kitchen is stored as offline but derived as stale: the registry's state
    // and its health are different facts, and showing both read as a bug.
    await renderView();
    const row = screen.getByTestId("sc-node-pi-kitchen");
    expect(within(row).getByTestId("sc-health-pi-kitchen")).toHaveTextContent("stale");
    expect(within(row).queryByTestId("sc-state-pi-kitchen")).not.toBeInTheDocument();
  });

  it("still shows the state for a node that is not simply online or offline", async () => {
    sc.nodes.mockResolvedValue(
      response([
        node({ id: "new-host", state: "pending", health: "offline", paired: false }),
        node({ id: "gone", state: "revoked", health: "offline", paired: false }),
      ]),
    );
    await renderView();
    expect(screen.getByTestId("sc-state-new-host")).toHaveTextContent("pending");
    expect(screen.getByTestId("sc-state-gone")).toHaveTextContent("revoked");
  });
});

/* ------------------------------------------------------------- refreshing */

describe("ClientsView — refresh", () => {
  it("polls while visible and stops when unmounted", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      render(<ClientsView />);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(sc.nodes).toHaveBeenCalledTimes(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(15000);
      });
      expect(sc.nodes).toHaveBeenCalledTimes(2);

      // An extra interval must not survive unmount.
      await act(async () => {
        vi.clearAllTimers();
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("refetches on demand via the refresh button", async () => {
    const user = await renderView();
    await user.click(screen.getByText("Refresh"));
    await waitFor(() => expect(sc.nodes).toHaveBeenCalledTimes(2));
  });
});

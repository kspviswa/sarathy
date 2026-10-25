import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import React from "react";

const statusMock = vi.fn();

vi.mock("@/lib/api", () => ({
  api: {
    status: (...args: unknown[]) => statusMock(...args),
    logout: vi.fn().mockResolvedValue({ ok: true }),
  },
  clearToken: vi.fn(),
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), info: vi.fn(), success: vi.fn() }),
}));

vi.mock("@/lib/theme", () => ({
  useTheme: () => ({ theme: "dark", resolved: "dark", setTheme: vi.fn() }),
}));

import { StatusPanel } from "@/components/StatusPanel";

const base = {
  version: "0.19.8",
  gateway: { running: true, pid: 42, log_file: "/tmp/gw.log" },
  model: "m",
  provider: "p",
  workspace: "/ws",
  channels: ["telegram"],
  dashboard: { host: "0.0.0.0", port: 18790, streaming: true, pairingKeyCount: 1 },
};

/**
 * A dead MCP server silently removes tools, so the status page must say so —
 * a friendly amber warning, not a silent gap (2026-10-25).
 */
describe("Status — MCP servers", () => {
  beforeEach(() => {
    statusMock.mockReset();
  });

  it("warns about unreachable servers and names them", async () => {
    statusMock.mockResolvedValue({
      ...base,
      mcp: {
        checked_at: "2026-10-25T18:00:00+00:00",
        servers: {
          uttaram: { status: "ok", tools: 4 },
          legacy: { status: "timeout", error: "connect timed out after 10s" },
        },
        failing: ["legacy"],
      },
    });

    render(<StatusPanel onLoggedOut={vi.fn()} />);

    const warning = await screen.findByTestId("settings-mcp-warning");
    expect(warning).toHaveTextContent("1 server is unreachable: legacy");
    expect(warning).toHaveTextContent(/tools were skipped/i);
    expect(screen.getByTestId("settings-mcp")).toHaveTextContent("uttaram");
    expect(screen.getByTestId("settings-mcp")).toHaveTextContent("4 tools");
  });

  it("shows no warning when every server is healthy", async () => {
    statusMock.mockResolvedValue({
      ...base,
      mcp: {
        checked_at: "2026-10-25T18:00:00+00:00",
        servers: { uttaram: { status: "ok", tools: 4 } },
        failing: [],
      },
    });

    render(<StatusPanel onLoggedOut={vi.fn()} />);

    await screen.findByTestId("settings-mcp");
    expect(screen.queryByTestId("settings-mcp-warning")).not.toBeInTheDocument();
  });

  it("says so when no MCP servers are configured", async () => {
    statusMock.mockResolvedValue({ ...base, mcp: { checked_at: null, servers: {}, failing: [] } });

    render(<StatusPanel onLoggedOut={vi.fn()} />);

    const card = await screen.findByTestId("settings-mcp");
    expect(card).toHaveTextContent("No MCP servers configured");
  });
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

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
          uttaram: {
            status: "ok",
            tools: 2,
            tool_names: ["mcp_uttaram_search", "mcp_uttaram_crawl_as_md"],
          },
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
    expect(screen.getByTestId("settings-mcp")).toHaveTextContent("2 tools");
  });

  it("lists every tool a server exposes", async () => {
    statusMock.mockResolvedValue({
      ...base,
      mcp: {
        checked_at: "2026-10-25T18:00:00+00:00",
        servers: {
          uttaram: {
            status: "ok",
            tools: 3,
            tool_names: [
              "mcp_uttaram_search",
              "mcp_uttaram_crawl_as_html",
              "mcp_uttaram_crawl_batch",
            ],
          },
        },
        failing: [],
      },
    });

    render(<StatusPanel onLoggedOut={vi.fn()} />);

    const tools = await screen.findByTestId("settings-mcp-tools-uttaram");
    expect(tools).toHaveTextContent("mcp_uttaram_search");
    expect(tools).toHaveTextContent("mcp_uttaram_crawl_as_html");
    expect(tools).toHaveTextContent("mcp_uttaram_crawl_batch");
  });

  it("lists no tools for an unreachable server", async () => {
    statusMock.mockResolvedValue({
      ...base,
      mcp: {
        checked_at: "2026-10-25T18:00:00+00:00",
        servers: { legacy: { status: "error", error: "boom", tools: 0 } },
        failing: ["legacy"],
      },
    });

    render(<StatusPanel onLoggedOut={vi.fn()} />);

    await screen.findByTestId("settings-mcp-warning");
    expect(screen.queryByTestId("settings-mcp-tools-legacy")).not.toBeInTheDocument();
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

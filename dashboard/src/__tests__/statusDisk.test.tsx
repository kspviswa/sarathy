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
  version: "0.19.9",
  gateway: { running: true, pid: 42, log_file: "/tmp/gw.log" },
  model: "m",
  provider: "p",
  workspace: "/ws",
  channels: ["telegram"],
  dashboard: { host: "h", port: 1, streaming: true, pairingKeyCount: 1 },
};

const disk = (level: string, free = 27.1, pct = 50) => ({
  path: "/",
  level,
  total_gb: 59.8,
  used_gb: 59.8 - free,
  free_gb: free,
  pct_used: pct,
  warn_free_gb: 10,
  crit_free_gb: 6,
  checked_at: "2026-10-25T19:08:14+0000",
});

describe("Settings > Status — disk", () => {
  beforeEach(() => {
    statusMock.mockReset();
  });

  it("shows free space with no warning when healthy", async () => {
    statusMock.mockResolvedValue({ ...base, disk: disk("ok") });

    render(<StatusPanel onLoggedOut={vi.fn()} />);

    const card = await screen.findByTestId("settings-disk");
    expect(card).toHaveTextContent("27.1 GiB free");
    expect(card).toHaveTextContent("50% used");
    expect(screen.queryByTestId("settings-disk-warning")).not.toBeInTheDocument();
  });

  it("warns below the 10 GiB line", async () => {
    statusMock.mockResolvedValue({ ...base, disk: disk("warn", 8.4, 86) });

    render(<StatusPanel onLoggedOut={vi.fn()} />);

    const warning = await screen.findByTestId("settings-disk-warning");
    expect(warning).toHaveTextContent("Below the 10 GiB warning line");
  });

  it("escalates below the 6 GiB red line", async () => {
    statusMock.mockResolvedValue({ ...base, disk: disk("critical", 4.2, 93) });

    render(<StatusPanel onLoggedOut={vi.fn()} />);

    const warning = await screen.findByTestId("settings-disk-warning");
    expect(warning).toHaveTextContent("Below the 6 GiB red line");
  });

  it("degrades quietly when the check failed", async () => {
    statusMock.mockResolvedValue({
      ...base,
      disk: { path: "/", level: "unknown", error: "disk check failed" },
    });

    render(<StatusPanel onLoggedOut={vi.fn()} />);

    const card = await screen.findByTestId("settings-disk");
    expect(card).toHaveTextContent("disk check failed");
    expect(screen.queryByTestId("settings-disk-warning")).not.toBeInTheDocument();
  });
});

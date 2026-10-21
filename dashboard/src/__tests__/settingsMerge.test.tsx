import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ ok: true }),
    logout: vi.fn().mockResolvedValue({ ok: true }),
    status: vi.fn().mockResolvedValue({
      version: "0.19.0",
      gateway: { running: true },
      channels: ["telegram"],
      dashboard: { host: "0.0.0.0", port: 18790, streaming: true, pairingKeyCount: 1 },
    }),
    getConfig: vi.fn().mockResolvedValue({
      agents: { defaults: { model: "llama3", provider: "ollama" } },
    }),
    putConfig: vi.fn().mockResolvedValue({ ok: true, restartRequired: false }),
    setRuntime: vi.fn().mockResolvedValue({ applied: true }),
    restart: vi.fn().mockResolvedValue({ ok: true }),
    providers: vi.fn().mockResolvedValue({ providers: [], active: "" }),
    modalities: vi.fn().mockResolvedValue({
      main: { provider: "", model: "" },
      local: { provider: "", model: "" },
      image: { provider: "", model: "" },
      active: "",
    }),
    providerModels: vi.fn().mockResolvedValue({ models: [] }),
    addProvider: vi.fn().mockResolvedValue({ ok: true }),
    editProvider: vi.fn().mockResolvedValue({ ok: true }),
    removeProvider: vi.fn().mockResolvedValue({ ok: true }),
    setModality: vi.fn().mockResolvedValue({ ok: true }),
    usageSummary: vi.fn().mockResolvedValue({ available: false }),
    devices: {
      list: vi.fn().mockResolvedValue({ devices: [] }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
  },
  getToken: vi.fn(() => "test-token"),
  setToken: vi.fn(),
  clearToken: vi.fn(),
  AuthError: class AuthError extends Error {},
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    error: vi.fn(),
    info: vi.fn(),
    success: vi.fn(),
    warning: vi.fn(),
    message: vi.fn(),
  }),
  Toaster: () => null,
}));

vi.mock("@/lib/theme", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ theme: "dark", resolved: "dark", setTheme: vi.fn() }),
}));

import { SettingsView } from "@/views/SettingsView";

/**
 * Config + Status merged into ONE surface (spec §B).
 *
 * Viswa: *"why config and status not merged?"* — this is the merge: one
 * component, five segments, and the same component behind both shells.
 */
describe("Settings — one surface, segmented", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers Form, JSON, Devices, Status and Usage", async () => {
    render(<SettingsView onLoggedOut={vi.fn()} />);

    await waitForSegments();

    for (const id of ["form", "json", "devices", "status", "usage"]) {
      expect(screen.getByTestId(`settings-segment-${id}`)).toBeInTheDocument();
    }
  });

  it("starts on the Form and swaps the content when a segment is picked", async () => {
    render(<SettingsView onLoggedOut={vi.fn()} />);

    await waitForSegments();
    expect(screen.getByTestId("settings-form")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-json")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-segment-json"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("settings-json")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-form")).not.toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-segment-status"));
      await Promise.resolve();
    });

    expect(screen.getByTestId("settings-status")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-json")).not.toBeInTheDocument();
  });

  it("swapping a segment does not unmount the shell", async () => {
    render(<SettingsView onLoggedOut={vi.fn()} />);

    await waitForSegments();

    const shell = screen.getByTestId("settings-view");
    const bar = screen.getByTestId("settings-segments");
    const content = screen.getByTestId("settings-content");

    await act(async () => {
      fireEvent.click(screen.getByTestId("settings-segment-devices"));
      await Promise.resolve();
    });

    // The same elements — not a remount of the whole surface.
    expect(screen.getByTestId("settings-view")).toBe(shell);
    expect(screen.getByTestId("settings-segments")).toBe(bar);
    expect(screen.getByTestId("settings-content")).toBe(content);
    expect(screen.getByTestId("settings-devices")).toBeInTheDocument();
  });

  it("the segment can be driven from outside (the old `config` / `status` links)", async () => {
    const onSegmentChange = vi.fn();
    const { rerender } = render(
      <SettingsView segment="form" onSegmentChange={onSegmentChange} onLoggedOut={vi.fn()} />,
    );

    await waitForSegments();
    expect(screen.getByTestId("settings-form")).toBeInTheDocument();

    rerender(
      <SettingsView
        segment="status"
        onSegmentChange={onSegmentChange}
        onLoggedOut={vi.fn()}
      />,
    );

    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.getByTestId("settings-status")).toBeInTheDocument();
    expect(screen.queryByTestId("settings-form")).not.toBeInTheDocument();
  });
});

/** The settings surface loads the config on mount — wait for the shell. */
async function waitForSegments() {
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByTestId("settings-segments")).toBeInTheDocument();
}

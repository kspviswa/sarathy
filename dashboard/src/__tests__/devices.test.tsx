import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { DevicesPanel } from "@/components/DevicesPanel";
import { api } from "@/lib/api";
import {
  deviceShortId,
  formatLastSeen,
  isStaleDevice,
  sortDevices,
  STALE_AFTER_DAYS,
} from "@/lib/devices";
import type { DeviceInfo } from "@/lib/types";

vi.mock("@/lib/api", () => ({
  api: {
    devices: {
      list: vi.fn(),
      remove: vi.fn(),
    },
  },
  clearToken: vi.fn(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

beforeEach(() => {
  vi.clearAllMocks();
});

const DEVICES: DeviceInfo[] = [
  {
    id: "aaaaaaaaaaaa",
    name: "Laptop",
    shortId: "aaaaaa",
    createdAt: 1700000000,
    lastSeen: Date.now() / 1000,
    notificationsEnabled: true,
    current: false,
  },
  {
    id: "bbbbbbbbbbbb",
    name: "Phone",
    shortId: "bbbbbb",
    createdAt: 1700000000,
    lastSeen: 0,
    notificationsEnabled: false,
    current: true,
  },
  {
    id: "cccccccccccc",
    name: "Old Tablet",
    shortId: "cccccc",
    createdAt: 1700000000,
    lastSeen: (Date.now() / 1000) - (STALE_AFTER_DAYS + 1) * 86400,
    notificationsEnabled: null,
    current: false,
  },
];

describe("device helpers", () => {
  it("short ids use the first six characters", () => {
    expect(deviceShortId("ABCDEFGH")).toBe("ABCDEF");
    expect(deviceShortId(null)).toBe("");
  });

  it("formats relative last-seen labels", () => {
    const now = 1_700_000_000_000;
    expect(formatLastSeen(now / 1000, now)).toBe("just now");
    expect(formatLastSeen(now / 1000 - 61, now)).toBe("1m ago");
    expect(formatLastSeen(now / 1000 - 3700, now)).toBe("1h ago");
    expect(formatLastSeen(now / 1000 - 3 * 86400, now)).toBe("3d ago");
    expect(formatLastSeen(null, now)).toBe("never");
  });

  it("flags devices unseen past the stale window", () => {
    const now = Date.now();
    expect(isStaleDevice(DEVICES[0], now)).toBe(false);
    expect(isStaleDevice(DEVICES[1], now)).toBe(false);
    expect(isStaleDevice(DEVICES[2], now)).toBe(true);
  });

  it("sorts newest-first with the current device pinned on top", () => {
    const sorted = sortDevices([DEVICES[0], DEVICES[1], DEVICES[2]]);
    expect(sorted[0].id).toBe("bbbbbbbbbbbb"); // current
    expect(sorted[1].id).toBe("aaaaaaaaaaaa"); // recent
    expect(sorted[2].id).toBe("cccccccccccc"); // stale
  });
});

describe("DevicesPanel", () => {
  it("renders each device and marks the current one", async () => {
    vi.mocked(api.devices.list).mockResolvedValue({ devices: DEVICES });
    render(<DevicesPanel />);

    await waitFor(() => expect(screen.getByText("Laptop")).toBeInTheDocument());
    expect(screen.getByText("Phone")).toBeInTheDocument();
    expect(screen.getAllByText("this device")).toHaveLength(1);
    // The stale tablet gets flagged, the others don't.
    expect(screen.getAllByText("stale")).toHaveLength(1);
    expect(api.devices.list).toHaveBeenCalledTimes(1);
  });

  it("revokes a non-current device without the force flag", async () => {
    vi.mocked(api.devices.list).mockResolvedValue({ devices: DEVICES });
    vi.mocked(api.devices.remove).mockResolvedValue({ ok: true, removed: "aaaaaaaaaaaa" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<DevicesPanel />);

    await waitFor(() => expect(screen.getByText("Laptop")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("device-revoke-aaaaaa"));

    await waitFor(() =>
      expect(api.devices.remove).toHaveBeenCalledWith("aaaaaaaaaaaa", false),
    );
  });

  it("forces revocation of the current device and reloads", async () => {
    vi.mocked(api.devices.list).mockResolvedValue({ devices: DEVICES });
    vi.mocked(api.devices.remove).mockResolvedValue({ ok: true, removed: "bbbbbbbbbbbb" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    let reloaded = false;
    vi.stubGlobal("location", { reload: vi.fn(() => (reloaded = true)) });
    render(<DevicesPanel />);

    await waitFor(() => expect(screen.getByText("Phone")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("device-revoke-bbbbbb"));

    await waitFor(() =>
      expect(api.devices.remove).toHaveBeenCalledWith("bbbbbbbbbbbb", true),
    );
    expect(reloaded).toBe(true);
    vi.unstubAllGlobals();
  });

  it("selects and deselects all non-current devices (current has no checkbox)", async () => {
    vi.mocked(api.devices.list).mockResolvedValue({ devices: DEVICES });
    render(<DevicesPanel />);

    await waitFor(() => expect(screen.getByText("Laptop")).toBeInTheDocument());
    // The current device is excluded from bulk selection.
    expect(screen.queryByTestId("device-select-bbbbbb")).toBeNull();

    await userEvent.click(screen.getByTestId("devices-select-all"));
    expect(screen.getByTestId("device-select-aaaaaa")).toBeChecked();
    expect(screen.getByTestId("device-select-cccccc")).toBeChecked();
    expect(screen.getByTestId("devices-select-all")).toHaveTextContent("Deselect all");

    await userEvent.click(screen.getByTestId("devices-select-all"));
    expect(screen.getByTestId("device-select-aaaaaa")).not.toBeChecked();
    expect(screen.getByTestId("device-select-cccccc")).not.toBeChecked();
    expect(screen.getByTestId("devices-select-all")).toHaveTextContent("Select all");
  });

  it("bulk revokes every selected device without the force flag", async () => {
    vi.mocked(api.devices.list).mockResolvedValue({ devices: DEVICES });
    vi.mocked(api.devices.remove).mockResolvedValue({ ok: true, removed: "x" });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<DevicesPanel />);

    await waitFor(() => expect(screen.getByText("Laptop")).toBeInTheDocument());
    await userEvent.click(screen.getByTestId("devices-select-all"));
    await userEvent.click(screen.getByTestId("devices-bulk-revoke"));

    await waitFor(() => expect(api.devices.remove).toHaveBeenCalledTimes(2));
    expect(api.devices.remove).toHaveBeenCalledWith("aaaaaaaaaaaa", false);
    expect(api.devices.remove).toHaveBeenCalledWith("cccccccccccc", false);
  });
});
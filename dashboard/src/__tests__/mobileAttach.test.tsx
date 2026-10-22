import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ ok: true }),
    sendChat: vi.fn().mockResolvedValue({ ok: true }),
    sendChatFull: vi.fn().mockResolvedValue({ ok: true }),
    sendChatWithMedia: vi.fn().mockResolvedValue({ ok: true }),
    stopChat: vi.fn().mockResolvedValue({ ok: true }),
    logout: vi.fn().mockResolvedValue({ ok: true }),
    uploadMedia: vi.fn().mockResolvedValue({ ok: true, path: "/tmp/a.png" }),
    status: vi.fn().mockResolvedValue({ version: "0.5.0", gateway: { running: true } }),
    sessions: vi.fn().mockResolvedValue({ sessions: [] }),
    session: vi.fn().mockResolvedValue({ key: "", createdAt: "", messages: [] }),
    sessionsArchive: vi.fn().mockResolvedValue({ sessions: [] }),
    sessionArchive: vi
      .fn()
      .mockResolvedValue({ id: "", key: "", createdAt: "", messages: [] }),
    sessionNew: vi.fn().mockResolvedValue({ ok: true }),
    workspaceTree: vi.fn().mockResolvedValue({ root: "/ws", tree: [] }),
    getConfig: vi.fn().mockResolvedValue({}),
    putConfig: vi.fn().mockResolvedValue({ ok: true, restartRequired: false }),
    providers: vi.fn().mockResolvedValue({ providers: [], active: "" }),
    modalities: vi.fn().mockResolvedValue({
      main: { provider: "", model: "" },
      local: { provider: "", model: "" },
      image: { provider: "", model: "" },
      active: "",
    }),
    usageSummary: vi.fn().mockResolvedValue({ available: false }),
    pushKey: vi.fn().mockResolvedValue({ publicKey: "test", available: false }),
    pushSubscribe: vi.fn().mockResolvedValue({ ok: true, count: 0 }),
    pushUnsubscribe: vi.fn().mockResolvedValue({ ok: true, count: 0 }),
    commands: vi.fn().mockResolvedValue({ commands: [] }),
    sessionFooter: vi.fn().mockResolvedValue(null),
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

import { ChatView as MobileChatView } from "@/mobile/ChatView";

/**
 * The mobile attachment picker (spec 152 §D).
 *
 * The sheet's "Upload from device" used to be a `<label htmlFor=…>` that
 * ALSO closed the sheet: closing unmounted the label in the middle of the
 * click, so the label→input activation was lost and no picker ever opened.
 * The sheet is closed first and the input is clicked on the next tick.
 */

const defaultProps = {
  messages: [] as any[],
  streaming: false,
  onSend: vi.fn(),
  onStop: vi.fn(),
  onNewChat: vi.fn(),
  onOpenFile: vi.fn(),
  onRegenerate: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** The file input, with its click() spied on. */
function fileInput(): HTMLInputElement {
  const input = document.getElementById("attach-file-input") as HTMLInputElement;
  expect(input).toBeInTheDocument();
  return input;
}

describe("Mobile attach — the device picker actually opens", () => {
  it("the paperclip opens the source sheet", async () => {
    render(<MobileChatView {...defaultProps} />);

    expect(screen.queryByTestId("mobile-attach-sheet")).not.toBeInTheDocument();

    const attach = screen.getByLabelText("Attach file");
    await act(async () => {
      fireEvent.click(attach);
      await Promise.resolve();
    });

    expect(screen.getByTestId("mobile-attach-sheet")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-attach-upload")).toBeInTheDocument();
    expect(screen.getByTestId("mobile-attach-files")).toBeInTheDocument();
  });

  it("'Upload from device' closes the sheet and then clicks the input", async () => {
    render(<MobileChatView {...defaultProps} />);

    const input = fileInput();
    const click = vi.spyOn(input, "click");

    const attach = screen.getByLabelText("Attach file");
    await act(async () => {
      fireEvent.click(attach);
      await Promise.resolve();
    });
    expect(screen.getByTestId("mobile-attach-sheet")).toBeInTheDocument();

    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-attach-upload"));
      await Promise.resolve();
    });

    // The sheet is gone...
    expect(screen.queryByTestId("mobile-attach-sheet")).not.toBeInTheDocument();
    // ...and the input was clicked.
    expect(click).toHaveBeenCalledTimes(1);
  });

  it("the click lands AFTER the sheet is closed, not during it", async () => {
    render(<MobileChatView {...defaultProps} />);

    const input = fileInput();
    // The spy records whether the sheet was still open when it was called.
    let sheetOpenAtClick: boolean | null = null;
    const click = vi.spyOn(input, "click").mockImplementation(() => {
      sheetOpenAtClick = document.querySelector('[data-testid="mobile-attach-sheet"]') !== null;
    });

    const attach = screen.getByLabelText("Attach file");
    await act(async () => {
      fireEvent.click(attach);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-attach-upload"));
      await Promise.resolve();
    });

    expect(click).toHaveBeenCalledTimes(1);
    expect(sheetOpenAtClick).toBe(false);
  });

  it("the input is rendered, not display:none — iOS ignores a hidden one", () => {
    render(<MobileChatView {...defaultProps} />);

    const input = fileInput();
    expect(input).toHaveAttribute("id", "attach-file-input");
    expect(input).toHaveAttribute("multiple");
    expect(input).toHaveAttribute("type", "file");
    // Not display:none, not hidden, not disabled.
    expect(input.style.display).not.toBe("none");
    expect(input).not.toHaveAttribute("hidden");
    expect(input).not.toBeDisabled();
    expect(input.getAttribute("aria-hidden")).toBe("true");
  });

  it("the selected files still flow into the composer", async () => {
    render(<MobileChatView {...defaultProps} />);

    const input = fileInput();
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      await Promise.resolve();
    });

    // The file is attached — the composer offers to send it.
    expect(screen.getByText("hello.txt")).toBeInTheDocument();
  });

  it("'Browse workspace files' still opens the workspace", async () => {
    const onBrowseFiles = vi.fn();
    render(<MobileChatView {...defaultProps} onBrowseFiles={onBrowseFiles} />);

    const attach = screen.getByLabelText("Attach file");
    await act(async () => {
      fireEvent.click(attach);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.click(screen.getByTestId("mobile-attach-files"));
      await Promise.resolve();
    });

    expect(onBrowseFiles).toHaveBeenCalledTimes(1);
    expect(screen.queryByTestId("mobile-attach-sheet")).not.toBeInTheDocument();
  });
});

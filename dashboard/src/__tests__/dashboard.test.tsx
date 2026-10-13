import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ ok: true }),
    sendChat: vi.fn().mockResolvedValue({ ok: true }),
    stopChat: vi.fn().mockResolvedValue({ ok: true }),
    logout: vi.fn().mockResolvedValue({ ok: true }),
    uploadMedia: vi.fn(),
    sessionNew: vi.fn().mockResolvedValue({ ok: true }),
    sendChatFull: vi.fn().mockResolvedValue({ ok: true }),
    sessionFooter: vi.fn().mockResolvedValue({
      sessionKey: "dashboard:console",
      tokens: 0,
      tokensPerSec: 0,
      cost: null,
      topic: null,
      contextUsedTokens: null,
      contextLength: null,
      contextPct: null,
      model: null,
      provider: null,
      messageCount: 0,
    }),
    commands: vi.fn().mockResolvedValue({ commands: [], count: 0 }),
    sessions: vi.fn().mockResolvedValue({ sessions: [] }),
    pushKey: vi.fn().mockResolvedValue({ publicKey: "test", available: false }),
    pushSubscribe: vi.fn().mockResolvedValue({ ok: true, count: 0 }),
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

vi.mock("@/lib/theme", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useTheme: () => ({ theme: "dark", resolved: "dark", setTheme: vi.fn() }),
}));

vi.mock("@/lib/ws", () => ({
  DashboardSocket: vi.fn().mockImplementation(function () {
    return {
      connect: vi.fn(),
      disconnect: vi.fn(),
      onMessage: vi.fn(() => vi.fn()),
      onNotification: vi.fn(() => vi.fn()),
    };
  }),
}));

vi.mock("@/components/logo", () => ({
  Logo: ({ size }: { size?: number }) => (
    <div data-testid="logo" data-size={size} />
  ),
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, ...props }: any) => React.cloneElement(children, props),
  TooltipContent: () => null,
}));

vi.mock("@/lib/useLastSession", () => ({
  useLastSession: vi.fn().mockReturnValue(false),
  resetLastSession: vi.fn(),
  DASHBOARD_SESSION_KEY: "dashboard:console",
}));

vi.mock("@/lib/useNotifications", () => ({
  useNotifications: vi.fn().mockReturnValue({
    notifications: [],
    unreadCount: 0,
    unreadIds: [],
    isUnread: () => false,
    markAllRead: vi.fn(),
    markRead: vi.fn(),
    remove: vi.fn(),
    clearAll: vi.fn(),
  }),
}));

vi.mock("@/lib/useNotificationPref", () => ({
  useNotificationPref: vi.fn(() => ({ enabled: true, setEnabled: vi.fn() })),
}));

import { ChatView, type ChatMessage } from "@/views/ChatView";
import { ChatView as MobileChatView } from "@/mobile/ChatView";
import { ThinkingSection } from "@/components/ThinkingSection";
import { CodeBlock } from "@/components/CodeBlock";
import DesktopApp from "@/App";
import { api } from "@/lib/api";
import { toast } from "sonner";
import { resetLastSession } from "@/lib/useLastSession";
import { useNotifications } from "@/lib/useNotifications";

const defaultProps = {
  messages: [] as ChatMessage[],
  streaming: false,
  onSend: vi.fn(),
  onStop: vi.fn(),
  onNewChat: vi.fn(),
  onOpenFile: vi.fn(),
  onRegenerate: vi.fn(),
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("ChatView — New chat button", () => {
  it("renders the New chat button in the header and is visible", () => {
    render(<ChatView {...defaultProps} />);
    const btn = screen.getByRole("button", { name: /new chat/i });
    expect(btn).toBeInTheDocument();
    expect(btn).toBeVisible();
  });

  it("calls onNewChat when New chat button is clicked", () => {
    const onNewChat = vi.fn();
    render(<ChatView {...defaultProps} onNewChat={onNewChat} />);
    const btn = screen.getByRole("button", { name: /new chat/i });
    fireEvent.click(btn);
    expect(onNewChat).toHaveBeenCalledTimes(1);
  });
});

describe("ThinkingSection — the turn's ONE collapse header (spec 135 §A)", () => {
  it("shows an animated 'Thinking' indicator while the turn runs", () => {
    render(
      <ThinkingSection
        toolHints={[]}
        thinkingContent="reasoning..."
        done={false}
      />,
    );
    expect(screen.getByText("Thinking")).toBeInTheDocument();

    // Spec 131 §E: the static Loader2 spinner is gone. What ships now is a
    // shimmer + travelling dots, which `index.css` disables under
    // prefers-reduced-motion.
    expect(document.querySelector(".animate-spin")).toBeNull();
    expect(screen.getByTestId("thinking-indicator")).toBeInTheDocument();
    expect(document.querySelectorAll(".thinking-dot")).toHaveLength(3);
    expect(screen.getByText("Thinking")).toHaveClass("thinking-shimmer");
  });

  it("renders nothing at all when there is nothing to show", () => {
    // The pre-135 bug was an empty bubble: header + big placeholder + chip for a
    // turn with no content and no live state. Nothing to expand, nothing live.
    const { container } = render(<ThinkingSection toolHints={[]} thinkingContent="" done />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the one slim row for a live turn that has said nothing yet", () => {
    // `alwaysShow` is what keeps the empty state a single row instead of an
    // empty bubble (spec 135 §A).
    render(<ThinkingSection toolHints={[]} thinkingContent="" done={false} alwaysShow />);
    expect(screen.getByTestId("thinking-toggle")).toBeInTheDocument();
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    expect(screen.queryByTestId("assistant-turn-segments")).toBeNull();
  });

  it("stops the indicator once the turn is done", () => {
    render(
      <ThinkingSection
        toolHints={[]}
        thinkingContent="reasoning..."
        done={true}
      />,
    );
    expect(screen.queryByTestId("thinking-indicator")).not.toBeInTheDocument();
    expect(document.querySelector(".thinking-shimmer")).toBeNull();
  });

  it("shows a Check icon and the frozen duration when done", () => {
    render(
      <ThinkingSection
        toolHints={[]}
        thinkingContent="reasoning..."
        done={true}
      />,
    );
    // The label stays "Thinking" — the row is the turn's toggle, not a status
    // sentence. What changes when the turn ends is the live affordance: the
    // shimmer stops and the dots become a Check.
    expect(screen.getByText("Thinking")).not.toHaveClass("thinking-shimmer");
    expect(document.querySelector(".text-green-500")).toBeInTheDocument();
    // Spec 135 §A: the elapsed time lives in the header's meta row.
    expect(screen.getByTestId("thinking-meta")).toHaveTextContent(/^\d+s$/);
  });

  it("shows elapsed time counting up while streaming, then freezes when done", () => {
    const { rerender } = render(
      <ThinkingSection
        toolHints={[]}
        thinkingContent="reasoning..."
        done={false}
      />,
    );

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    act(() => {
      rerender(
        <ThinkingSection
          toolHints={[]}
          thinkingContent="reasoning..."
          done={true}
        />,
      );
    });

    expect(screen.getByTestId("thinking-meta")).toHaveTextContent("3s");

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByTestId("thinking-meta")).toHaveTextContent("3s");
  });

  it("counts steps in the header and renders tool calls as chips", () => {
    render(
      <ThinkingSection
        toolHints={["read_file /foo", 'memory_log("tea")']}
        thinkingContent="reasoning..."
        done={false}
      />,
    );
    // Spec 135 §A: "6 steps · 2m 14s", not a raw mono line per call. The chips
    // themselves live in the collapsed body (asserted below).
    expect(screen.getByTestId("thinking-meta")).toHaveTextContent("2 steps ·");
  });

  it("keeps reasoning + chips inside the collapsed body", () => {
    render(
      <ThinkingSection
        toolHints={['exec("ls")', 'read_file("a.py")']}
        thinkingContent="I should list the files."
        done={true}
      />,
    );
    expect(screen.queryByTestId("thinking-body")).toBeNull();
    fireEvent.click(screen.getByTestId("thinking-toggle"));
    expect(screen.getByTestId("thinking-body")).toBeInTheDocument();
    expect(screen.getByText(/list the files/)).toBeInTheDocument();
    // One chip per tool call: name + one-line summary, not a mono blob.
    const chips = screen.getAllByTestId("tool-chip");
    expect(chips).toHaveLength(2);
    expect(chips[0]).toHaveTextContent("exec");
    expect(chips[0]).toHaveTextContent("ls");
    expect(chips[1]).toHaveTextContent("read_file");
    expect(chips[1]).toHaveTextContent("a.py");
  });
});

describe("CodeBlock — renders with expected classes", () => {
  it("renders code block with border, overflow, and language badge", () => {
    const { container } = render(
      <CodeBlock className="language-python">{"print('hello')"}</CodeBlock>,
    );
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass("border", "overflow-hidden", "rounded-lg");

    expect(screen.getByText("python")).toBeInTheDocument();
    expect(screen.getByText("Copy")).toBeInTheDocument();
  });

  it("renders without language when no className provided", () => {
    const { container } = render(<CodeBlock>{"const x = 1;"}</CodeBlock>);
    const wrapper = container.firstChild as HTMLElement;
    expect(wrapper).toHaveClass("border");
    expect(screen.queryByText("Copy")).toBeInTheDocument();
  });
});

describe("User message bubble — no excess bottom padding", () => {
  it("user bubble has py-2 (not py-2.5) for tighter spacing", () => {
    render(
      <ChatView
        {...defaultProps}
        messages={[{ role: "user", content: "Hello world" }]}
      />,
    );
    const bubble = screen.getByText("Hello world").closest("[class*='bg-primary']");
    expect(bubble).toBeInTheDocument();
    expect(bubble!.className).toContain("py-2");
    expect(bubble!.className).not.toContain("py-2.5");
  });
});

describe("Markdown table — overflow-x-auto for horizontal scroll", () => {
  it("assistant message with table renders inside md container", () => {
    const tableMd = `| Col1 | Col2 |\n|------|------|\n| a    | b    |`;
    render(
      <ChatView
        {...defaultProps}
        messages={[{ role: "assistant", content: tableMd }]}
      />,
    );
    const mdContainer = document.querySelector(".md");
    expect(mdContainer).toBeInTheDocument();
    const table = mdContainer!.querySelector("table");
    expect(table).toBeInTheDocument();
  });
});

/**
 * Parity: the image lightbox must behave identically in BOTH SPAs. The desktop
 * `ChatView` and the mobile `ChatView` are different components, so this walks
 * the real flow through each one rather than trusting that they share a module.
 */
describe("Image lightbox — desktop/mobile SPA parity", () => {
  const imageMessage: ChatMessage = {
    role: "assistant",
    content: [
      "Here is the picture.",
      "```openui-lang",
      "root = Stack([card])",
      "card = Card([img])",
      'img = ImageBlock("/api/media?path=/tmp/pic.jpg", "A diagram")',
      "```",
    ].join("\n"),
  };

  // The lightbox uses real pointer/click timing; fake timers would stall waitFor.
  beforeEach(() => vi.useRealTimers());

  const spAs: Array<[string, (props: typeof defaultProps) => React.ReactElement]> = [
    ["desktop", (props) => <ChatView {...props} />],
    ["mobile", (props) => <MobileChatView {...props} />],
  ];

  it.each(spAs)("%s SPA: tapping the image opens the lightbox", async (_name, renderSpa) => {
    render(renderSpa({ ...defaultProps, messages: [imageMessage] }));

    // The openUI runtime is a lazily-imported chunk; the first render in this
    // file pays for the module load, so allow well beyond the 1s default.
    const trigger = await screen.findByRole(
      "button",
      { name: /zoom image/i },
      { timeout: 10_000 },
    );
    expect(trigger).toHaveAttribute("title", "Zoom: A diagram");

    fireEvent.click(trigger);
    const overlay = await screen.findByTestId("image-lightbox");
    expect(overlay).toHaveAttribute("role", "dialog");

    fireEvent.click(screen.getByTestId("lightbox-zoom-in"));
    expect(screen.getByTestId("lightbox-zoom-level")).toHaveTextContent("140%");

    fireEvent.click(screen.getByTestId("lightbox-close"));
    await waitFor(() =>
      expect(screen.queryByTestId("image-lightbox")).not.toBeInTheDocument(),
    );
  });

  it.each(spAs)("%s SPA: a plain reply renders no zoom affordance", async (_name, renderSpa) => {
    render(
      renderSpa({ ...defaultProps, messages: [{ role: "assistant", content: "Just prose." }] }),
    );
    // Markdown wraps the sentence in its own element, so match loosely.
    await screen.findByText(/Just prose/, undefined, { timeout: 10_000 });
    expect(screen.queryByRole("button", { name: /zoom image/i })).not.toBeInTheDocument();
  });
});

/**
 * Parity: a "visual explainer" reply — reference images plus YouTube video cards
 * — must render and behave identically in BOTH SPAs. The video button is an
 * `@OpenUrl` action, which the renderer turns into `window.open` (NOT an <a>),
 * so this asserts the actual navigation call rather than an anchor.
 */
describe("Media cards — desktop/mobile SPA parity", () => {
  const mediaMessage: ChatMessage = {
    role: "assistant",
    content: [
      "Here are some references.",
      "```openui-lang",
      "root = Stack([gallery, vids])",
      "gallery = ImageGallery(imgs)",
      'i1 = { src: "/api/media?path=/tmp/a.jpg", alt: "Diagram A" }',
      'i2 = { src: "/api/media?path=/tmp/b.jpg", alt: "Diagram B" }',
      "imgs = [i1, i2]",
      "vids = CompositeCardBlock([v1, v2])",
      'v1 = CompositeCardItem("vid-a", h1, [b1], f1)',
      'h1 = ImageTextLarge("/api/media?path=/tmp/t1.jpg", "Video A", "How It Works", "Channel A · 5:01", true)',
      'b1 = Text("text", "A clear walkthrough.")',
      'f1 = { button: Button("Watch on YouTube", Action([@OpenUrl("https://www.youtube.com/watch?v=aaa")]), "primary") }',
      'v2 = CompositeCardItem("vid-b", h2, [b2], f2)',
      'h2 = ImageTextLarge("/api/media?path=/tmp/t2.jpg", "Video B", "Deep Dive", "Channel B · 12:30", true)',
      'b2 = Text("text", "The engineering detail.")',
      'f2 = { button: Button("Watch on YouTube", Action([@OpenUrl("https://www.youtube.com/watch?v=bbb")]), "primary") }',
      "```",
    ].join("\n"),
  };

  beforeEach(() => vi.useRealTimers());

  const spAs: Array<[string, (props: typeof defaultProps) => React.ReactElement]> = [
    ["desktop", (props) => <ChatView {...props} />],
    ["mobile", (props) => <MobileChatView {...props} />],
  ];

  it.each(spAs)("%s SPA: renders reference images and video cards", async (_name, renderSpa) => {
    const { container } = render(renderSpa({ ...defaultProps, messages: [mediaMessage] }));

    await screen.findByText(
      /How It Works/,
      undefined,
      { timeout: 10_000 },
    );

    const srcs = Array.from(container.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    expect(srcs).toContain("/api/media?path=/tmp/a.jpg");
    expect(srcs).toContain("/api/media?path=/tmp/b.jpg");
    expect(srcs).toContain("/api/media?path=/tmp/t1.jpg");
    expect(srcs).toContain("/api/media?path=/tmp/t2.jpg");

    expect(screen.getAllByRole("button", { name: /watch on youtube/i })).toHaveLength(2);
  });

  it.each(spAs)("%s SPA: the video button opens the YouTube URL", async (_name, renderSpa) => {
    const open = vi.spyOn(window, "open").mockImplementation(() => null);
    try {
      render(renderSpa({ ...defaultProps, messages: [mediaMessage] }));
      const buttons = await screen.findAllByRole(
        "button",
        { name: /watch on youtube/i },
        { timeout: 10_000 },
      );

      fireEvent.click(buttons[0]);
      expect(open).toHaveBeenCalledWith(
        "https://www.youtube.com/watch?v=aaa",
        "_blank",
        "noopener,noreferrer",
      );

      fireEvent.click(buttons[1]);
      expect(open).toHaveBeenCalledWith(
        "https://www.youtube.com/watch?v=bbb",
        "_blank",
        "noopener,noreferrer",
      );
    } finally {
      open.mockRestore();
    }
  });
});

describe("Standalone viewport fix", () => {
  it("root container has standalone-fix class for PWA viewport height", () => {
    const { container } = render(<ChatView {...defaultProps} />);
    expect(container.querySelector(".flex.h-full.flex-col")).toBeInTheDocument();
  });
});

describe("Composer newline behaviour (Enter = newline)", () => {
  function renderComposer(onSend = vi.fn()) {
    const utils = render(<ChatView {...defaultProps} onSend={onSend} />);
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    return { utils, textarea, onSend };
  }

  it("plain Enter inserts a newline and does NOT send", () => {
    const { textarea, onSend } = renderComposer();
    fireEvent.change(textarea, { target: { value: "line one" } });
    fireEvent.keyDown(textarea, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Shift+Enter also inserts a newline and does NOT send", () => {
    const { textarea, onSend } = renderComposer();
    fireEvent.change(textarea, { target: { value: "line one" } });
    fireEvent.keyDown(textarea, { key: "Enter", shiftKey: true });
    expect(onSend).not.toHaveBeenCalled();
  });

  it("Ctrl+Enter sends the message", () => {
    const { textarea, onSend } = renderComposer();
    fireEvent.change(textarea, { target: { value: "hello" } });
    fireEvent.keyDown(textarea, { key: "Enter", ctrlKey: true });
    expect(onSend).toHaveBeenCalledTimes(1);
    // Quotes are a trailing optional arg; absent when nothing was quoted.
    expect(onSend).toHaveBeenCalledWith("hello", undefined, null, undefined, undefined);
  });

it("Cmd+Enter sends the message", () => {
     const { textarea, onSend } = renderComposer();
     fireEvent.change(textarea, { target: { value: "hi" } });
     fireEvent.keyDown(textarea, { key: "Enter", metaKey: true });
     expect(onSend).toHaveBeenCalledTimes(1);
   });
 });

describe("Composer — always-show Send while streaming", () => {
   it("desktop: Send button is present and enabled while streaming is true", () => {
     const onSend = vi.fn();
     const utils = render(<ChatView {...defaultProps} streaming={true} onSend={onSend} />);
     const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
     fireEvent.change(textarea, { target: { value: "hello" } });
     const sendBtn = document.querySelector('[aria-label="Send"]') as HTMLElement;
     expect(sendBtn).toBeInTheDocument();
     expect(sendBtn).toBeEnabled();
   });

   it("desktop: Stop button is not in the composer send row while streaming", () => {
     const onStop = vi.fn();
     render(<ChatView {...defaultProps} streaming={true} onStop={onStop} />);
     const sendBtn = document.querySelector('[aria-label="Send"]') as HTMLElement;
     expect(sendBtn).toBeInTheDocument();
   });

   it("mobile: Send button is present and enabled while streaming is true", () => {
     const onSend = vi.fn();
     const utils = render(<MobileChatView {...defaultProps} streaming={true} onSend={onSend} />);
     const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
     fireEvent.change(textarea, { target: { value: "hello" } });
     const sendBtn = document.querySelector('[aria-label="Send"]') as HTMLElement;
     expect(sendBtn).toBeInTheDocument();
     expect(sendBtn).toBeEnabled();
   });

   it("mobile: Stop button is not in the composer send row while streaming", () => {
     const onStop = vi.fn();
     render(<MobileChatView {...defaultProps} streaming={true} onStop={onStop} />);
     const sendBtn = document.querySelector('[aria-label="Send"]') as HTMLElement;
     expect(sendBtn).toBeInTheDocument();
   });
 });

describe("Archive on New Chat — desktop App", () => {
  it("calls api.sessionNew and clears messages on success", async () => {
    render(<DesktopApp />);
    await act(async () => { vi.advanceTimersByTime(100); });
    const btn = screen.getByRole("button", { name: /new chat/i });
    await act(async () => { fireEvent.click(btn); await vi.advanceTimersByTime(100); });
    expect(api.sessionNew).toHaveBeenCalledWith("dashboard:console");
  });

  it("does not clear messages and shows error toast on archive failure", async () => {
    vi.mocked(api.sessionNew).mockRejectedValue(new Error("Server error"));
    render(<DesktopApp />);
    await act(async () => { vi.advanceTimersByTime(100); });
    const btn = screen.getByRole("button", { name: /new chat/i });
    await act(async () => { fireEvent.click(btn); await vi.advanceTimersByTime(100); });
    expect(api.sessionNew).toHaveBeenCalledWith("dashboard:console");
    expect(resetLastSession).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalled();
  });

  it("guards against double-tap by not calling sessionNew twice", async () => {
    vi.mocked(api.sessionNew).mockReturnValue(new Promise(() => {}));
    render(<DesktopApp />);
    await act(async () => { vi.advanceTimersByTime(100); });
    const btn = screen.getByRole("button", { name: /new chat/i });
    fireEvent.click(btn);
    await act(async () => { vi.advanceTimersByTime(0); });
    fireEvent.click(btn);
    await act(async () => { vi.advanceTimersByTime(0); });
    expect(api.sessionNew).toHaveBeenCalledTimes(1);
    vi.mocked(api.sessionNew).mockResolvedValue({ ok: true });
  });
});

describe("Composer — native label-for attach trigger", () => {
    it("desktop: file input has id and is associated with a label via htmlFor", () => {
      render(<ChatView {...defaultProps} />);
      const fileInput = document.getElementById("attach-file-input") as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();
      expect(fileInput).toHaveAttribute("id", "attach-file-input");
      const label = document.querySelector('label[for="attach-file-input"]');
      expect(label).toBeInTheDocument();
    });

    it("mobile: file input has id and is associated with a label via htmlFor", () => {
      render(<MobileChatView {...defaultProps} />);
      const fileInput = document.getElementById("attach-file-input") as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();
      expect(fileInput).toHaveAttribute("id", "attach-file-input");
      const label = document.querySelector('label[for="attach-file-input"]');
      expect(label).toBeInTheDocument();
    });

    it("desktop: label itself is the tappable attach trigger for the file input", () => {
      render(<ChatView {...defaultProps} />);
      const label = document.querySelector('label[for="attach-file-input"]');
      expect(label).toBeInTheDocument();
      // The label must BE the tap target (no interactive child that swallows
      // the tap) — a Button inside a label breaks native label->input
      // activation. aria-label + role=button on the label itself.
      expect(label).toHaveAttribute("aria-label", "Attach file");
      expect(label).toHaveAttribute("role", "button");
      expect(label?.querySelector("button")).toBeNull();
    });

    it("mobile: label itself is the tappable attach trigger for the file input", () => {
      render(<MobileChatView {...defaultProps} />);
      const label = document.querySelector('label[for="attach-file-input"]');
      expect(label).toBeInTheDocument();
      expect(label).toHaveAttribute("aria-label", "Attach file");
      expect(label).toHaveAttribute("role", "button");
      expect(label?.querySelector("button")).toBeNull();
    });
  });

describe("Notification Reply — quotes into the CURRENT session", () => {
  it("desktop: does not archive the session and seeds a quote chip", async () => {
    vi.mocked(useNotifications).mockReturnValue({
      notifications: [
        {
          id: "n1",
          title: "Job 126 completed",
          body: "All suites green.",
          tab: "jobs",
          timestamp: "2026-10-11T00:00:00.000Z",
        },
      ],
      unreadCount: 1,
      unreadIds: ["n1"],
      isUnread: () => true,
      markAllRead: vi.fn(),
      markRead: vi.fn(),
      remove: vi.fn(),
      clearAll: vi.fn(),
    } as never);

    render(<DesktopApp />);
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    fireEvent.click(screen.getByTestId("notifications-bell"));
    fireEvent.click(screen.getByTestId("notifications-reply"));
    await act(async () => {
      vi.advanceTimersByTime(0);
    });

    // The whole point: reply is a turn in the live session, never a new one.
    expect(api.sessionNew).not.toHaveBeenCalled();
    expect(resetLastSession).not.toHaveBeenCalled();
    const chip = screen.getByTestId("quote-chip");
    expect(chip).toHaveTextContent("Job 126 completed");
  });
});


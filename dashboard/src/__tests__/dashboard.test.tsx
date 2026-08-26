import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act, fireEvent } from "@testing-library/react";
import React from "react";

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ ok: true }),
    sendChat: vi.fn().mockResolvedValue({ ok: true }),
    stopChat: vi.fn().mockResolvedValue({ ok: true }),
    logout: vi.fn().mockResolvedValue({ ok: true }),
    uploadMedia: vi.fn(),
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
}));

vi.mock("@/lib/ws", () => ({
  DashboardSocket: vi.fn().mockImplementation(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
    onMessage: vi.fn(() => vi.fn()),
  })),
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

import { ChatView, type ChatMessage } from "@/views/ChatView";
import { ThinkingSection } from "@/components/ThinkingSection";
import { CodeBlock } from "@/components/CodeBlock";

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

describe("ThinkingSection — thinking indicator stops + shows elapsed time", () => {
  it("shows 'Thinking' with pulsing Loader2 when not done", () => {
    render(
      <ThinkingSection
        toolHints={[]}
        thinkingContent="reasoning..."
        done={false}
      />,
    );
    expect(screen.getByText("Thinking")).toBeInTheDocument();
    const spinner = document.querySelector(".animate-pulse");
    expect(spinner).toBeInTheDocument();
  });

  it("shows 'Thought for Ns' with Check icon when done", () => {
    render(
      <ThinkingSection
        toolHints={[]}
        thinkingContent="reasoning..."
        done={true}
      />,
    );
    expect(screen.queryByText("Thinking")).not.toBeInTheDocument();
    const elapsed = screen.getByText(/Thought for \d+s/);
    expect(elapsed).toBeInTheDocument();
    const checkIcon = document.querySelector(".text-green-500");
    expect(checkIcon).toBeInTheDocument();
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

    expect(screen.getByText("Thought for 3s")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(screen.getByText("Thought for 3s")).toBeInTheDocument();
  });

  it("shows tool call count badge when toolHints provided", () => {
    render(
      <ThinkingSection
        toolHints={["read_file /foo", "write_file /bar"]}
        thinkingContent="reasoning..."
        done={false}
      />,
    );
    expect(screen.getByText("2 tool calls")).toBeInTheDocument();
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

describe("Standalone viewport fix", () => {
  it("root container has standalone-fix class for PWA viewport height", () => {
    const { container } = render(<ChatView {...defaultProps} />);
    expect(container.querySelector(".flex.h-full.flex-col")).toBeInTheDocument();
  });
});

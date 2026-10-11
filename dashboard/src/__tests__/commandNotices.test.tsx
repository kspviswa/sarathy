/**
 * Command-notice bubbles render on BOTH surfaces (desktop + mobile parity).
 *
 * A `/stop`, `/steer` or `/btw` ack must appear as its own visible bubble, the
 * way Telegram shows it — see lib/transcript.ts for the merge fix.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/lib/useLastSession", () => ({
  useLastSession: vi.fn().mockReturnValue(false),
  resetLastSession: vi.fn(),
  DASHBOARD_SESSION_KEY: "dashboard:console",
}));

import { ChatView, type ChatMessage } from "@/views/ChatView";
import { ChatView as MobileChatView } from "@/mobile/ChatView";
import { TooltipProvider } from "@/components/ui/tooltip";

afterEach(() => cleanup());

const baseProps = {
  streaming: false,
  onSend: vi.fn(),
  onStop: vi.fn(),
  onNewChat: vi.fn(),
  onOpenFile: vi.fn(),
  onRegenerate: vi.fn(),
};

/** The desktop bubble's action row uses Radix Tooltip, which needs a provider. */
function renderDesktop(messages: ChatMessage[]) {
  return render(
    <TooltipProvider>
      <ChatView {...baseProps} messages={messages} />
    </TooltipProvider>,
  );
}

const conversation: ChatMessage[] = [
  { role: "user", content: "/btw what is 2+2" },
  { role: "assistant", content: "💬 BTW noted — running as a side question.", notice: true },
  { role: "assistant", content: "It is 4." },
];

describe("command notices render as their own bubble", () => {
  it("desktop ChatView shows the ack bubble", () => {
    renderDesktop(conversation);
    const notice = screen.getByTestId("command-notice");
    expect(notice).toBeVisible();
    expect(notice).toHaveTextContent("BTW noted");
  });

  it("mobile ChatView shows the ack bubble", () => {
    render(<MobileChatView {...baseProps} messages={conversation} />);
    const notice = screen.getByTestId("command-notice");
    expect(notice).toBeVisible();
    expect(notice).toHaveTextContent("BTW noted");
  });

  it("does not tag ordinary assistant messages as notices", () => {
    renderDesktop([conversation[2]]);
    expect(screen.queryByTestId("command-notice")).toBeNull();
  });

  it("keeps the ack and the answer as separate bubbles", () => {
    renderDesktop(conversation);
    expect(screen.getByTestId("command-notice")).toHaveTextContent("BTW noted");
    expect(screen.getByText("It is 4.")).toBeVisible();
  });
});

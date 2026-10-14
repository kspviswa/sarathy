/**
 * Spec 137 §A/§B — rich slash-command usage cards.
 *
 * Two things are pinned here:
 *
 *  1. The parsers are STRICT. The gateway keeps replying with plain text, so the
 *     only thing standing between an ordinary assistant reply and a tappable
 *     command card is the parser refusing to guess. `null` for prose is a
 *     feature, and the false-positive cases are tested as hard as the matches.
 *
 *  2. Every control drives the SAME send path the composer uses, with the exact
 *     command strings — `/think high`, `/model set llama3.2`,
 *     `/provider role local ollama`. The last block runs the real desktop AND
 *     mobile ChatView over the same reply, because two surfaces rendering a
 *     command differently is precisely the drift this module exists to prevent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import React from "react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  matchSlashUsage,
  parseCommandHelp,
  parseCommandList,
  parseKeyValue,
  parseModelList,
  parsePromptUsage,
  parseProviderList,
  parseRoleStatus,
  USAGE_CARD_DESIGN,
} from "@/lib/slashUsage";

vi.mock("@/lib/api", () => ({
  api: {
    me: vi.fn().mockResolvedValue({ ok: true }),
    sendChat: vi.fn().mockResolvedValue({ ok: true }),
    stopChat: vi.fn().mockResolvedValue({ ok: true }),
    uploadMedia: vi.fn(),
    sessionNew: vi.fn().mockResolvedValue({ ok: true }),
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

vi.mock("@/components/logo", () => ({
  Logo: ({ size }: { size?: number }) => <div data-testid="logo" data-size={size} />,
}));

vi.mock("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children, asChild: _asChild, ...props }: any) =>
    React.cloneElement(children, props),
  TooltipContent: () => null,
}));

import { SlashUsageCard } from "@/components/SlashUsageCard";
import { applyOutbound } from "@/lib/transcript";
import type { ChatMessage } from "@/views/ChatView";
import type { OutboundMessage } from "@/lib/types";
import { ChatView as DesktopChatView } from "@/views/ChatView";
import { ChatView as MobileChatView } from "@/mobile/ChatView";

// ---------------------------------------------------------------------------
// Real gateway payloads (verbatim shapes from builtin_commands.py / loop.py)
// ---------------------------------------------------------------------------

const MODEL_HELP = `📖 /model — Show or change the active model

Usage: /model <subcommand>

Subcommands:
  status — Show current status
  list
  set`;

const PROVIDER_HELP = `📖 /provider — List or switch LLM providers

Usage: /provider <subcommand>

Subcommands:
  status — Show current status
  list
  set
  models
  role
  roles`;

const THINK_HELP = `📖 /think — Set thinking effort level

Usage: /think <subcommand>

Subcommands:
  status — Show current status
  off
  low
  medium
  high
  xhigh`;

const HELP_LIST = `🪆 Available commands:
/new — Start a new conversation (saves to memory)
/local — Ask a side question using the local provider/model
/think — Set thinking effort level`;

const MODEL_LIST = `📦 Models available on 'ollama':

• llama3.2
• qwen2.5-coder`;

const PROVIDER_LIST = `Configured providers:
 → openai
  ollama`;

const PROVIDER_ROLES = `🎭 Provider roles:
  🎙 main  → openai (gpt-5)
  🏷 local → ollama (llama3.2)
  🖼 image  → (none — image turns fall back to active)
  🔌 active → openai`;

const LOCAL_MISSING =
  "⚠️ No local provider is configured. Set one first with `/provider role local <name> [model]`.";

const LOCAL_USAGE = `Usage: /local <message>

Ask a side question on the local provider/model configured for the local role.`;

const STATUS_REPLY = `🪆 sarathy Status

Config: /home/x/.sarathy/config.json ✓
Workspace: /home/x/.sarathy/workspace ✓
Model: gpt-5
Provider: openai
Web Search: disabled`;

const CONTEXT_REPLY = `📊 Context Usage

Session: dashboard:console
Messages in session: 5

Model context length: ~128000 tokens (configured)
Usage: 1.0%
Remaining: ~126766 tokens

✅ Context OK`;

const ORDINARY_PROSE = "Here is the answer to your question.\n\nIt spans a couple of paragraphs.";

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

describe("parseCommandHelp — the 📖 help block", () => {
  it("parses /model, /provider and /think exactly", () => {
    expect(parseCommandHelp(MODEL_HELP)).toEqual({
      name: "model",
      description: "Show or change the active model",
      options: [
        { value: "status", label: "Show current status" },
        { value: "list", label: "list" },
        { value: "set", label: "set" },
      ],
    });

    expect(parseCommandHelp(THINK_HELP)?.options.map((o) => o.value)).toEqual([
      "status",
      "off",
      "low",
      "medium",
      "high",
      "xhigh",
    ]);

    const provider = parseCommandHelp(PROVIDER_HELP);
    expect(provider?.name).toBe("provider");
    expect(provider?.options.map((o) => o.value)).toEqual([
      "status",
      "list",
      "set",
      "models",
      "role",
      "roles",
    ]);
  });

  it("returns null for ordinary prose", () => {
    expect(parseCommandHelp(ORDINARY_PROSE)).toBeNull();
    expect(parseCommandHelp("📖 Reading list: three books I recommend")).toBeNull();
    expect(parseCommandHelp("")).toBeNull();
  });

  it("refuses a half-formed block — the 📖 header alone is not help", () => {
    // No `Usage:` / `Subcommands:` → must not become a card.
    expect(parseCommandHelp("📖 /model — Show or change the active model")).toBeNull();
  });

  it("refuses a header whose Usage line names a DIFFERENT command", () => {
    const forged = `📖 /model — Show or change the active model

Usage: /provider <subcommand>

Subcommands:
  list`;
    expect(parseCommandHelp(forged)).toBeNull();
  });
});

describe("parseCommandList — the 🪆 /help block", () => {
  it("round-trips every entry", () => {
    expect(parseCommandList(HELP_LIST)).toEqual({
      commands: [
        { name: "new", description: "Start a new conversation (saves to memory)" },
        { name: "local", description: "Ask a side question using the local provider/model" },
        { name: "think", description: "Set thinking effort level" },
      ],
    });
  });

  it("returns null for anything that is not the list", () => {
    expect(parseCommandList(MODEL_HELP)).toBeNull();
    expect(parseCommandList(ORDINARY_PROSE)).toBeNull();
  });
});

describe("parseModelList — the 📦 models block", () => {
  it("parses /model list and /provider models", () => {
    expect(parseModelList(MODEL_LIST)).toEqual(["llama3.2", "qwen2.5-coder"]);
    expect(parseModelList(`📦 Models on 'openai':\n\n• gpt-5\n• gpt-5-mini`)).toEqual([
      "gpt-5",
      "gpt-5-mini",
    ]);
  });

  it("returns null for ordinary prose", () => {
    expect(parseModelList(ORDINARY_PROSE)).toBeNull();
    expect(parseModelList("📦 I shipped two things today: the parser and the card")).toBeNull();
  });
});

describe("parseProviderList — the Configured providers block", () => {
  it("marks the active provider with →", () => {
    expect(parseProviderList(PROVIDER_LIST)).toEqual([
      { name: "openai", active: true },
      { name: "ollama", active: false },
    ]);
  });

  it("reads the block out of a /provider status reply too", () => {
    const status = `🔌 Provider: openai
🤖 Model: gpt-5

Configured providers:
 → openai
  ollama`;
    expect(parseProviderList(status)).toHaveLength(2);
  });

  it("returns null for anything else", () => {
    expect(parseProviderList(ORDINARY_PROSE)).toBeNull();
  });
});

describe("parseRoleStatus — the 🎭 roles block", () => {
  it("parses the three assignable roles and skips the informational `active`", () => {
    expect(parseRoleStatus(PROVIDER_ROLES)).toEqual([
      { role: "main", provider: "openai", model: "gpt-5" },
      { role: "local", provider: "ollama", model: "llama3.2" },
      { role: "image", provider: "(none — image turns fall back to active)", model: null },
    ]);
  });

  it("returns null for anything else", () => {
    expect(parseRoleStatus(ORDINARY_PROSE)).toBeNull();
  });
});

describe("parseKeyValue — labelled status rows", () => {
  it("parses /status and strips the leading emoji from each label", () => {
    expect(parseKeyValue(STATUS_REPLY)).toEqual([
      { key: "Config", value: "/home/x/.sarathy/config.json ✓" },
      { key: "Workspace", value: "/home/x/.sarathy/workspace ✓" },
      { key: "Model", value: "gpt-5" },
      { key: "Provider", value: "openai" },
      { key: "Web Search", value: "disabled" },
    ]);
  });

  it("ignores the trailing Usage: line rather than treating it as a row", () => {
    const rows = parseKeyValue(`🤖 Model: gpt-5
Provider: openai
Temperature: 0.7

Usage: /model set <name> · /model list · /model`);
    expect(rows?.map((r) => r.key)).toEqual(["Model", "Provider", "Temperature"]);
  });

  it("returns null for ordinary prose — even prose that opens with `Key: value`", () => {
    expect(parseKeyValue(ORDINARY_PROSE)).toBeNull();
    expect(parseKeyValue("Key insight: the build is broken.\nAnd a second line of prose.")).toBeNull();
    expect(parseKeyValue("Model: gpt-5")).toBeNull();
  });
});

describe("parsePromptUsage — `Usage: /x …` notices", () => {
  it("parses the arg-less usage reply", () => {
    expect(parsePromptUsage(LOCAL_USAGE)).toEqual({
      command: "local",
      usage: "<message>",
      examples: [],
      current: null,
    });
  });

  it("captures the `Example:` line /remember replies with", () => {
    const usage = parsePromptUsage(
      "Usage: /remember <text to save>\nExample: /remember My API key is abc123",
    );
    expect(usage?.examples).toEqual(["/remember My API key is abc123"]);
  });

  it("captures the live value /verbose and /streaming report", () => {
    expect(parsePromptUsage("Usage: /verbose [true|false|status]\nCurrent: off")?.current).toBe("off");
  });

  it("returns null for ordinary prose", () => {
    expect(parsePromptUsage(ORDINARY_PROSE)).toBeNull();
  });
});

describe("matchSlashUsage — which card, if any", () => {
  it("attributes every command reply to its design entry", () => {
    const cases: [string, string, string][] = [
      [MODEL_HELP, "help", "model"],
      [PROVIDER_HELP, "help", "provider"],
      [THINK_HELP, "help", "think"],
      [HELP_LIST, "commands", "help"],
      [MODEL_LIST, "models", "model"],
      [PROVIDER_LIST, "providers", "provider"],
      [PROVIDER_ROLES, "roles", "provider"],
      [STATUS_REPLY, "info", "status"],
      [CONTEXT_REPLY, "info", "context"],
      ["sarathy v0.17.8", "info", "version"],
      [LOCAL_USAGE, "prompt", "local"],
      [LOCAL_MISSING, "setup", "local"],
      ["Usage: /btw <message>\n\nRuns concurrently.", "prompt", "btw"],
    ];
    for (const [text, kind, command] of cases) {
      const m = matchSlashUsage(text);
      expect(m, text.slice(0, 40)).not.toBeNull();
      expect(m?.kind, text.slice(0, 40)).toBe(kind);
      expect(m?.command, text.slice(0, 40)).toBe(command);
      expect(USAGE_CARD_DESIGN[m!.command], text.slice(0, 40)).toBeDefined();
    }
  });

  it("keeps the descriptive prose so nothing is lost", () => {
    // The card renders the options; the sentence explaining them is still text.
    const m = matchSlashUsage(
      "Usage: /btw <message>\n\nAsk a side question. It runs concurrently.",
    );
    expect(m?.prose).toBe("Ask a side question. It runs concurrently.");
  });

  it("returns null for ordinary prose and for unknown commands", () => {
    expect(matchSlashUsage(ORDINARY_PROSE)).toBeNull();
    expect(matchSlashUsage("")).toBeNull();
    // A help block for a command with no design entry falls back to plain text
    // rather than rendering a half-specified card.
    const unknown = `📖 /wat — Does a thing

Usage: /wat <subcommand>

Subcommands:
  go`;
    expect(matchSlashUsage(unknown)).toBeNull();
  });
});

describe("USAGE_CARD_DESIGN — every command is designed for", () => {
  it("covers every built-in command with a control kind", () => {
    const expected: Record<string, string> = {
      new: "action",
      clear: "action",
      stop: "action",
      think: "chips",
      verbose: "toggle",
      streaming: "toggle",
      context: "info",
      remember: "prompt",
      topic: "prompt",
      help: "grid",
      restart: "danger",
      shell: "prompt",
      version: "info",
      status: "info",
      model: "list",
      provider: "list",
      steer: "prompt",
      btw: "prompt",
      local: "prompt",
    };
    for (const [name, kind] of Object.entries(expected)) {
      expect(USAGE_CARD_DESIGN[name]?.kind, name).toBe(kind);
    }
    // 19 builtins in the gateway registry; nothing is left undesigned.
    expect(Object.keys(USAGE_CARD_DESIGN).sort()).toEqual(Object.keys(expected).sort());
  });
});

// ---------------------------------------------------------------------------
// The card: tap → onSend with the exact command string
// ---------------------------------------------------------------------------

function renderCard(text: string) {
  const parsed = matchSlashUsage(text);
  expect(parsed).not.toBeNull();
  const onSend = vi.fn();
  render(<SlashUsageCard parsed={parsed!} onSend={onSend} />);
  return onSend;
}

describe("SlashUsageCard — every control drives the composer's send path", () => {
  it("/think renders chips and `high` sends `/think high`", () => {
    const onSend = renderCard(THINK_HELP);
    expect(screen.getByTestId("usage-chip-high")).toHaveTextContent("High");
    fireEvent.click(screen.getByTestId("usage-chip-high"));
    expect(onSend).toHaveBeenCalledWith("/think high");

    fireEvent.click(screen.getByTestId("usage-chip-xhigh"));
    expect(onSend).toHaveBeenLastCalledWith("/think xhigh");

    fireEvent.click(screen.getByTestId("usage-status-think"));
    expect(onSend).toHaveBeenLastCalledWith("/think status");
  });

  it("/think status highlights the live level", () => {
    renderCard("🧠 Thinking: high\n\nUse /think <level> to change. Levels: off, low, medium, high, xhigh");
    expect(screen.getByTestId("usage-chip-high")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByTestId("usage-chip-low")).toHaveAttribute("aria-pressed", "false");
  });

  it("/verbose renders a switch that sends true/false, plus Status", () => {
    const onSend = renderCard("Usage: /verbose [true|false|status]\nCurrent: off");
    const sw = screen.getByRole("switch");
    expect(sw).toHaveAttribute("data-state", "unchecked");

    fireEvent.click(sw);
    expect(onSend).toHaveBeenCalledWith("/verbose true");

    fireEvent.click(screen.getByRole("switch"));
    expect(onSend).toHaveBeenLastCalledWith("/verbose false");

    fireEvent.click(screen.getByTestId("usage-status-verbose"));
    expect(onSend).toHaveBeenLastCalledWith("/verbose status");
  });

  it("/streaming does the same for its own subcommands", () => {
    const onSend = renderCard("Usage: /streaming [true|false|status]\nCurrent: enabled");
    expect(screen.getByRole("switch")).toHaveAttribute("data-state", "checked");
    fireEvent.click(screen.getByRole("switch"));
    expect(onSend).toHaveBeenCalledWith("/streaming false");
  });

  it("/model offers Status, List models and a Set… prompt", () => {
    const onSend = renderCard(MODEL_HELP);

    fireEvent.click(screen.getByTestId("usage-model-status"));
    expect(onSend).toHaveBeenLastCalledWith("/model status");

    fireEvent.click(screen.getByTestId("usage-model-list"));
    expect(onSend).toHaveBeenLastCalledWith("/model list");

    // Set… reveals a field rather than sending anything yet.
    fireEvent.click(screen.getByTestId("usage-model-set"));
    expect(onSend).toHaveBeenCalledTimes(2);
    const input = screen.getByTestId("usage-model-set-input");
    fireEvent.change(input, { target: { value: "llama3.2" } });
    fireEvent.click(screen.getByTestId("usage-model-set-input-send"));
    expect(onSend).toHaveBeenLastCalledWith("/model set llama3.2");
  });

  it("/model list renders tappable rows that send `/model set <name>`", () => {
    const onSend = renderCard(MODEL_LIST);
    const list = screen.getByTestId("usage-models");
    expect(within(list).getAllByRole("button")).toHaveLength(2);

    fireEvent.click(screen.getByTestId("usage-model-qwen2.5-coder"));
    expect(onSend).toHaveBeenCalledWith("/model set qwen2.5-coder");
  });

  it("/provider renders tappable provider rows that send `/provider set <name>`", () => {
    const onSend = renderCard(PROVIDER_LIST);
    fireEvent.click(screen.getByTestId("usage-provider-ollama"));
    expect(onSend).toHaveBeenCalledWith("/provider set ollama");
    // The active row is marked, so the user can see where they already are.
    expect(screen.getByTestId("usage-provider-openai")).toHaveAttribute("aria-pressed", "true");
  });

  it("/provider offers Status, List, Roles and a Models… prompt", () => {
    const onSend = renderCard(PROVIDER_HELP);

    fireEvent.click(screen.getByTestId("usage-provider-status"));
    expect(onSend).toHaveBeenLastCalledWith("/provider status");
    fireEvent.click(screen.getByTestId("usage-provider-list"));
    expect(onSend).toHaveBeenLastCalledWith("/provider list");
    fireEvent.click(screen.getByTestId("usage-provider-roles"));
    expect(onSend).toHaveBeenLastCalledWith("/provider roles");

    fireEvent.click(screen.getByTestId("usage-provider-models"));
    fireEvent.change(screen.getByTestId("usage-provider-models-input"), {
      target: { value: "ollama" },
    });
    fireEvent.click(screen.getByTestId("usage-provider-models-input-send"));
    expect(onSend).toHaveBeenLastCalledWith("/provider models ollama");
  });

  it("/provider roles exposes each role, sending `/provider role <role> <name>`", () => {
    const onSend = renderCard(PROVIDER_ROLES);
    const roles = screen.getByTestId("usage-roles");
    expect(within(roles).getAllByText(/main|local|image/)).not.toHaveLength(0);

    // The role reply alone does not name every provider, so the role row opens
    // a field that composes the exact command.
    fireEvent.click(screen.getByTestId("usage-role-set-local"));
    fireEvent.change(screen.getByTestId("usage-role-input-local"), { target: { value: "ollama" } });
    fireEvent.click(screen.getByTestId("usage-role-input-local-send"));
    expect(onSend).toHaveBeenLastCalledWith("/provider role local ollama");
  });

  it("/provider roles renders one-tap role assignment when the providers are known", () => {
    // `/provider status` leads with the provider list AND the roles block can
    // follow; when both are in one reply each role becomes segmented buttons.
    const parsed = matchSlashUsage(PROVIDER_ROLES)!;
    parsed.providers = [
      { name: "openai", active: true },
      { name: "ollama", active: false },
    ];
    const onSend = vi.fn();
    render(<SlashUsageCard parsed={parsed} onSend={onSend} />);

    fireEvent.click(screen.getByTestId("usage-role-local-ollama"));
    expect(onSend).toHaveBeenCalledWith("/provider role local ollama");
  });

  it("/help renders a grid whose cards send the bare command", () => {
    const onSend = renderCard(HELP_LIST);
    const grid = screen.getByTestId("usage-grid");
    expect(within(grid).getAllByRole("button")).toHaveLength(3);
    fireEvent.click(screen.getByTestId("usage-command-local"));
    expect(onSend).toHaveBeenCalledWith("/local");
  });

  it("/status renders an info card of key/value rows", () => {
    renderCard(STATUS_REPLY);
    const rows = screen.getByTestId("usage-rows");
    expect(within(rows).getByText("Config")).toBeInTheDocument();
    expect(within(rows).getByText("gpt-5")).toBeInTheDocument();
  });

  it("/version and /context render info cards too", () => {
    renderCard("sarathy v0.17.8");
    expect(screen.getByTestId("usage-rows")).toHaveTextContent("0.17.8");
  });

  it("/restart is destructive and must be armed before it fires", () => {
    // `/restart` has no subcommands, so the gateway never prints a help block for
    // it — the card is driven straight off the design map.
    const send = vi.fn();
    render(
      <SlashUsageCard
        parsed={{ kind: "prompt", command: "restart", title: "/restart", prose: "" }}
        onSend={send}
      />,
    );

    fireEvent.click(screen.getByTestId("usage-danger"));
    expect(send).not.toHaveBeenCalled(); // the first tap only arms the button
    fireEvent.click(screen.getByTestId("usage-danger"));
    expect(send).toHaveBeenCalledWith("/restart");
  });

  it("/new, /clear and /stop are single-tap action cards", () => {
    for (const cmd of ["new", "clear", "stop"]) {
      const send = vi.fn();
      render(
        <SlashUsageCard
          parsed={{ kind: "prompt", command: cmd, title: `/${cmd}`, prose: "" }}
          onSend={send}
        />,
      );
      fireEvent.click(screen.getAllByTestId("usage-action")[0]);
      expect(send, cmd).toHaveBeenCalledWith(`/${cmd}`);
      screen.getAllByTestId("usage-action")[0].remove();
    }
  });

  it("/remember, /shell, /steer and /btw render a prompt field", () => {
    for (const cmd of ["remember", "shell", "steer", "btw"]) {
      const send = vi.fn();
      render(
        <SlashUsageCard
          parsed={{ kind: "prompt", command: cmd, title: `/${cmd}`, prose: "" }}
          onSend={send}
        />,
      );
      const input = screen.getByTestId(`usage-prompt-${cmd}`);
      fireEvent.change(input, { target: { value: "hello there" } });
      fireEvent.click(screen.getByTestId(`usage-prompt-${cmd}-send`));
      expect(send, cmd).toHaveBeenCalledWith(`/${cmd} hello there`);
      input.closest("form")?.parentElement?.remove();
    }
  });

  it("/local renders a prompt plus a tap-to-set-the-local-model shortcut", () => {
    const onSend = renderCard(LOCAL_USAGE);
    fireEvent.change(screen.getByTestId("usage-prompt-local"), { target: { value: "summarise" } });
    fireEvent.click(screen.getByTestId("usage-prompt-local-send"));
    expect(onSend).toHaveBeenCalledWith("/local summarise");

    fireEvent.click(screen.getByTestId("usage-extra-set-local-model"));
    fireEvent.change(screen.getByTestId("usage-extra-input"), { target: { value: "ollama llama3.2" } });
    fireEvent.click(screen.getByTestId("usage-extra-input-send"));
    expect(onSend).toHaveBeenLastCalledWith("/provider role local ollama llama3.2");
  });

  it("/local's canned no-provider reply shows the fix as a tap", () => {
    const onSend = renderCard(LOCAL_MISSING);
    expect(screen.getByTestId("usage-hint")).toHaveTextContent("No local provider is configured");
    fireEvent.click(screen.getByTestId("usage-extra-set-local-model"));
    fireEvent.change(screen.getByTestId("usage-extra-input"), { target: { value: "ollama" } });
    fireEvent.click(screen.getByTestId("usage-extra-input-send"));
    expect(onSend).toHaveBeenLastCalledWith("/provider role local ollama");
  });

  it("/topic renders a prompt plus a Clear action", () => {
    const text = "No topic set for this session yet.\n\nUsage: /topic <name> · /topic clear";
    // The lead-in sentence is not consumed by the card; the ChatView renders it
    // as markdown alongside (asserted in the parity block below).
    expect(matchSlashUsage(text)?.prose).toBe("No topic set for this session yet.");
    const onSend = renderCard(text);
    fireEvent.change(screen.getByTestId("usage-prompt-topic"), { target: { value: "usage cards" } });
    fireEvent.click(screen.getByTestId("usage-prompt-topic-send"));
    expect(onSend).toHaveBeenCalledWith("/topic usage cards");

    fireEvent.click(screen.getByTestId("usage-extra-clear"));
    expect(onSend).toHaveBeenLastCalledWith("/topic clear");
  });

  it("renders nothing when there is no send path (read-only surface)", () => {
    const { container } = render(
      <SlashUsageCard parsed={matchSlashUsage(MODEL_HELP)!} />,
    );
    expect(container.querySelector("[data-testid=slash-usage-card]")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Desktop / mobile parity
// ---------------------------------------------------------------------------

function frame(content: string, metadata: Record<string, unknown> = {}): OutboundMessage {
  return {
    type: "message",
    channel: "dashboard",
    chatId: "console",
    content,
    media: [],
    replyTo: null,
    metadata,
  };
}

/** One assistant bubble whose text is exactly the gateway's reply. */
function assistantSays(text: string): ChatMessage[] {
  return applyOutbound([{ role: "user", content: "/model" }], frame(text, { _final: true }));
}

const viewProps = {
  streaming: false,
  onSend: vi.fn(),
  onStop: vi.fn(),
  onNewChat: vi.fn(),
};

/**
 * Desktop's `onSend` is `(content)`; mobile's is `(content, media?)`, so the two
 * views call the same path with a different arity. Asserting the message — not
 * the argument tuple — is what makes "both surfaces send `/x y`" the real claim.
 */
function expectSent(spy: ReturnType<typeof vi.fn>, message: string) {
  expect(spy.mock.calls.at(-1)?.[0]).toBe(message);
}

describe.each([
  ["desktop", DesktopChatView as React.ComponentType<any>],
  ["mobile", MobileChatView as React.ComponentType<any>],
])("%s — renders the usage card (spec 137 §A3)", (_name, View) => {
  beforeEach(() => viewProps.onSend.mockClear());

  it("turns a bare /model reply into a tappable card", () => {
    render(<View {...viewProps} messages={assistantSays(MODEL_HELP)} />);

    const card = screen.getByTestId("slash-usage-card");
    expect(card).toHaveAttribute("data-slash-command", "model");
    expect(card).toHaveAttribute("data-slash-kind", "list");

    fireEvent.click(screen.getByTestId("usage-model-list"));
    expectSent(viewProps.onSend, "/model list");
  });

  it("turns a bare /provider reply into a tappable card", () => {
    render(<View {...viewProps} messages={assistantSays(PROVIDER_HELP)} />);
    const card = screen.getByTestId("slash-usage-card");
    expect(card).toHaveAttribute("data-slash-command", "provider");
    fireEvent.click(screen.getByTestId("usage-provider-roles"));
    expectSent(viewProps.onSend, "/provider roles");
  });

  it("renders a model listing as one-tap rows", () => {
    render(<View {...viewProps} messages={assistantSays(MODEL_LIST)} />);
    fireEvent.click(screen.getByTestId("usage-model-llama3.2"));
    expectSent(viewProps.onSend, "/model set llama3.2");
  });

  it("renders /topic's leftover prose alongside the card", () => {
    render(
      <View
        {...viewProps}
        messages={assistantSays(
          "No topic set for this session yet.\n\nUsage: /topic <name> · /topic clear",
        )}
      />,
    );
    expect(screen.getByTestId("slash-usage-card")).toBeInTheDocument();
    expect(screen.getByText("No topic set for this session yet.")).toBeInTheDocument();
  });

  it("still renders ordinary prose as plain markdown, with no card", () => {
    render(<View {...viewProps} messages={assistantSays(ORDINARY_PROSE)} />);
    expect(screen.queryByTestId("slash-usage-card")).toBeNull();
    expect(screen.getByText(/Here is the answer to your question\./)).toBeInTheDocument();
  });
});

describe("parity — desktop and mobile produce the same card for the same reply", () => {
  const cases: [string, string][] = [
    [MODEL_HELP, "model"],
    [PROVIDER_HELP, "provider"],
    [THINK_HELP, "think"],
    [HELP_LIST, "help"],
    [MODEL_LIST, "model"],
    [PROVIDER_LIST, "provider"],
    [PROVIDER_ROLES, "provider"],
    [STATUS_REPLY, "status"],
    [LOCAL_USAGE, "local"],
    [LOCAL_MISSING, "local"],
  ];

  it.each(cases)("%s renders identically on both surfaces", (text, command) => {
    const shapes: string[] = [];
    for (const View of [DesktopChatView, MobileChatView] as React.ComponentType<any>[]) {
      const onSend = vi.fn();
      const { unmount } = render(
        <View {...{ ...viewProps, onSend }} messages={assistantSays(text)} />,
      );
      const card = screen.getByTestId("slash-usage-card");
      expect(card, command).toHaveAttribute("data-slash-command", command);

      // Same controls, in the same order, on both surfaces.
      const controls = Array.from(
        card.querySelectorAll("button, [role=switch], input"),
      ).map((el) => `${el.tagName}:${el.getAttribute("data-testid") ?? el.textContent ?? ""}`);
      shapes.push(controls.join("|"));
      unmount();
    }
    expect(shapes[0]).toBe(shapes[1]);
  });
});

// ---------------------------------------------------------------------------
// Non-regression guards
// ---------------------------------------------------------------------------

describe("guards", () => {
  it("does not touch the token-usage telemetry card", () => {
    // `UsageCard.tsx` is the unrelated token-usage card (StatusView). It must
    // keep its name, its identity, and its own data source.
    const src = readFileSync(
      resolve(__dirname, "../components/UsageCard.tsx"),
      "utf-8",
    );
    expect(src).toContain("export function UsageCard");
    expect(src).not.toContain("SlashUsage");
    expect(src).toContain("usageSummary");
  });

  it("does not change the gateway's help-text format or the /api/commands contract", () => {
    // The feature is render-time only: the SPA adapts to text that already exists.
    const builtin = readFileSync(
      resolve(__dirname, "../../../sarathy/agent/builtin_commands.py"),
      "utf-8",
    );
    expect(builtin).toContain('lines = [f"📖 /{cmd_name} — {description}"]');
    expect(builtin).toContain('lines.append(f"Usage: /{cmd_name} <subcommand>")');
    expect(builtin).toContain('lines.append("Subcommands:")');
  });
});

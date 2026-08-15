"""Textual chat TUI for sarathy (alternative to the bare-stream REPL).

Renders the engine's hub events (tau stream events + sarathy markers) as a
proper interactive terminal UI: a scrolling transcript with live streaming
assistant deltas, tool-call status lines, and an input bar. Uses tau's stream
contract (`MessageUpdateEvent` -> nested `TextDeltaEvent.delta`, thinking
deltas, tool events) instead of hand-rolled terminal scribbling.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from rich.panel import Panel
from tau_agent.events import (
    MessageEndEvent,
    MessageStartEvent,
    MessageUpdateEvent,
    ToolExecutionEndEvent,
    ToolExecutionStartEvent,
)
from tau_ai.events import ThinkingDeltaEvent
from textual.app import App, ComposeResult
from textual.containers import Horizontal, VerticalScroll
from textual.widgets import Footer, Header, Input, Markdown, Static

from sarathy.engine.events import NotifyEvent, RunEnd


def _session_id(prefix: str = "cli") -> str:
    return f"{prefix}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"


class SarathyChatApp(App):
    """Interactive chat client: transcript + prompt bar over the engine."""

    TITLE = "Sarathy"
    SUB_TITLE = "engine chat"

    BINDINGS = [
        ("ctrl+c", "quit", "Quit"),
        ("ctrl+l", "clear", "Clear transcript"),
    ]

    CSS = """
    Screen {
        layout: vertical;
    }

    #transcript {
        width: 1fr;
        height: 1fr;
        padding: 0 1;
        overflow-y: auto;
    }

    .assistant {
        margin: 1 0 0 0;
        border: round $secondary 25%;
        padding: 0 1;
    }

    .thinking {
        color: $text-muted;
        margin: 0 0 0 1;
    }

    .tool {
        color: $primary;
        margin: 0 0 0 1;
    }

    .notify-info {
        color: $text-muted;
    }

    .notify-error {
        color: $error;
    }

    .notify-warning {
        color: $warning;
    }

    .notify-success {
        color: $success;
    }

    #inputbar {
        height: 3;
        padding: 0 1 1 1;
        border-top: solid $primary;
    }

    #promptlabel {
        width: 6;
        content-align: left middle;
        color: $accent;
        text-style: bold;
    }

    #prompt {
        width: 1fr;
    }

    Footer {
        height: 1;
    }
    """

    def __init__(self, engine: Any, *, session_id: str | None = None, markdown: bool = True) -> None:
        super().__init__()
        self.engine = engine
        self.session_id = session_id or _session_id()
        self.markdown = markdown
        self._streaming: Markdown | None = None
        self._assistant_text = ""
        self._unsubscribe: Any = None

    # ================================================================== compose
    def compose(self) -> ComposeResult:
        yield Header()
        with VerticalScroll(id="transcript"):
            yield Static(
                f"[dim]session {self.session_id} — type your message below[/dim]",
                classes="notify-info",
            )
        with Horizontal(id="inputbar"):
            yield Static("you >", id="promptlabel")
            yield Input(placeholder="Ask Sarathy something…", id="prompt")
        yield Footer()

    # ================================================================== lifecycle
    def on_mount(self) -> None:
        self.engine.new_session(self.session_id)
        self._unsubscribe = self.engine.hub.subscribe(self._on_hub_event)
        self.query_one("#prompt", Input).focus()

    def on_unmount(self) -> None:
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None

    # ================================================================== actions
    def action_quit(self) -> None:
        self.app.exit()

    def action_clear(self) -> None:
        self._streaming = None
        self._assistant_text = ""
        self.query_one("#transcript", VerticalScroll).remove_children()

    # ================================================================== hub events
    async def _on_hub_event(self, session_id: str, event: object) -> None:
        if session_id != self.session_id:
            return

        if isinstance(event, MessageStartEvent):
            await self._begin_assistant()
        elif isinstance(event, MessageUpdateEvent):
            nested = getattr(event, "assistant_message_event", None)
            if nested is not None and isinstance(nested, ThinkingDeltaEvent):
                self._append_thinking(nested.delta)
                return
            text = self._text_of(event)
            if text:
                await self._begin_assistant()
                self._assistant_text = text
                self._streaming.update(self._assistant_text)
            self.query_one("#transcript", VerticalScroll).scroll_end(immediate=True)
        elif isinstance(event, MessageEndEvent):
            text = self._text_of(event)
            if text:
                await self._begin_assistant()
                self._assistant_text = text
                self._streaming.update(self._assistant_text)
            self._streaming = None
            self._assistant_text = ""
            message = getattr(event, "message", None)
            error_text = getattr(message, "error_message", None) if message else None
            stop_reason = getattr(message, "stop_reason", None) if message else None
            if stop_reason in {"error", "aborted"} or error_text:
                await self._line(
                    error_text
                    or ("aborted" if stop_reason == "aborted" else "model stream failed"),
                    "notify-error",
                )
        elif isinstance(event, ToolExecutionStartEvent):
            await self._line(f"  🔧 {event.tool_name}…", "tool")
        elif isinstance(event, ToolExecutionEndEvent):
            result = getattr(event, "result", None)
            payload = getattr(result, "text", None)
            if payload:
                await self._line(f"  ↳ {payload[:500]}", "tool")
        elif isinstance(event, NotifyEvent):
            await self._line(event.message, f"notify-{event.level if event.level in {'info', 'error', 'warning', 'success'} else 'info'}")
        elif isinstance(event, RunEnd):
            pass

    # ------------------------------------------------------------------ helpers
    async def _begin_assistant(self) -> None:
        if self._streaming is None:
            self._streaming = Markdown("", classes="assistant")
            await self.query_one("#transcript", VerticalScroll).mount(self._streaming)

    def _append_thinking(self, delta: str) -> None:
        if not delta:
            return
        existing = self.query_one(".thinking", Static) if self.query(".thinking") else None
        resolved = getattr(existing, "renderable", "") if existing is not None else ""
        text = f"{resolved}{delta}"
        if existing is None:
            self.query_one("#transcript", VerticalScroll).mount(
                Static(text, classes="thinking", markup=False)
            )
        else:
            existing.update(text)

    def _text_of(self, event: Any) -> str:
        message = getattr(event, "message", None)
        if message is None:
            return ""
        blocks = getattr(message, "content", None) or []
        return "".join(getattr(b, "text", "") or "" for b in blocks)

    async def _line(self, text: str, css_class: str) -> None:
        self.query_one("#transcript", VerticalScroll).mount(
            Static(text, classes=css_class, markup=False)
        )
        self.query_one("#transcript", VerticalScroll).scroll_end(immediate=True)

    # ================================================================== user input
    def on_input_submitted(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        if not text:
            return
        self.query_one("#prompt", Input).value = ""
        if text.lower() in {"exit", "quit", "/exit", "/quit"}:
            self.exit()
            return
        if self.engine.commands.is_command(text):
            self.run_worker(self._handle_command(text), name="command", exclusive=True)
            return
        self.query_one("#transcript", VerticalScroll).mount(
            Static(Panel(f" [bold]{text}[/bold] ", border_style="cyan", expand=False), classes="user-message")
        )
        self.run_worker(self._dispatch(text), name="dispatch", exclusive=False)

    async def _dispatch(self, text: str) -> None:
        await self.engine.send(self.session_id, text)

    async def _handle_command(self, text: str) -> None:
        result = await self.engine.commands.handle(self.session_id, text)
        if result:
            await self._line(Panel(result, border_style="dim").renderable, "notify-info")

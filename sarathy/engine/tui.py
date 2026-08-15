"""Textual chat TUI for sarathy, built on Tau's rendering layer.

Instead of hand-rolling assistant/tool transcript widgets, this app drives
Tau's own display pipeline -- ``TuiEventAdapter`` -> ``TuiState`` ->
``TranscriptView`` (the same widgets ``tau`` uses in production) -- from
sarathy's engine hub events. That gives us Tau's proven markdown streaming,
thinking-block handling, tool-call/results collapsing, selection, and themes
with no custom rendering code.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from tau_agent.events import (
    AgentEndEvent,
    AgentStartEvent,
    MessageEndEvent,
    MessageStartEvent,
    MessageUpdateEvent,
    ToolExecutionEndEvent,
    ToolExecutionStartEvent,
    ToolExecutionUpdateEvent,
)
from tau_agent.messages import (
    AssistantMessage,
    CustomMessage,
    TextContent,
    ThinkingContent,
    UserMessage,
)
from tau_ai.events import TextDeltaEvent, ThinkingDeltaEvent
from tau_coding.tui.adapter import TuiEventAdapter
from tau_coding.tui.config import load_tui_settings
from tau_coding.tui.state import TuiState
from tau_coding.tui.themes import textual_theme_for_tui_theme
from tau_coding.tui.widgets import TranscriptView
from textual.app import App, ComposeResult
from textual.containers import Horizontal
from textual.widgets import Footer, Header, Input, Static

from sarathy.engine.events import NotifyEvent, RunEnd, RunStart


def _session_id(prefix: str = "cli") -> str:
    return f"{prefix}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"


class SarathyChatApp(App):
    """Interactive chat client built on Tau's TranscriptView + event adapter."""

    TITLE = "Sarathy"
    SUB_TITLE = "engine chat"

    BINDINGS = [
        ("ctrl+c", "quit", "Quit"),
        ("ctrl+l", "clear", "Clear transcript"),
        ("ctrl+t", "toggle_thinking", "Toggle thinking"),
        ("ctrl+o", "toggle_tool_results", "Toggle tool results"),
    ]

    CSS = """
    Screen {
        layout: vertical;
    }

    #main {
        layout: vertical;
        height: 1fr;
    }

    #main > #transcript {
        height: 1fr;
    }

    #inputbar {
        height: 3;
        padding: 0 1 1 1;
        border-top: solid $primary;
    }

    #promptlabel {
        width: 8;
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
        self.tui_settings = load_tui_settings()
        self.tui_theme = self.tui_settings.resolved_theme
        self.register_theme(textual_theme_for_tui_theme(self.tui_theme.name))
        self.theme = self.tui_theme.name
        self.state = TuiState()
        self.adapter = TuiEventAdapter(self.state)
        self._unsubscribe: Any = None

    # ================================================================== compose
    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="main"):
            yield TranscriptView(id="transcript", min_width=1)
        with Horizontal(id="inputbar"):
            yield Static(f"τ {self.session_id}", id="promptlabel")
            yield Input(placeholder="Ask Sarathy something…", id="prompt")
        yield Footer()

    # ================================================================== lifecycle
    async def on_mount(self) -> None:
        self.engine.new_session(self.session_id)
        self._unsubscribe = self.engine.hub.subscribe(self._on_hub_event)
        self.query_one("#transcript", TranscriptView).update_from_state(self.state, theme=self.tui_theme)
        self.query_one("#prompt", Input).focus()

    def on_unmount(self) -> None:
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None

    def on_input_submitted(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        if not text:
            return
        self.query_one("#prompt", Input).value = ""
        if text.lower() in {"exit", "quit", "/exit", "/quit"}:
            self.exit()
            return
        self.run_worker(self._dispatch(text), name="dispatch", exclusive=False)

    # ================================================================== actions
    def action_quit(self) -> None:
        self.app.exit()

    def action_clear(self) -> None:
        self.state.clear()
        self.query_one("#transcript", TranscriptView).update_from_state(self.state, theme=self.tui_theme)

    def action_toggle_thinking(self) -> None:
        self.state.toggle_thinking()
        self.query_one("#transcript", TranscriptView).update_thinking_visibility(
            self.state, theme=self.tui_theme
        )

    def action_toggle_tool_results(self) -> None:
        self.state.toggle_tool_results()
        transcript = self.query_one("#transcript", TranscriptView)
        self.run_worker(
            transcript.update_tool_results_visibility(self.state, theme=self.tui_theme),
            name="toggle-tools",
            exclusive=True,
        )

    # ================================================================== hub events
    async def _on_hub_event(self, session_id: str, event: object) -> None:
        if session_id != self.session_id:
            return
        if isinstance(event, NotifyEvent):
            self.state.add_item("status", event.message)
            await self._append_status()
            return
        if isinstance(event, (RunStart, RunEnd)):
            await self._apply_streaming(event)
            return
        self.adapter.apply(event)
        await self._apply_streaming(event)

    # A Tau-style streaming router: apply state changes to mounted transcript
    # widgets incrementally instead of rebuilding the whole transcript per event.
    async def _apply_streaming(self, event: object) -> None:
        transcript = self.query_one("#transcript", TranscriptView)
        theme = self.tui_theme
        if isinstance(event, AgentStartEvent):
            return
        if isinstance(event, AgentEndEvent):
            await transcript.finish_assistant_message()
            return
        if isinstance(event, RunStart):
            self.state.running = True
            return
        if isinstance(event, RunEnd):
            await transcript.finish_assistant_message()
            self.state.running = False
            return
        if isinstance(event, MessageStartEvent):
            return
        if isinstance(event, MessageUpdateEvent):
            await self._stream_message_update(event, transcript)
            return
        if isinstance(event, MessageEndEvent):
            message = event.message
            if isinstance(message, (UserMessage, CustomMessage)):
                await self._append_user_item()
                return
            if isinstance(message, AssistantMessage):
                if message.stop_reason in {"error", "aborted"}:
                    transcript.update_from_state(self.state, theme=theme)
                    return
                visible_blocks = [
                    block
                    for block in message.content
                    if (
                        isinstance(block, TextContent)
                        and bool(block.text)
                        or isinstance(block, ThinkingContent)
                        and bool(block.thinking)
                    )
                ]
                canonical_items = (
                    self.state.items[-len(visible_blocks) :] if visible_blocks else []
                )
                if (
                    any(isinstance(block, ThinkingContent) for block in visible_blocks)
                    or len(visible_blocks) > 1
                ):
                    await transcript.finish_structured_assistant_message(
                        canonical_items,
                        theme=theme,
                        show_thinking=self.state.show_thinking,
                    )
                else:
                    canonical_item = canonical_items[-1] if canonical_items else None
                    await transcript.finish_assistant_message(
                        message.text,
                        item=canonical_item,
                    )
            return
        if isinstance(event, ToolExecutionStartEvent):
            await transcript.finish_assistant_message()
            await self._append_status()
            return
        if isinstance(event, (ToolExecutionUpdateEvent, ToolExecutionEndEvent)):
            await transcript.finish_assistant_message()
            updated = self.state.find_tool_item(getattr(event, "tool_call_id", ""))
            if updated is not None:
                expanded = self.state.show_tool_results or updated.always_show_tool_result
                await transcript.update_item(
                    updated,
                    theme=theme,
                    show_tool_results=expanded,
                    invocation=self.state.resolve_tool_invocation(updated),
                    result_markup=self.state.resolve_tool_result(updated, expanded=expanded),
                )
            return

    async def _stream_message_update(
        self, event: MessageUpdateEvent, transcript: TranscriptView
    ) -> None:
        nested = event.assistant_message_event
        if isinstance(nested, TextDeltaEvent):
            await transcript.append_assistant_delta(nested.delta, theme=self.tui_theme)
        elif isinstance(nested, ThinkingDeltaEvent):
            await transcript.append_thinking_delta(
                nested.delta,
                theme=self.tui_theme,
                show_thinking=self.state.show_thinking,
            )

    async def _append_status(self) -> None:
        transcript = self.query_one("#transcript", TranscriptView)
        if self.state.items:
            index = len(self.state.items) - 1
            item = self.state.items[index]
            if item.role == "tool":
                await transcript.append_item(
                    item,
                    theme=self.tui_theme,
                    show_tool_results=self.state.show_tool_results,
                    invocation=self.state.resolve_tool_invocation(item),
                )
            else:
                await transcript.append_item(
                    item,
                    theme=self.tui_theme,
                    show_tool_results=self.state.show_tool_results,
                )

    async def _append_user_item(self) -> None:
        transcript = self.query_one("#transcript", TranscriptView)
        if self.state.items:
            await transcript.append_item(
                self.state.items[-1],
                theme=self.tui_theme,
                show_tool_results=self.state.show_tool_results,
            )

    # ================================================================== engine calls
    async def _dispatch(self, text: str) -> None:
        if self.engine.commands.is_command(text):
            result = await self.engine.commands.handle(self.session_id, text)
            if result:
                self.state.add_item("status", str(result))
                await self._append_status()
            return
        await self.engine.send(self.session_id, text)

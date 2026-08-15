"""TUI/REPL channel for sarathy: interactive prompt-driven chat."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from rich.console import Console
from rich.text import Text
from tau_agent.events import (
    MessageEndEvent,
    MessageStartEvent,
    MessageUpdateEvent,
    ToolExecutionStartEvent,
)
from tau_agent.messages import TextContent

from sarathy.engine.events import NotifyEvent, RunEnd


def _session_id(prefix: str = "cli") -> str:
    return f"{prefix}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"


def _text_of(event) -> str:
    message = getattr(event, "message", None)
    if message is None:
        return ""
    return "".join(b.text for b in getattr(message, "content", []) if isinstance(b, TextContent))


async def run_agent(
    *,
    message: str | None = None,
    session_id: str | None = None,
    markdown: bool = True,
) -> None:
    from sarathy.config.loader import load_config
    from sarathy.engine.engine import SarathyEngine

    engine = SarathyEngine(load_config())
    await engine.start()

    if message:
        sid = session_id or _session_id("cli-direct")
        app = engine.new_session(sid)
        console = Console(highlight=False)
        animate = asyncio.Event()

        console.print("[dim]Sarathy is working… (first request loads the model)[/dim]")

        last_len = 0

        async def on_event(session_id: str, event: object) -> None:
            nonlocal last_len
            if session_id != sid:
                return
            if isinstance(event, MessageStartEvent):
                last_len = 0
            elif isinstance(event, MessageUpdateEvent):
                text = _text_of(event)
                if text:
                    delta = text[last_len:]
                    last_len += len(delta)
                    console.print(Text(delta, style="cyan"), end="", soft_wrap=True)
            elif isinstance(event, MessageEndEvent):
                message = getattr(event, "message", None)
                error_text = getattr(message, "error_message", None) if message else None
                stop_reason = getattr(message, "stop_reason", None) if message else None
                text = _text_of(event)
                if text:
                    delta = text[last_len:]
                    last_len += len(delta)
                    if delta:
                        console.print(Text(delta, style="cyan"), end="", soft_wrap=True)
                        console.print()
                if stop_reason in {"error", "aborted"} or error_text:
                    console.print(
                        f"\n[red]Error: {error_text or ('aborted' if stop_reason == 'aborted' else 'model stream failed')}[/red]"
                    )
            elif isinstance(event, ToolExecutionStartEvent):
                call = getattr(event, "call", None)
                name = call.name if call else getattr(event, "tool_name", "tool")
                console.print(f"[dim]  🔧 {name}…[/dim]")
            elif isinstance(event, NotifyEvent):
                level = getattr(event, "level", "info")
                style = {
                    "error": "red",
                    "warning": "yellow",
                    "success": "green",
                }.get(level, "dim")
                console.print(f"[{style}]{event.message}[/{style}]")
            elif isinstance(event, RunEnd):
                animate.set()

        engine.hub.subscribe(on_event)
        try:
            await app.send(message)
            try:
                await asyncio.wait_for(animate.wait(), timeout=1200)
            except asyncio.TimeoutError:
                console.print("\n[red](timed out — is the model/provider reachable?)[/red]")
        finally:
            engine.hub._listeners.clear()  # noqa: SLF001
        await engine.stop()
        return

    await _launch_tui(engine, session_id=session_id, markdown=markdown)
    await engine.stop()
    return


async def _launch_tui(engine, *, session_id: str | None = None, markdown: bool = True) -> None:
    """Run the interactive chat as a Textual TUI (tau-aligned stream events)."""
    from sarathy.engine.tui import SarathyChatApp

    app = SarathyChatApp(engine, session_id=session_id, markdown=markdown)
    await app.run_async()

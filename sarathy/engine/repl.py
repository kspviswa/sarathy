"""TUI/REPL channel for sarathy: interactive prompt-driven chat."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from rich.console import Console
from rich.panel import Panel
from rich.text import Text
from tau_agent.events import MessageEndEvent, MessageUpdateEvent, ToolExecutionStartEvent
from tau_agent.messages import TextContent

from sarathy.engine.events import NotifyEvent, RunEnd
from sarathy.utils.helpers import ensure_dir


def _session_id(prefix: str = "cli") -> str:
    return f"{prefix}-{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"


def _text_of(event) -> str:
    message = getattr(event, "message", None)
    if message is None:
        return ""
    return "".join(b.text for b in getattr(message, "content", []) if isinstance(b, TextContent))


class Repl:
    """Interactive chat loop over the engine (one session)."""

    def __init__(self, engine, *, session_id: str | None = None, markdown: bool = True):
        self.engine = engine
        self.session_id = session_id or _session_id()
        self.markdown = markdown
        self.console = Console()

    async def run(self) -> None:
        from prompt_toolkit import PromptSession
        from prompt_toolkit.formatted_text import HTML
        from prompt_toolkit.history import FileHistory
        from prompt_toolkit.patch_stdout import patch_stdout

        history_file = ensure_dir(self.engine.data_dir / "history") / "repl_history"
        prompt = PromptSession(history=FileHistory(str(history_file)))
        self.engine.new_session(self.session_id)

        self.console.print(
            f"[dim]sarathy REPL — session {self.session_id}[/dim]\n"
        )

        joined = asyncio.Event()

        async def on_event(session_id: str, event: object) -> None:
            if session_id != self.session_id:
                return
            if isinstance(event, MessageUpdateEvent):
                text = _text_of(event)
                if text:
                    self.console.print(Text(text, style="cyan"), end="", soft_wrap=True)
            elif isinstance(event, MessageEndEvent):
                text = _text_of(event)
                self.console.print()
                joined.set()
            elif isinstance(event, ToolExecutionStartEvent):
                call = getattr(event, "call", None)
                name = call.name if call else getattr(event, "tool_name", "tool")
                self.console.print(f"[dim]  🔧 {name}…[/dim]")

        unsubscribe = self.engine.hub.subscribe(on_event)

        try:
            while True:
                joined.clear()
                try:
                    with patch_stdout():
                        user_input = await prompt.prompt_async(HTML("<b fg='#61afef'>you ></b> "))
                except (EOFError, KeyboardInterrupt):
                    self.console.print("\n[dim]bye[/dim]")
                    break

                line = user_input.strip()
                if not line:
                    continue
                if line.lower() in {"exit", "quit", "/exit", "/quit"}:
                    self.console.print("[dim]bye[/dim]")
                    break

                if self.engine.commands.is_command(line):
                    result = await self.engine.commands.handle(self.session_id, line)
                    if result:
                        self.console.print(Panel(result, border_style="dim"))
                    continue
                if line.startswith("/new"):
                    await self._new_session()
                    continue

                await self.engine.send(self.session_id, line)
                try:
                    await asyncio.wait_for(joined.wait(), timeout=600)
                except asyncio.TimeoutError:
                    self.console.print("[dim](still working…)[/dim]")
        finally:
            unsubscribe()
            await self.engine.stop()

    async def _new_session(self) -> None:
        self.session_id = _session_id()
        self.engine.new_session(self.session_id)
        self.console.print(f"[dim]new session [bold]{self.session_id}[/bold][/dim]")


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

        async def on_event(session_id: str, event: object) -> None:
            if session_id != sid:
                return
            if isinstance(event, MessageUpdateEvent):
                text = _text_of(event)
                if text:
                    console.print(Text(text, style="cyan"), end="", soft_wrap=True)
            elif isinstance(event, MessageEndEvent):
                message = getattr(event, "message", None)
                error_text = getattr(message, "error_message", None) if message else None
                stop_reason = getattr(message, "stop_reason", None) if message else None
                text = _text_of(event)
                if text:
                    console.print(Text(text, style="cyan"), end="", soft_wrap=True)
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

    repl = Repl(engine, session_id=session_id, markdown=markdown)
    await repl.run()

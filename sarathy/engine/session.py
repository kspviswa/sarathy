"""Per-session agent wrapper over tau's AgentHarness with JSONL persistence."""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone

from tau_agent import AgentHarness, AgentHarnessConfig
from tau_agent.events import (
    AgentEvent,
    MessageEndEvent,
)
from tau_agent.messages import (
    AgentMessage,
    AssistantMessage,
    TextContent,
    ToolResultMessage,
    UserMessage,
)
from tau_agent.session import JsonlSessionStorage, MessageEntry, SessionState

from sarathy.engine.events import RunEnd, RunStart


def message_to_dict(message: AgentMessage) -> dict:
    """Serialize a tau AgentMessage for frontend display."""
    role = {
        UserMessage: "user",
        AssistantMessage: "assistant",
        ToolResultMessage: "tool",
    }.get(type(message), "assistant")

    if isinstance(message, AssistantMessage):
        text = "".join(b.text for b in message.content if isinstance(b, TextContent))
    elif isinstance(message, ToolResultMessage):
        text = "".join(b.text for b in message.content if isinstance(b, TextContent))
        return {"role": "tool", "content": text, "toolName": message.tool_name, "isError": message.is_error}
    else:
        text = "".join(b.text for b in getattr(message, "content", []) if isinstance(b, TextContent))

    return {"role": role, "content": text, "model": getattr(message, "model", None)}


class SessionApp:
    """One SarathyEngine session: an AgentHarness around tau + JSONL storage."""

    def __init__(
        self,
        engine,
        session_id: str,
        *,
        window: int | None = None,
        max_turns: int | None = None,
    ):
        self.engine = engine
        self.session_id = session_id
        self.window = window
        self.max_turns = max_turns
        safe = "".join(c if c.isalnum() else "_" for c in session_id)
        self.storage = JsonlSessionStorage(self.engine.session_dir / f"{safe}.jsonl")
        self._task: asyncio.Task | None = None
        self._harness: AgentHarness | None = None
        self._pending: list[str] = []
        self.last_messages: list[AgentMessage] = []
        self.created_at = datetime.now(timezone.utc).isoformat()
        self.title = session_id

    @property
    def running(self) -> bool:
        return self._task is not None and not self._task.done()

    @property
    def queued(self) -> int:
        return len(self._pending)

    async def transcript(self) -> dict:
        """Return a serializable session view for the frontend API."""
        messages = await self.messages()
        return {
            "session_id": self.session_id,
            "title": self.title,
            "created_at": self.created_at,
            "running": self.running,
            "queued": self.queued,
            "messages": [message_to_dict(m) for m in messages],
        }

    async def messages(self) -> list[AgentMessage]:
        entries = await self.storage.read_all()
        return list(SessionState.from_entries(entries).messages)

    async def send(self, content: str) -> bool:
        """Queue or start a turn. Returns True when queued (already running)."""
        if self.running:
            self._pending.append(content)
            return True
        self._task = asyncio.create_task(self._run(content))
        return False

    async def _run(self, content: str) -> None:
        try:
            await self._process(content)
            while self._pending:
                await self._process(self._pending.pop(0))
        except asyncio.CancelledError:
            pass
        finally:
            await self.engine.hub.publish(self.session_id, RunEnd())

    async def _process(self, content: str) -> None:
        await self.engine.hub.publish(self.session_id, RunStart(content=content))
        history = await self.messages()
        if self.window:
            history = history[-self.window :]

        system = await self.engine.system_prompt()
        tools = await self.engine.tools_for_session()

        harness = AgentHarness(
            AgentHarnessConfig(
                provider=self.engine.provider,
                model=self.engine.model,
                system=system,
                tools=tools,
                max_turns=self.max_turns,
                session_id=self.session_id,
            ),
            messages=history,
        )
        self._harness = harness

        async def on_event(event: AgentEvent) -> None:
            if isinstance(event, MessageEndEvent):
                await self.storage.append(MessageEntry(message=event.message))
                self.last_messages.append(event.message)
                if self.title == self.session_id:
                    first = next(
                        (m for m in self.last_messages if isinstance(m, UserMessage)), None
                    )
                    if first is not None:
                        text = "".join(
                            b.text
                            for b in getattr(first, "content", [])
                            if isinstance(b, TextContent)
                        )
                        if text:
                            self.title = text[:60]
            await self.engine.hub.publish(self.session_id, event)
            await self.engine.on_session_event(self, event)

        harness.subscribe(on_event)
        try:
            async for _ in harness.prompt(content):
                pass
        finally:
            self._harness = None

    def cancel(self) -> None:
        if self._harness is not None:
            self._harness.cancel()

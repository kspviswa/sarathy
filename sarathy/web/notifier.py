"""Web notification fan-out: SSE streaming plus unread badge counts."""

from __future__ import annotations

import asyncio
import dataclasses
import json
from typing import Any

from tau_agent.events import MessageEndEvent
from tau_agent.messages import AssistantMessage

from sarathy.engine.events import NotifyEvent

_VIRTUAL = "@notifications"


class Notifier:
    """Tracks unread counts and broadcasts resolved events to SSE clients."""

    def __init__(self, engine) -> None:
        self.engine = engine
        self.unread: dict[str, int] = {}
        self._queues: set[asyncio.Queue] = set()
        self._sub = engine.hub.subscribe(self._on_event)

    # -- unread bookkeeping ---------------------------------------------------
    def mark_read(self, session_id: str) -> None:
        self.unread.pop(session_id, None)
        self.unread.pop(_VIRTUAL, None)

    def counts(self) -> dict[str, Any]:
        per_session = {sid: n for sid, n in self.unread.items() if n > 0}
        return {
            "total": sum(per_session.values()),
            "per_session": per_session,
        }

    # -- SSE ------------------------------------------------------------------
    def subscribe(self) -> asyncio.Queue:
        queue: asyncio.Queue = asyncio.Queue(maxsize=512)
        self._queues.add(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        self._queues.discard(queue)

    async def iter_events(self):
        """Async generator yielding SSE frames for one subscriber."""
        queue = self.subscribe()
        try:
            while True:
                try:
                    session_id, event = await asyncio.wait_for(queue.get(), timeout=25.0)
                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"
                    continue
                yield encode_sse(session_id, event)
        finally:
            self.unsubscribe(queue)

    # -- engine hook ----------------------------------------------------------
    async def _on_event(self, session_id: str, event: object) -> None:
        if isinstance(event, MessageEndEvent) and isinstance(event.message, AssistantMessage):
            # ignore h-andled empty "run" markers; assistant drafts count as unread
            self.unread[session_id] = self.unread.get(session_id, 0) + 1
        elif isinstance(event, NotifyEvent) and event.level in {"info", "success", "warning", "error"}:
            self.unread[_VIRTUAL] = self.unread.get(_VIRTUAL, 0) + 1
        payload = (session_id, event)
        for queue in list(self._queues):
            try:
                queue.put_nowait(payload)
            except asyncio.QueueFull:
                pass


def encode_sse(session_id: str, event: object) -> str:
    """Serialize an engine event to an SSE frame."""
    event_type = getattr(event, "type", type(event).__name__)
    try:
        if dataclasses.is_dataclass(event) and not isinstance(event, type):
            data = dataclasses.asdict(event)
        else:
            data = event.model_dump(mode="json")  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001
        data = {"raw": str(event)}
    data["session_id"] = session_id
    return f"event: {event_type}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


__all__ = ["Notifier", "encode_sse"]

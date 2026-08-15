"""Asynchronous pub-sub hub and sarathy-level run markers."""

from __future__ import annotations

from contextlib import suppress
from dataclasses import dataclass
from inspect import isawaitable
from typing import Any, Callable


class EventHub:
    """Broadcast (session_id, event) pairs to subscribed listeners."""

    def __init__(self) -> None:
        self._listeners: list[Callable[..., Any]] = []

    def subscribe(self, listener: Callable[..., Any]) -> Callable[[], None]:
        self._listeners.append(listener)

        def unsubscribe() -> None:
            with suppress(ValueError):
                self._listeners.remove(listener)

        return unsubscribe

    async def publish(self, session_id: str, event: object) -> None:
        for listener in list(self._listeners):
            try:
                result = listener(session_id, event)
                if isawaitable(result):
                    await result
            except Exception:  # noqa: BLE001 - a listener must never break the engine
                pass


@dataclass(frozen=True, slots=True)
class RunStart:
    """Marker: a new user prompt was accepted for this session."""

    type: str = "run_start"
    content: str = ""


@dataclass(frozen=True, slots=True)
class RunEnd:
    """Marker: the agent finished / was interrupted for this session."""

    type: str = "run_end"


@dataclass(frozen=True, slots=True)
class SessionCreated:
    """Marker: a new session was created."""

    type: str = "session_created"
    session_id: str = ""


@dataclass(frozen=True, slots=True)
class NotifyEvent:
    """Marker: a user-facing notification (archivist, cron, extensions)."""

    type: str = "notify"
    message: str = ""
    level: str = "info"

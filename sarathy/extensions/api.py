"""Extension-facing API and hook payloads (Pi-compatible subset)."""

from __future__ import annotations

from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Literal

from tau_agent.messages import AgentMessage, ToolResultMessage
from tau_agent.tools import AgentTool, AgentToolResult
from tau_agent.types import JSONValue

if TYPE_CHECKING:
    from sarathy.extensions.host import ExtensionHost

AGENT_EVENT_TYPES = frozenset(
    {
        "agent_start",
        "agent_end",
        "agent_settled",
        "turn_start",
        "turn_end",
        "message_start",
        "message_update",
        "message_end",
        "tool_execution_start",
        "tool_execution_update",
        "tool_execution_end",
        "session_start",
        "session_shutdown",
        "session_created",
        "run_start",
        "run_end",
    }
)
LIFECYCLE_EVENT_TYPES = frozenset({"input", "tool_call", "tool_result"})

ExtensionHandler = Callable[[object, "ExtensionContext"], object | Awaitable[object]]
ExtensionCommandHandler = Callable[["str", "ExtensionCommandContext"], "str | None"]


class ExtensionError(RuntimeError):
    """Raised when an extension misuses the API."""


@dataclass(frozen=True, slots=True)
class TurnStartEvent:
    type: Literal["turn_start"] = field(default="turn_start", init=False)
    turn_index: int = 0


@dataclass(frozen=True, slots=True)
class TurnEndEvent:
    type: Literal["turn_end"] = field(default="turn_end", init=False)
    turn_index: int = 0
    message: AgentMessage | None = None
    tool_results: list[ToolResultMessage] = field(default_factory=list)


@dataclass(frozen=True, slots=True)
class SessionStartEvent:
    type: Literal["session_start"] = field(default="session_start", init=False)
    reason: str = "startup"


@dataclass(frozen=True, slots=True)
class SessionShutdownEvent:
    type: Literal["session_shutdown"] = field(default="session_shutdown", init=False)
    reason: str = "quit"


@dataclass(frozen=True, slots=True)
class InputEvent:
    type: Literal["input"] = field(default="input", init=False)
    text: str = ""
    source: str = "interactive"
    streaming_behavior: str | None = None


@dataclass(frozen=True, slots=True)
class InputHookResult:
    action: Literal["continue", "transform", "handled"] = "continue"
    text: str | None = None
    message: str | None = None


@dataclass(frozen=True, slots=True)
class ToolCallHookEvent:
    type: Literal["tool_call"] = field(default="tool_call", init=False)
    tool_name: str = ""
    arguments: Mapping[str, JSONValue] = field(default_factory=dict)


@dataclass(frozen=True, slots=True)
class ToolCallHookResult:
    block: bool = False
    reason: str | None = None
    arguments: Mapping[str, JSONValue] | None = None


@dataclass(frozen=True, slots=True)
class ToolResultHookEvent:
    type: Literal["tool_result"] = field(default="tool_result", init=False)
    tool_name: str = ""
    arguments: Mapping[str, JSONValue] = field(default_factory=dict)
    result: AgentToolResult = field(default_factory=AgentToolResult)


@dataclass(frozen=True, slots=True)
class ToolResultHookResult:
    content: str | None = None
    details: dict[str, JSONValue] | None = None


@dataclass(frozen=True, slots=True)
class ExtensionCommandContext:
    name: str
    args: str
    api: "ExtensionAPI"


class ExtensionUi:
    """Minimal UI facade (no-op dialogs when a frontend is absent)."""

    def __init__(self, api: "ExtensionAPI") -> None:
        self._api = api

    @property
    def has_ui(self) -> bool:
        return False

    def notify(self, message: str, level: str = "info") -> None:
        self._api.notify(message, level)


class ExtensionContext:
    """Read-only session context handed to extension handlers."""

    def __init__(self, api: "ExtensionAPI", session_id: str | None = None) -> None:
        self._api = api
        self._session_id = session_id

    @property
    def cwd(self) -> Path:
        return self._api.engine.workspace

    @property
    def model(self) -> str:
        return self._api.engine.model

    @property
    def provider_name(self) -> str:
        return self._api.engine.provider_name

    @property
    def session_id(self) -> str | None:
        return self._session_id

    @property
    def is_running(self) -> bool:
        return bool(self._session_id and self._api.engine.get_session(self._session_id).running)

    @property
    def transcript(self) -> tuple[AgentMessage, ...]:
        if not self._session_id:
            return ()
        session = self._api.engine.get_session(self._session_id)
        return tuple(session.last_messages)

    @property
    def ui(self) -> ExtensionUi:
        return ExtensionUi(self._api)


class ExtensionAPI:
    """The object handed to each extension's `setup(sarathy)` entry point."""

    def __init__(self, host: "ExtensionHost", engine, name: str) -> None:
        self._host = host
        self.engine = engine
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    @property
    def context(self) -> ExtensionContext:
        return ExtensionContext(self)

    def register_tool(self, tool: AgentTool) -> None:
        self._host.register_tool(self._name, tool)

    def register_command(
        self,
        name: str,
        handler: ExtensionCommandHandler,
        *,
        description: str = "",
        usage: str | None = None,
        aliases: tuple[str, ...] = (),
    ) -> None:
        self._host.register_command(
            self._name, name, handler, description=description, usage=usage, aliases=aliases
        )

    def add_prompt_guideline(self, guideline: str) -> None:
        self._host.register_guideline(self._name, guideline)

    def on(
        self, event: str, handler: ExtensionHandler | None = None
    ) -> Callable[[ExtensionHandler], ExtensionHandler] | ExtensionHandler:
        if handler is not None:
            self._host.subscribe(self._name, event, handler)
            return handler

        def decorator(decorated: ExtensionHandler) -> ExtensionHandler:
            self._host.subscribe(self._name, event, decorated)
            return decorated

        return decorator

    def send_user_message(self, content: str, *, deliver_as: str = "follow_up") -> None:
        self._host.send_user_message(content, deliver_as=deliver_as)

    def append_entry(self, namespace: str, data: dict[str, JSONValue]) -> None:
        self._host.append_entry(namespace, data)

    def notify(self, message: str, level: str = "info") -> None:
        self._host.notify(message, level)


# public re-exports for README/docs parity
__all__ = [
    "ExtensionAPI",
    "ExtensionContext",
    "ExtensionCommandContext",
    "ExtensionError",
    "ExtensionHandler",
    "ExtensionCommandHandler",
    "InputEvent",
    "InputHookResult",
    "ToolCallHookEvent",
    "ToolCallHookResult",
    "ToolResultHookEvent",
    "ToolResultHookResult",
    "TurnStartEvent",
    "TurnEndEvent",
    "SessionStartEvent",
    "SessionShutdownEvent",
]

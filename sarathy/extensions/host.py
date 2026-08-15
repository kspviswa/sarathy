"""ExtensionHost: loads Pi-style extensions and wires them into the engine.

An extension module exposes a sync ``setup(sarathy)`` entry point receiving an
:class:`sarathy.extensions.api.ExtensionAPI`. Hooks registered via ``.on`` use
the tau event types (agent/turn/message/tool) plus the lifecycle types
``input``, ``tool_call``, ``tool_result``.
"""

from __future__ import annotations

import asyncio
import importlib.util
import shutil
import subprocess
import tempfile
from pathlib import Path
from typing import TYPE_CHECKING, Any, Callable

from loguru import logger
from tau_agent.events import (
    AgentEvent,
    TurnEndEvent,
    TurnStartEvent,
)
from tau_agent.messages import TextContent, ToolCall
from tau_agent.tools import AgentTool, AgentToolResult

from sarathy.extensions.api import (
    AGENT_EVENT_TYPES,
    LIFECYCLE_EVENT_TYPES,
    ExtensionAPI,
    ExtensionCommandContext,
    InputEvent,
    InputHookResult,
    ToolCallHookEvent,
    ToolCallHookResult,
    ToolResultHookEvent,
    ToolResultHookResult,
)
from sarathy.extensions.api import (
    TurnEndEvent as WireTurnEnd,
)
from sarathy.extensions.api import (
    TurnStartEvent as WireTurnStart,
)
from sarathy.extensions.loader import DiscoveredExtension, discover

if TYPE_CHECKING:
    from sarathy.extensions.api import ExtensionCommandHandler, ExtensionHandler


class ExtensionHost:
    """Loads extensions and exposes their hooks to the agent loop."""

    def __init__(self, engine=None) -> None:
        self.engine = engine
        self._extensions: dict[str, ExtensionAPI] = {}
        self._tools: dict[str, AgentTool] = {}
        self._commands: dict[str, tuple] = {}
        self._aliases: dict[str, str] = {}
        self._guidelines: list[str] = []
        self._handlers: dict[str, list[tuple[str, ExtensionHandler]]] = {}

    # ================================================================== loading
    def load(self, data_dir: Path, workspace: Path | None = None) -> None:
        """(Re)load extensions; clears previously registered state."""
        self._extensions.clear()
        self._tools.clear()
        self._commands.clear()
        self._aliases.clear()
        self._guidelines.clear()
        self._handlers.clear()

        discovered = discover(data_dir, workspace)
        for ext in discovered:
            self._load_extension(ext)

        logger.info(
            "extensions: {} ({} tools, {} commands)",
            len(self._extensions),
            len(self._tools),
            len(self._commands),
        )

    def _load_extension(self, discovered: DiscoveredExtension) -> None:
        name = discovered.name
        path = discovered.path
        package_dir = discovered.package_dir
        if path.is_dir():
            entry = path / "extension.py"
            if not entry.exists():
                entry = path / "__init__.py"
        else:
            entry = path
        if not entry.exists():
            logger.warning("extension {} has no usable entry point", name)
            return

        module_name = f"sarathy_extensions__{name}"
        search_locations = [str(package_dir)] if package_dir is not None else None
        spec = importlib.util.spec_from_file_location(
            module_name, entry, submodule_search_locations=search_locations
        )
        if spec is None or spec.loader is None:
            logger.error("could not import extension {}", name)
            return
        module = importlib.util.module_from_spec(spec)
        import sys

        sys.modules[module_name] = module
        try:
            spec.loader.exec_module(module)
        except Exception as exc:  # noqa: BLE001
            sys.modules.pop(module_name, None)
            logger.error("extension {} failed to import: {}", name, exc)
            return

        setup = getattr(module, "setup", None)
        if not callable(setup):
            sys.modules.pop(module_name, None)
            logger.warning("extension {} has no setup() entry point", name)
            return
        if asyncio.iscoroutinefunction(setup):
            sys.modules.pop(module_name, None)
            logger.warning("extension {} setup() must be a sync function", name)
            return

        api = ExtensionAPI(self, self.engine, name)
        try:
            setup(api)
        except Exception as exc:  # noqa: BLE001
            logger.error("extension {} setup() failed: {}", name, exc)
            return
        self._extensions[name] = api
        logger.info("loaded extension {}", name)

    # ================================================================== registration (called by ExtensionAPI)
    def register_tool(self, namespace: str, tool: AgentTool) -> None:
        existing = self._tools.get(tool.name)
        if existing is not None and existing != tool:
            raise RuntimeError(f"tool '{tool.name}' already registered")
        self._tools[tool.name] = tool

    def register_command(
        self,
        namespace: str,
        name: str,
        handler: ExtensionCommandHandler,
        *,
        description: str = "",
        usage: str | None = None,
        aliases: tuple[str, ...] = (),
    ) -> None:
        for alias in (name,) + tuple(aliases):
            if alias in self._commands or alias in self._aliases:
                raise RuntimeError(f"command '/{alias}' already registered")
        self._commands[name] = (namespace, handler, description, usage, tuple(aliases))
        for alias in aliases:
            self._aliases[alias] = name

    def register_guideline(self, namespace: str, guideline: str) -> None:
        self._guidelines.append(guideline)

    def subscribe(self, namespace: str, event: str, handler: ExtensionHandler) -> None:
        if event not in AGENT_EVENT_TYPES and event not in LIFECYCLE_EVENT_TYPES:
            raise ValueError(f"unknown extension event '{event}'")
        self._handlers.setdefault(event, []).append((namespace, handler))

    # ================================================================== lifecycle hooks
    async def run_input_hooks(self, content: str) -> tuple[str, str | None]:
        """Run lifecycle `input` hooks; returns (transformed_text, handled_message)."""
        for _namespace, handler in list(self._handlers.get("input", ())):
            event = InputEvent(text=content)
            result = await self._invoke(handler, event)
            if isinstance(result, InputHookResult):
                if result.action == "handled":
                    return "", result.message or ""
                if result.action == "transform" and result.text is not None:
                    content = result.text
        return content, None

    async def before_tool_call(self, call: ToolCall) -> tuple[bool, str | None]:
        """tau before_tool_call: extension tool_call hooks gate/rewrite arguments."""
        for _namespace, handler in list(self._handlers.get("tool_call", ())):
            event = ToolCallHookEvent(tool_name=call.name, arguments=dict(call.arguments))
            result = await self._invoke(handler, event)
            if isinstance(result, ToolCallHookResult):
                if result.block:
                    return False, result.reason or f"blocked tool {call.name}"
                if result.arguments is not None:
                    call.arguments = dict(result.arguments)
        return True, None

    async def after_tool_call(
        self, call: ToolCall, result: AgentToolResult, is_error: bool
    ) -> tuple[AgentToolResult, bool]:
        """tau after_tool_call: extension tool_result hooks may rewrite the result."""
        for _namespace, handler in list(self._handlers.get("tool_result", ())):
            event = ToolResultHookEvent(
                tool_name=call.name, arguments=dict(call.arguments), result=result
            )
            hook_result = await self._invoke(handler, event)
            if isinstance(hook_result, ToolResultHookResult):
                if hook_result.content is not None:
                    result = AgentToolResult(
                        content=[TextContent(text=hook_result.content)],
                        details=hook_result.details if hook_result.details is not None else result.details,
                        terminate=result.terminate,
                    )
        return result, is_error

    async def _invoke(self, handler: ExtensionHandler, wire_event: Any) -> Any:
        result = handler(wire_event, self._context())
        if asyncio.iscoroutine(result) or hasattr(result, "__await__"):
            result = await result
        return result

    # ================================================================== event dispatch
    async def dispatch(self, session_id: str, event: AgentEvent) -> None:
        """Convert tau events to extension events and call matching handlers."""
        wire = self._to_extension_event(event)
        if wire is None:
            return
        context = self._context(session_id)
        for target in (wire.type, "agent_event"):
            for _namespace, handler in list(self._handlers.get(target, ())):
                try:
                    result = handler(wire, context)
                    if asyncio.iscoroutine(result) or hasattr(result, "__await__"):
                        await result
                except Exception as exc:  # noqa: BLE001
                    logger.error("extension handler '{}' error: {}", target, exc)

    @staticmethod
    def _to_extension_event(event: AgentEvent) -> AgentEvent | object | None:
        if isinstance(event, TurnStartEvent):
            return WireTurnStart(turn_index=getattr(event, "turn_index", 0))
        if isinstance(event, TurnEndEvent):
            return WireTurnEnd(
                turn_index=getattr(event, "turn_index", 0),
                message=getattr(event, "message", None),
                tool_results=list(getattr(event, "tool_results", []) or []),
            )
        if event.type in AGENT_EVENT_TYPES:
            return event
        return None

    def _context(self, session_id: str | None = None):
        api = next(iter(self._extensions.values()), None)
        if api is None:
            return None
        from sarathy.extensions.api import ExtensionContext

        return ExtensionContext(api, session_id)

    # ================================================================== management
    def install(self, url: str, data_dir: Path) -> str:
        """Clone a git repo into the extensions directory and reload."""
        name = url.rstrip("/").split("/")[-1].replace(".git", "")
        target = Path(data_dir) / "extensions" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists():
            raise RuntimeError(f"extension {name} already installed")
        tmp = Path(tempfile.mkdtemp(prefix="sarathy_ext_"))
        try:
            result = subprocess.run(
                ["git", "clone", "--depth", "1", url, str(tmp / name)],
                capture_output=True,
                text=True,
            )
            if result.returncode != 0:
                raise RuntimeError(f"git clone failed: {result.stderr.strip()}")
            shutil.move(str(tmp / name), str(target))
        finally:
            shutil.rmtree(tmp, ignore_errors=True)
        self.reload(data_dir)
        return str(target)

    def uninstall(self, name: str, data_dir: Path) -> None:
        shutil.rmtree(Path(data_dir) / "extensions" / name, ignore_errors=True)
        self.reload(data_dir)

    def reload(self, data_dir: Path) -> None:
        self.load(data_dir, self.engine.workspace if self.engine else None)

    # ================================================================== exposed state
    def list_extensions(self) -> list[dict]:
        return [
            {
                "name": name,
                "tools": [t.name for t in self._tools.values()],
                "commands": sorted(self._commands),
                "guidelines": len(self._guidelines),
            }
            for name in self._extensions
        ]

    @property
    def tools(self) -> list[AgentTool]:
        return list(self._tools.values())

    @property
    def guidelines(self) -> list[str]:
        return list(self._guidelines)

    @property
    def commands(self) -> dict[str, Callable[[str, ExtensionCommandContext], str | None]]:
        def runner(command_name: str, args: str) -> str | None:
            return self.run_command(command_name, args)

        return {name: runner for name in self._commands}

    async def run_command(self, name: str, args: str) -> str | None:
        primary = self._aliases.get(name, name)
        entry = self._commands.get(primary)
        if entry is None:
            return None
        _namespace, handler, _desc, _usage, _aliases = entry
        api = self._extensions.get(_namespace)
        if api is None:
            return None
        ctx = ExtensionCommandContext(name=primary, args=args, api=api)
        result = handler(args, ctx)
        if asyncio.iscoroutine(result) or hasattr(result, "__await__"):
            return await result
        return result

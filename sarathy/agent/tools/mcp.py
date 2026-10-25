"""MCP client: connects to MCP servers and wraps their tools as native sarathy tools.

Design rule (2026-10-25): an MCP server that is down, misconfigured or simply
absent MUST NEVER block the assistant. Every server is connected inside its own
bounded timeout and its own exit stack; a failure is recorded and skipped, the
remaining servers still connect, and the agent carries on with fewer tools.

The outcome of the last connection attempt is persisted to
``<data_dir>/mcp_status.json`` so that out-of-process consumers — the
``sarathy gateway status`` CLI and the dashboard ``/api/status`` — can show the
user which servers are broken instead of failing silently in the logs.
"""

import asyncio
import json
import time
from contextlib import AsyncExitStack
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
from loguru import logger

from sarathy.agent.tools.base import Tool
from sarathy.agent.tools.registry import ToolRegistry

DEFAULT_CONNECT_TIMEOUT = 10.0
"""Seconds allowed for one server's transport + handshake + tool listing."""

MCP_STATUS_FILE = "mcp_status.json"

OK = "ok"
ERROR = "error"
TIMEOUT = "timeout"


# ---------------------------------------------------------------------------
# Persisted health record
# ---------------------------------------------------------------------------


def get_mcp_status_path() -> Path:
    from sarathy.utils.helpers import get_data_path

    return get_data_path() / MCP_STATUS_FILE


def empty_status() -> dict[str, Any]:
    return {"checked_at": None, "servers": {}}


def read_mcp_status() -> dict[str, Any]:
    """Read the last recorded MCP health snapshot. Never raises."""
    path = get_mcp_status_path()
    try:
        data = json.loads(path.read_text())
        if not isinstance(data, dict):
            return empty_status()
        data.setdefault("checked_at", None)
        if not isinstance(data.get("servers"), dict):
            data["servers"] = {}
        return data
    except Exception:
        return empty_status()


def write_mcp_status(servers: dict[str, dict[str, Any]]) -> None:
    """Atomically persist the health snapshot. Never raises."""
    payload = {"checked_at": _now(), "servers": servers}
    path = get_mcp_status_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, indent=2))
        tmp.replace(path)
    except Exception as e:  # pragma: no cover - disk problems must not break a turn
        logger.warning("MCP: could not write status file {}: {}", path, e)


def failing_servers(status: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """Return the recorded servers whose last attempt failed."""
    snapshot = status if status is not None else read_mcp_status()
    out = []
    for name, entry in (snapshot.get("servers") or {}).items():
        if not isinstance(entry, dict):
            continue
        if entry.get("status") != OK:
            out.append({"name": name, **entry})
    return out


def _now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Tools
# ---------------------------------------------------------------------------


class MCPToolWrapper(Tool):
    """Wraps a single MCP server tool as a sarathy Tool."""

    def __init__(self, session, server_name: str, tool_def, tool_timeout: int = 30):
        self._session = session
        self._original_name = tool_def.name
        self._name = f"mcp_{server_name}_{tool_def.name}"
        self._description = tool_def.description or tool_def.name
        self._parameters = tool_def.inputSchema or {"type": "object", "properties": {}}
        self._tool_timeout = tool_timeout

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._description

    @property
    def parameters(self) -> dict[str, Any]:
        return self._parameters

    async def execute(self, **kwargs: Any) -> str:
        from mcp import types

        try:
            result = await asyncio.wait_for(
                self._session.call_tool(self._original_name, arguments=kwargs),
                timeout=self._tool_timeout,
            )
        except asyncio.TimeoutError:
            logger.warning("MCP tool '{}' timed out after {}s", self._name, self._tool_timeout)
            return f"(MCP tool call timed out after {self._tool_timeout}s)"
        parts = []
        for block in result.content:
            if isinstance(block, types.TextContent):
                parts.append(block.text)
            else:
                parts.append(str(block))
        return "\n".join(parts) or "(no output)"


# ---------------------------------------------------------------------------
# Connection
# ---------------------------------------------------------------------------


async def _connect_server(
    name: str, cfg, registry: ToolRegistry, stack: AsyncExitStack
) -> int:
    """Open one server's transport + session and register its tools.

    Returns the number of tools registered. Raises on any failure — the caller
    owns the timeout and the cleanup.
    """
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    if cfg.command:
        params = StdioServerParameters(command=cfg.command, args=cfg.args, env=cfg.env or None)
        read, write = await stack.enter_async_context(stdio_client(params))
    elif cfg.url:
        from mcp.client.streamable_http import streamable_http_client

        # Always provide an explicit httpx client so MCP HTTP transport does not
        # inherit httpx's default 5s timeout and preempt the higher-level timeout.
        http_client = await stack.enter_async_context(
            httpx.AsyncClient(
                headers=cfg.headers or None,
                follow_redirects=True,
                timeout=None,
            )
        )
        read, write, _ = await stack.enter_async_context(
            streamable_http_client(cfg.url, http_client=http_client)
        )
    else:
        raise ValueError("no command or url configured")

    session = await stack.enter_async_context(ClientSession(read, write))
    await session.initialize()

    tools = await session.list_tools()
    for tool_def in tools.tools:
        wrapper = MCPToolWrapper(session, name, tool_def, tool_timeout=cfg.tool_timeout)
        registry.register(wrapper)
        logger.debug("MCP: registered tool '{}' from server '{}'", wrapper.name, name)
    return len(tools.tools)


async def _close_quietly(stack: AsyncExitStack) -> None:
    try:
        await stack.aclose()
    except BaseException:  # includes CancelledError from a cancelled transport
        pass


async def connect_mcp_servers(
    mcp_servers: dict, registry: ToolRegistry, stack: AsyncExitStack
) -> dict[str, dict[str, Any]]:
    """Connect to configured MCP servers and register their tools.

    Each server is isolated: its own exit stack and its own ``connect_timeout``
    (``cfg.connect_timeout``, default 10s). A server that times out or errors is
    skipped — its stack is closed, the failure recorded, and the loop moves on.
    Successfully connected servers hand their stack to ``stack`` so the caller
    can close everything at shutdown.

    Everything runs in the *current* task on purpose. The MCP HTTP/stdio
    transports are anyio task groups, and entering one in task A while exiting
    it in task B raises "Attempted to exit cancel scope in a different task
    than it was entered in" — so no ``wait_for``/``create_task`` wrapper here;
    the deadline comes from ``asyncio.timeout``, which cancels in-task.

    Returns the health snapshot that was written to disk.
    """
    results: dict[str, dict[str, Any]] = {}

    for name, cfg in mcp_servers.items():
        timeout = float(getattr(cfg, "connect_timeout", DEFAULT_CONNECT_TIMEOUT) or 0)
        if timeout <= 0:
            timeout = DEFAULT_CONNECT_TIMEOUT

        server_stack = AsyncExitStack()
        await server_stack.__aenter__()
        started = time.monotonic()
        try:
            async with asyncio.timeout(timeout):
                tool_count = await _connect_server(name, cfg, registry, server_stack)
        except TimeoutError:
            await _close_quietly(server_stack)
            elapsed_ms = int((time.monotonic() - started) * 1000)
            message = f"connect timed out after {timeout:g}s"
            logger.error("MCP server '{}': {} — skipping", name, message)
            results[name] = {
                "status": TIMEOUT,
                "error": message,
                "tools": 0,
                "duration_ms": elapsed_ms,
                "checked_at": _now(),
            }
            continue
        except asyncio.CancelledError:
            await _close_quietly(server_stack)
            current = asyncio.current_task()
            if current is not None and current.cancelling():
                raise  # genuine shutdown — propagate
            # The transport cancelled itself: its background reader died (DNS
            # failure, connection refused, stream closed). Ordinary failure.
            elapsed_ms = int((time.monotonic() - started) * 1000)
            logger.error("MCP server '{}': connection aborted — skipping", name)
            results[name] = {
                "status": ERROR,
                "error": (
                    "connection aborted by the MCP transport "
                    "(endpoint unreachable or closed the stream)"
                ),
                "tools": 0,
                "duration_ms": elapsed_ms,
                "checked_at": _now(),
            }
            continue
        except Exception as e:
            await _close_quietly(server_stack)
            elapsed_ms = int((time.monotonic() - started) * 1000)
            logger.error("MCP server '{}': failed to connect: {} — skipping", name, e)
            results[name] = {
                "status": ERROR,
                "error": f"{type(e).__name__}: {e}",
                "tools": 0,
                "duration_ms": elapsed_ms,
                "checked_at": _now(),
            }
            continue

        # Success: the parent stack now owns the per-server stack.
        stack.push_async_callback(server_stack.aclose)
        elapsed_ms = int((time.monotonic() - started) * 1000)
        logger.info("MCP server '{}': connected, {} tools registered", name, tool_count)
        results[name] = {
            "status": OK,
            "error": "",
            "tools": tool_count,
            "duration_ms": elapsed_ms,
            "checked_at": _now(),
        }

    write_mcp_status(results)
    return results

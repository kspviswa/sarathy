"""Adapt sarathy's Tool implementations to tau_agent.AgentTool."""

from __future__ import annotations

from collections.abc import Mapping
from contextlib import AsyncExitStack

from loguru import logger
from tau_agent.messages import TextContent
from tau_agent.tools import (
    AgentTool,
    AgentToolResult,
    ToolCancellationToken,
    ToolUpdateCallback,
)
from tau_agent.types import JSONValue

from sarathy.agent.tools.base import Tool as SarathyTool
from sarathy.agent.tools.filesystem import EditFileTool, ListDirTool, ReadFileTool, WriteFileTool
from sarathy.agent.tools.shell import ExecTool
from sarathy.agent.tools.web import WebFetchTool, create_web_search_tool
from sarathy.config.schema import Config


def adapt_tool(tool: SarathyTool) -> AgentTool:
    """Wrap a sarathy Tool (returns str) as a tau AgentTool."""

    async def execute_fn(
        tool_call_id: str,
        arguments: Mapping[str, JSONValue],
        signal: ToolCancellationToken | None = None,
        on_update: ToolUpdateCallback | None = None,
    ) -> AgentToolResult:
        if on_update is not None:
            on_update(AgentToolResult(content=[TextContent(text="Working…")]))
        params = dict(arguments)
        try:
            output = await tool.execute(**params)
        except Exception:  # noqa: BLE001 - tools are an isolation boundary
            raise
        text = output if isinstance(output, str) else str(output)
        return AgentToolResult(content=[TextContent(text=text)] if text else [])

    return AgentTool(
        name=tool.name,
        label=tool.name,
        description=tool.description,
        parameters=dict(tool.parameters or {"type": "object", "properties": {}}),
        execute_fn=execute_fn,
        prompt_snippet=tool.description,
    )


def build_default_tools(config: Config, workspace) -> list[AgentTool]:
    """Build the sarathy default tool set as tau tools."""
    tools: list[SarathyTool] = [
        ReadFileTool(workspace=workspace),
        WriteFileTool(workspace=workspace),
        EditFileTool(workspace=workspace),
        ListDirTool(workspace=workspace),
        ExecTool(
            timeout=config.tools.exec.timeout,
            working_dir=str(workspace),
            restrict_to_workspace=config.tools.restrict_to_workspace,
            path_append=config.tools.exec.path_append or "",
        ),
        WebFetchTool(),
    ]

    ws = config.tools.web.search
    if ws.enabled:
        tools.append(create_web_search_tool(ws.provider, ws.api_key or None, ws.max_results))

    return [adapt_tool(tool) for tool in tools]


async def build_mcp_tools(
    config: Config, workspace, stack: AsyncExitStack
) -> list[AgentTool]:
    """Connect configured MCP servers and return their tools as AgentTools.

    ``stack`` is the engine-lifetime ``AsyncExitStack`` so connections outlive
    individual tool calls and are torn down on shutdown.
    """
    server_configs = config.tools.mcp_servers
    if not server_configs:
        return []

    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client

    from sarathy.agent.tools.mcp import MCPToolWrapper

    adapted: list[AgentTool] = []

    for name, cfg in server_configs.items():
        try:
            if cfg.command:
                params = StdioServerParameters(
                    command=cfg.command, args=cfg.args, env=cfg.env or None
                )
                read, write = await stack.enter_async_context(stdio_client(params))
            elif cfg.url:
                import httpx
                from mcp.client.streamable_http import streamable_http_client

                http_client = await stack.enter_async_context(
                    httpx.AsyncClient(
                        headers=cfg.headers or None, follow_redirects=True, timeout=None
                    )
                )
                read, write, _ = await stack.enter_async_context(
                    streamable_http_client(cfg.url, http_client=http_client)
                )
            else:
                logger.warning("MCP server '{}': no command or url, skipping", name)
                continue

            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
            tool_defs = (await session.list_tools()).tools
            for tool_def in tool_defs:
                wrapper = MCPToolWrapper(session, name, tool_def, cfg.tool_timeout)
                adapted.append(adapt_tool(wrapper))
            logger.info("MCP server '{}': {} tools", name, len(tool_defs))
        except Exception as exc:  # noqa: BLE001
            logger.error("MCP server '{}' failed: {}", name, exc)

    return adapted

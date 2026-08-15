"""Example extension: package-style layout.

Shows the directory form of an extension: a pyproject.toml declaring
[tool.tau] extensions = ["extension.py"], with the entry logic in
extension.py and a sibling helper module reached via relative import.
Copy this directory to ~/.sarathy/extensions/ to install.
"""

from __future__ import annotations

from tau_agent.messages import TextContent
from tau_agent.tools import AgentTool, AgentToolResult

from .helper import greet


def setup(sarathy):
    async def hello(tool_call_id, arguments, signal=None, on_update=None) -> AgentToolResult:
        name = arguments.get("name", "world")
        return AgentToolResult(content=[TextContent(text=greet(name))])

    sarathy.register_tool(
        AgentTool(
            name="hello",
            label="Hello",
            description="Greet someone by name.",
            parameters={
                "type": "object",
                "properties": {"name": {"type": "string"}},
            },
            execute_fn=hello,
        )
    )

    sarathy.register_command(
        "hello",
        lambda args, ctx: f"Hello from the echo-package extension. Args: {args}",
        description="Say hello.",
    )

"""Example extension: a tool + a slash command.

Copy this file to ~/.sarathy/extensions/ (or make it a directory with
extension.py / __init__.py) and run `sarathy` again — the tool and command
become available without restarting.

Shows:
- register_tool: an AgentTool whose execute_fn is invoked by the agent loop.
- register_command: a slash command usable from the REPL/web chat.
- add_prompt_guideline: a hint injected into the system prompt.
"""

from __future__ import annotations

from datetime import datetime, timezone

from tau_agent.messages import TextContent
from tau_agent.tools import AgentTool, AgentToolResult


def setup(sarathy):
    sarathy.add_prompt_guideline(
        "utc_now tool exists: prefer it for time-related questions."
    )

    # ---- tool ----------------------------------------------------------------
    async def utc_now(tool_call_id, arguments, signal=None, on_update=None) -> AgentToolResult:
        now = datetime.now(timezone.utc).isoformat()
        return AgentToolResult(content=[TextContent(text=f"Current UTC time: {now}")])

    sarathy.register_tool(
        AgentTool(
            name="utc_now",
            label="UTC Now",
            description="Return the current UTC date-time in ISO-8601 format.",
            parameters={"type": "object", "properties": {}},
            execute_fn=utc_now,
        )
    )

    # ---- command -------------------------------------------------------------
    def echo(args: str, ctx):
        return f"You said: '{args}'"

    sarathy.register_command(
        "echo",
        echo,
        description="Repeat the given text back to the user.",
        usage="/echo <text>",
        aliases=("say",),
    )

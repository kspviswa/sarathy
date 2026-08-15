"""Example extension: event hooks (input / tool_call / tool_result).

Hooks use the lifecycle event types. All handlers may be async; sarathy awaits
them. Return the hook result dataclasses to transform behaviour, or None.

- on("input"): see/rewrite user input before the model sees it.
- on("tool_call"): gate or rewrite tool arguments before execution.
- on("tool_result"): rewrite or annotate the result shown back to the model.
"""

from __future__ import annotations

from sarathy.extensions.api import (
    InputHookResult,
    ToolCallHookResult,
    ToolResultHookResult,
)


def setup(sarathy):
    # Transform every user message to start with a marker.
    @sarathy.on("input")
    def prefix_input(event, ctx):
        return InputHookResult(action="transform", text=f"[echo] {event.text}")

    # Block calls to a given tool (policy gate).
    @sarathy.on("tool_call")
    def block_tool(event, ctx):
        if event.tool_name in {"dangerous_tool", "rm_rf_everything"}:
            return ToolCallHookResult(block=True, reason="blocked by example policy")
        return None

    # Annotate file results with a marker.
    @sarathy.on("tool_result")
    def annotate_file_results(event, ctx):
        if event.tool_name == "read_file":
            body = event.result.text if event.result else ""
            return ToolResultHookResult(
                content=f"{body}\n(written by example hook)"
            )
        return None

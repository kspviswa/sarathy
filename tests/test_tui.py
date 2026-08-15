"""Textual chat TUI: hub-event streaming renders a clean transcript.

Drives the TUI headlessly with tau stream events (thinking/text deltas, tool
events, end markers) and asserts the transcript shows the final assistant
text, thinking, and tool output without any raw ANSI leaking to the display.
"""

from __future__ import annotations

import asyncio

from tau_agent.events import (
    MessageEndEvent,
    MessageStartEvent,
    MessageUpdateEvent,
    ToolExecutionEndEvent,
    ToolExecutionStartEvent,
)
from tau_agent.messages import AssistantMessage, TextContent
from tau_ai.events import TextDeltaEvent, ThinkingDeltaEvent
from textual.widgets import Markdown

from sarathy.engine.events import RunEnd
from sarathy.engine.tui import SarathyChatApp


def _assistant(text: str) -> AssistantMessage:
    return AssistantMessage(role="assistant", content=[TextContent(text=text)])


async def _render(app: SarathyChatApp) -> str:
    """Return the transcript's combined markdown body + rendered statics."""
    transcript = app.query_one("#transcript")
    markdown_body = "".join(
        getattr(c, "_markdown", None) or "" for c in transcript.children if isinstance(c, Markdown)
    )
    statics = " | ".join(str(c.render()) for c in transcript.children)
    return f"{markdown_body}\n{statics}"


async def test_tui_streams_assistant_deltas_and_tools(make_engine, tmp_path) -> None:
    engine = await make_engine(tmp_path)
    app = SarathyChatApp(engine, session_id="tui-test")

    async with app.run_test(size=(120, 40)):
        sid = "tui-test"
        hub = engine.hub
        p1 = _assistant("Let me think…")
        p2 = _assistant("The answer is 42.")

        await hub.publish(sid, MessageStartEvent(message=p1))
        await hub.publish(sid, MessageUpdateEvent(
            message=p1,
            assistant_message_event=ThinkingDeltaEvent(content_index=0, delta="hmm", partial=p1),
        ))
        await hub.publish(sid, MessageUpdateEvent(
            message=p1,
            assistant_message_event=TextDeltaEvent(content_index=0, delta="The answer is ", partial=p1),
        ))
        await hub.publish(sid, MessageUpdateEvent(
            message=p2,
            assistant_message_event=TextDeltaEvent(content_index=0, delta="42.", partial=p2),
        ))
        await hub.publish(sid, MessageEndEvent(message=p2))
        await hub.publish(sid, ToolExecutionStartEvent(
            tool_call_id="c1", tool_name="exec", args={}
        ))
        await hub.publish(sid, ToolExecutionEndEvent(
            tool_call_id="c1",
            tool_name="exec",
            result={"content": [{"text": "hello-from-tui"}]},
            is_error=False,
        ))
        await hub.publish(sid, RunEnd())

        await asyncio.sleep(1.0)

        rendered = await _render(app)
        assert "The answer is 42." in rendered, rendered
        assert "hmm" in rendered, rendered
        assert "exec" in rendered and "hello-from-tui" in rendered, rendered
        assert "[36m" not in rendered and "\\x1b" not in rendered, "raw ANSI leaked"


async def test_tui_ignores_other_sessions(make_engine, tmp_path) -> None:
    engine = await make_engine(tmp_path)
    app = SarathyChatApp(engine, session_id="tui-a")

    async with app.run_test(size=(120, 40)):
        await engine.hub.publish(
            "tui-b",
            MessageEndEvent(message=_assistant("should-not-appear")),
        )
        await asyncio.sleep(0.5)
        rendered = await _render(app)
        assert "should-not-appear" not in rendered, rendered

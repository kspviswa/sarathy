"""Textual chat TUI built on Tau's rendering layer: hub events render a clean transcript.

Drives the TUI headlessly with tau stream events (thinking/text deltas, tool
events, end markers) and asserts the transcript shows the final assistant text,
thinking (after Ctrl+T), and tool output (after Ctrl+O) without any raw ANSI
leaking to the display.
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

from sarathy.engine.events import RunEnd
from sarathy.engine.tui import SarathyChatApp


def _assistant(text: str) -> AssistantMessage:
    return AssistantMessage(role="assistant", content=[TextContent(text=text)])


def _assistant_with_thinking(thinking: str, text: str) -> AssistantMessage:
    from tau_agent.messages import ThinkingContent

    return AssistantMessage(
        role="assistant",
        content=[ThinkingContent(thinking=thinking), TextContent(text=text)],
    )


def _transcript_text(app: SarathyChatApp) -> str:
    """Return the visible (selection) text of all transcript widgets."""
    transcript = app.query_one("#transcript")
    parts = [
        getattr(child, "selection_text", "")
        for child in transcript.children
        if getattr(child, "selection_text", None)
    ]
    return "\n".join(parts)


async def test_tui_streams_assistant_deltas_and_tools(make_engine, tmp_path) -> None:
    engine = await make_engine(tmp_path)
    app = SarathyChatApp(engine, session_id="tui-test")

    async with app.run_test(size=(120, 40)):
        sid = "tui-test"
        hub = engine.hub
        p1 = _assistant_with_thinking("hmm", "The answer is 42.")
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
        await hub.publish(sid, MessageEndEvent(message=p1))
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

        visible = _transcript_text(app)
        assert "The answer is 42." in visible, visible
        assert "exec" in visible, visible
        assert "[36m" not in visible and "\\x1b" not in visible, "raw ANSI leaked"

        app.action_toggle_thinking()
        await asyncio.sleep(0.3)
        visible = _transcript_text(app)
        assert "hmm" in visible, visible

        app.action_toggle_tool_results()
        await asyncio.sleep(0.5)
        visible = _transcript_text(app)
        assert "hello-from-tui" in visible, visible


async def test_tui_ignores_other_sessions(make_engine, tmp_path) -> None:
    engine = await make_engine(tmp_path)
    app = SarathyChatApp(engine, session_id="tui-a")

    async with app.run_test(size=(120, 40)):
        await engine.hub.publish(
            "tui-b",
            MessageEndEvent(message=_assistant("should-not-appear")),
        )
        await asyncio.sleep(0.5)
        visible = _transcript_text(app)
        assert "should-not-appear" not in visible, visible

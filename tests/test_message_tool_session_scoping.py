"""MessageTool send tracking must be scoped per session.

Concurrent dispatch tasks (telegram turn + backend job turn) share ONE
MessageTool instance. Before session scoping, a backend turn's relay polluted
the shared _turn_sends, so the telegram turn's final response was suppressed
as a false duplicate — the job 118/119 collision that ate Viswa's reply
(2026-10-05, KB #418).
"""

from __future__ import annotations

import asyncio

from sarathy.agent.tools.message import MessageTool
from sarathy.bus.events import OutboundMessage


def _make_tool() -> MessageTool:
    sent: list[OutboundMessage] = []

    async def _cb(msg: OutboundMessage) -> None:
        sent.append(msg)

    return MessageTool(send_callback=_cb, channels_config=type("C", (), {})())


def test_same_session_send_is_visible_to_suppression_check() -> None:
    """Intended behaviour: a message-tool send and final response in the SAME
    session/turn are seen as duplicates (suppression may fire)."""
    tool = _make_tool()
    tool.start_turn()
    tool.set_context("telegram", "5878545507", session_key="telegram:5878545507")

    asyncio.run(tool.execute(content="relay", channel="telegram", chat_id="5878545507"))

    sends = tool.get_turn_sends(session_key="telegram:5878545507")
    assert ("telegram", "5878545507") in sends


def test_other_session_send_is_invisible_to_suppression_check() -> None:
    """THE BUG: a backend job turn's relay to telegram must NOT look like a
    send from the telegram session. Otherwise the telegram turn's final
    response gets suppressed as a false duplicate."""
    tool = _make_tool()
    # Telegram turn starts, does work (no message-tool sends).
    tool.start_turn()
    tool.set_context("telegram", "5878545507", session_key="telegram:5878545507")

    # Concurrent backend job turn starts (start_turn resets the shared list),
    # relays to telegram, and finishes.
    tool.start_turn()
    tool.set_context("backend", "119", session_key="backend:job-119")
    asyncio.run(tool.execute(content="job 119 relay", channel="telegram", chat_id="5878545507"))

    # Back to the telegram turn's final-response suppression check.
    sends = tool.get_turn_sends(session_key="telegram:5878545507")
    assert ("telegram", "5878545507") not in sends
    assert sends == []


def test_unscoped_get_turn_sends_still_returns_everything() -> None:
    """The btw-turn save/restore path uses the raw list — the unscoped view
    must keep returning the current list so state can be saved/restored."""
    tool = _make_tool()
    tool.start_turn()
    tool.set_context("backend", "119", session_key="backend:job-119")
    asyncio.run(tool.execute(content="b", channel="telegram", chat_id="5878545507"))

    # Raw storage keeps the session key; the view exposes (channel, chat_id).
    assert tool._turn_sends == [("telegram", "5878545507", "backend:job-119")]
    assert tool.get_turn_sends() == [("telegram", "5878545507")]
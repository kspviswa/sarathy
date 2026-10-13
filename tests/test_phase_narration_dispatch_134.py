"""Spec 134 §A — pipeline narration must survive the outbound dispatcher.

The image→VLM phases ("🔍 Sending image to VLM…", "✅ Image description
received") are published as `tool_hint=True` progress frames so the dashboard's
live-status strip can show them. But `ChannelManager._dispatch_outbound` drops
every `_tool_hint` frame while `channels.send_tool_hints` is False — and it
defaults to False — so the narration never reached ANY channel.

These tests pin the fix at the level the earlier unit tests missed: the
dispatcher filter, not the loop's emission.
"""

from __future__ import annotations

import asyncio

import pytest

from sarathy.bus.events import OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.channels.manager import ChannelManager
from sarathy.config.schema import Config


class _FakeChannel:
    def __init__(self) -> None:
        self.sent: list[OutboundMessage] = []

    async def send(self, msg: OutboundMessage) -> None:
        self.sent.append(msg)


def _manager() -> tuple[ChannelManager, _FakeChannel]:
    cfg = Config()
    for ch in ("telegram", "discord", "email", "dashboard", "backend"):
        setattr(getattr(cfg.channels, ch), "enabled", False)
    # The whole point: tool hints are globally muted.
    cfg.channels.send_tool_hints = False
    cfg.channels.send_progress = True
    bus = MessageBus()
    mgr = ChannelManager(cfg, bus)
    dash = _FakeChannel()
    mgr.channels = {"dashboard": dash}
    return mgr, dash


async def _pump(mgr: ChannelManager, bus: MessageBus, msg: OutboundMessage) -> None:
    task = asyncio.create_task(mgr._dispatch_outbound())
    try:
        await bus.publish_outbound(msg)
        await asyncio.sleep(0.2)
    finally:
        task.cancel()
        await task


@pytest.mark.asyncio
async def test_phase_narration_is_delivered_despite_tool_hints_muted() -> None:
    """A `_phase` frame ships even when `send_tool_hints` is False."""
    mgr, dash = _manager()
    await _pump(
        mgr,
        mgr.bus,
        OutboundMessage(
            channel="dashboard",
            chat_id="console",
            content="🔍 Sending image to VLM…",
            metadata={"_progress": True, "_tool_hint": True, "_phase": True},
        ),
    )
    assert len(dash.sent) == 1
    assert dash.sent[0].content == "🔍 Sending image to VLM…"


@pytest.mark.asyncio
async def test_plain_tool_hint_is_still_dropped() -> None:
    """An ordinary tool-call hint stays muted while `send_tool_hints` is False."""
    mgr, dash = _manager()
    await _pump(
        mgr,
        mgr.bus,
        OutboundMessage(
            channel="dashboard",
            chat_id="console",
            content='read_file("…")',
            metadata={"_progress": True, "_tool_hint": True},
        ),
    )
    assert dash.sent == []

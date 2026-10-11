"""Out-of-band command acks carry ``metadata._notice``.

Parity with Telegram: the acks for ``/stop``, ``/steer`` and ``/btw`` are
published outside the turn, so the dashboard's transcript reducer needs to know
they are discrete notices — otherwise its streaming handler folds them into the
in-flight assistant bubble and the user never sees them (Telegram shows each as
its own message). See ``dashboard/src/lib/transcript.ts``.
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import MagicMock

import pytest

from sarathy.bus.events import InboundMessage
from sarathy.session.manager import SessionManager


def make_loop(tmp_path: Path):
    from sarathy.agent.loop import AgentLoop
    from sarathy.bus.queue import MessageBus

    bus = MessageBus()
    provider = MagicMock()
    provider.get_default_model.return_value = "test-model"
    sm = SessionManager(config=make_config(tmp_path), workspace=tmp_path)
    return AgentLoop(
        bus=bus,
        provider=provider,
        workspace=tmp_path,
        model="test-model",
        memory_window=10,
        session_manager=sm,
    )


def make_config(tmp_path: Path):
    from sarathy.config.schema import Config

    config = Config()
    config.agents.defaults.workspace = str(tmp_path)
    return config


def inbound(content: str, channel: str = "dashboard", chat_id: str = "console") -> InboundMessage:
    return InboundMessage(channel=channel, sender_id="tester", chat_id=chat_id, content=content)


def capture(loop):
    """Replace the outbound publisher with a collector; return the list."""
    published = []

    async def fake(msg):
        published.append(msg)

    loop.bus.publish_outbound = fake
    return published


pytestmark = pytest.mark.asyncio


async def test_stop_ack_is_notice(tmp_path):
    loop = make_loop(tmp_path)
    published = capture(loop)

    await loop._handle_stop(inbound("/stop"))

    assert len(published) == 1
    assert published[0].metadata.get("_notice") is True
    assert "task" in published[0].content.lower()


async def test_steer_usage_ack_is_notice(tmp_path):
    loop = make_loop(tmp_path)
    published = capture(loop)

    await loop._handle_steer(inbound("/steer"))

    assert len(published) == 1
    assert published[0].metadata.get("_notice") is True
    assert published[0].content.startswith("Usage: /steer")


async def test_steer_noted_ack_is_notice(tmp_path):
    loop = make_loop(tmp_path)
    published = capture(loop)
    msg = inbound("/steer use the other file")
    loop._active_main_turns.add(msg.session_key)  # pretend a turn is running

    await loop._handle_steer(msg)

    assert len(published) == 1
    assert published[0].metadata.get("_notice") is True
    assert "Steer noted" in published[0].content


async def test_btw_usage_ack_is_notice(tmp_path):
    loop = make_loop(tmp_path)
    published = capture(loop)

    await loop._handle_btw(inbound("/btw"))

    assert len(published) == 1
    assert published[0].metadata.get("_notice") is True
    assert published[0].content.startswith("Usage: /btw")


async def test_btw_noted_ack_is_notice(tmp_path):
    loop = make_loop(tmp_path)
    published = capture(loop)

    async def noop(*_a, **_k):
        return None

    loop._run_btw_turn = noop  # don't run the real side turn

    await loop._handle_btw(inbound("/btw what is 2+2"))

    assert len(published) == 1
    assert published[0].metadata.get("_notice") is True
    assert "BTW noted" in published[0].content


async def test_steer_idle_session_ack_is_not_dispatched_as_notice(tmp_path):
    """Idle /steer silently becomes the message itself — no notice, no ack."""
    loop = make_loop(tmp_path)
    published = capture(loop)
    loop._spawn_dispatch = lambda _m: None  # don't run the turn

    await loop._handle_steer(inbound("/steer just do the thing"))

    assert published == []

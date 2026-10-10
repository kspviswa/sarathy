"""Spec 126 §A — the restart/redeploy boot ping must reach the dashboard.

Root cause fixed here: ``DashboardChannel.send()`` bailed out at
``if not self._ws_clients: return`` BEFORE the notify branch, so the boot ping
raised ~0.1s after ``channels.start_all()`` — long before any browser had
reconnected its WebSocket — was silently discarded. Notification-bound frames
are now parked in a bounded backlog and replayed to the first socket that
completes its handshake.

Also pins the frame contract (frame names + ``notification`` payload shape are
unchanged) and the fact that ordinary chat frames still drop when offline.
"""

from __future__ import annotations

import asyncio
import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from sarathy.bus.events import OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.channels.dashboard.server import (
    _NOTIFY_BACKLOG,
    DashboardChannel,
    notification_parts,
)


def _channel() -> DashboardChannel:
    return DashboardChannel(MagicMock(), MessageBus())


def _fake_ws() -> MagicMock:
    """A stand-in WebSocketResponse that records what was written to it."""
    ws = MagicMock()
    ws.send_str = AsyncMock()
    return ws


def _sent(ws: MagicMock) -> list[dict]:
    """Every frame written to a fake socket, decoded."""
    return [json.loads(c[0][0]) for c in ws.send_str.await_args_list]


# ---------------------------------------------------------------------------
# The reported bug: boot ping raised with nobody connected
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestOfflineBufferAndFlush:
    async def test_notify_ping_with_no_client_is_buffered_not_dropped(self):
        """The reported bug: the ping vanished before the browser came back."""
        ch = _channel()
        ws = _fake_ws()

        await ch.send(
            OutboundMessage(
                channel="dashboard",
                chat_id="console",
                content="Gateway restarted successfully",
                metadata={"notify": True, "tab": "status", "notify_title": "Sarathy restarted"},
            )
        )

        assert len(ch._pending_notify) == 1
        assert ws.send_str.await_count == 0

        ch._ws_clients.add(ws)
        await ch._flush_pending_notify(ws)

        frame = _sent(ws)[0]
        assert frame["type"] == "notification"
        assert frame["payload"]["title"] == "Sarathy restarted"
        assert "restarted successfully" in frame["payload"]["body"]
        assert not ch._pending_notify

    async def test_backlog_is_ordered_oldest_first(self):
        ch = _channel()
        ws = _fake_ws()

        for i in range(3):
            await ch.send(
                OutboundMessage(
                    channel="dashboard",
                    chat_id="console",
                    content=f"event {i}",
                    metadata={"notify": True},
                )
            )

        ch._ws_clients.add(ws)
        await ch._flush_pending_notify(ws)

        bodies = [f["payload"]["body"] for f in _sent(ws)]
        assert bodies == ["event 0", "event 1", "event 2"]

    async def test_backlog_is_bounded(self):
        """A gateway left running headless must not grow memory without limit."""
        ch = _channel()

        for i in range(_NOTIFY_BACKLOG + 25):
            await ch.send(
                OutboundMessage(
                    channel="dashboard",
                    chat_id="console",
                    content=f"event {i}",
                    metadata={"notify": True},
                )
            )

        assert len(ch._pending_notify) == _NOTIFY_BACKLOG
        # The oldest are the ones dropped.
        assert json.loads(ch._pending_notify[0])["payload"]["body"] == "event 25"

    async def test_flush_hands_the_backlog_to_exactly_one_client(self):
        """A second tab must not see a duplicate of the same boot ping."""
        ch = _channel()
        first, second = _fake_ws(), _fake_ws()

        await ch.send(
            OutboundMessage(
                channel="dashboard",
                chat_id="console",
                content="boot",
                metadata={"notify": True},
            )
        )

        ch._ws_clients.add(first)
        await ch._flush_pending_notify(first)
        ch._ws_clients.add(second)
        await ch._flush_pending_notify(second)

        assert first.send_str.await_count == 1
        assert second.send_str.await_count == 0

    async def test_ordinary_chat_frames_still_drop_when_offline(self):
        """Buffering is for notifications only; transcripts keep today's behavior."""
        ch = _channel()
        await ch.send(
            OutboundMessage(channel="dashboard", chat_id="console", content="hello")
        )
        assert not ch._pending_notify

    async def test_live_client_gets_the_frame_directly_without_buffering(self):
        ch = _channel()
        ws = _fake_ws()
        ch._ws_clients.add(ws)

        await ch.send(
            OutboundMessage(
                channel="dashboard",
                chat_id="console",
                content="live ping",
                metadata={"notify": True},
            )
        )

        assert not ch._pending_notify
        frame = _sent(ws)[0]
        assert frame["type"] == "notification"

    async def test_a_dead_socket_requeues_the_unflushed_backlog(self):
        """A tab that dies mid-replay must not swallow the ping for good."""
        ch = _channel()
        ws = _fake_ws()
        ws.send_str = AsyncMock(side_effect=RuntimeError("socket closed"))

        await ch.send(
            OutboundMessage(
                channel="dashboard",
                chat_id="console",
                content="boot",
                metadata={"notify": True},
            )
        )
        ch._ws_clients.add(ws)
        await ch._flush_pending_notify(ws)

        assert len(ch._pending_notify) == 1
        assert ws not in ch._ws_clients


# ---------------------------------------------------------------------------
# Contract preservation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestFrameContractUnchanged:
    async def test_notification_payload_shape_is_unchanged(self):
        ch = _channel()
        ws = _fake_ws()
        ch._ws_clients.add(ws)

        await ch.send_notification("Title", "Body", tab="jobs")

        frame = _sent(ws)[0]
        assert frame["type"] == "notification"
        assert set(frame) == {"type", "payload"}
        assert set(frame["payload"]) == {"title", "body", "tab", "timestamp"}

    async def test_message_frame_shape_is_unchanged(self):
        ch = _channel()
        ws = _fake_ws()
        ch._ws_clients.add(ws)

        await ch.send(
            OutboundMessage(
                channel="dashboard", chat_id="console", content="hi", metadata={}
            )
        )

        frame = _sent(ws)[0]
        assert set(frame) == {
            "type",
            "channel",
            "chatId",
            "content",
            "media",
            "replyTo",
            "metadata",
        }


# ---------------------------------------------------------------------------
# The boot ping is actually flagged as a notification
# ---------------------------------------------------------------------------


def test_notify_metadata_is_inert_on_every_outbound_channel():
    """Telegram (and friends) must still get the boot status as a chat message.

    They key off ``_progress``/``_final``/``_btw`` only. ``backend`` is excluded
    on purpose — it is a *producer* of notify metadata — and the dashboard is
    the consumer that acts on it.
    """
    from pathlib import Path

    import sarathy.channels as channels_pkg

    consumers = {"telegram.py", "discord.py", "email.py"}
    keys = ('"notify"', "'notify'", '"tab"', "'tab'", '"notify_title"', "'notify_title'")
    offenders = [
        path.name
        for path in Path(channels_pkg.__file__).parent.glob("*.py")
        if path.name in consumers
        and any(k in path.read_text(encoding="utf-8") for k in keys)
    ]
    assert offenders == []


@pytest.mark.asyncio
class TestBootPingIsFlagged:
    async def test_publish_restart_status_flags_notify_and_status_tab(self, tmp_path):
        """The ping must land in the notification center, not the transcript."""
        from sarathy.gateway.run import publish_restart_status

        flag = tmp_path / "restart_pending.json"
        flag.write_text(json.dumps({"targets": ["dashboard:console", "telegram:1"]}))

        config = MagicMock()
        config.agents.defaults.model = "test-model"
        config.get_provider_name.return_value = "ollama"
        config.providers = {}
        config.tools.web.search.enabled = False

        bus = MessageBus()
        await publish_restart_status(bus, config, flag_path=flag)

        msgs = [await bus.consume_outbound() for _ in range(2)]
        by_channel = {m.channel: m for m in msgs}

        dash = by_channel["dashboard"]
        assert dash.metadata["notify"] is True
        assert dash.metadata["tab"] == "status"
        assert dash.metadata["notify_title"] == "Sarathy restarted"
        # Telegram keeps the plain chat message, unchanged.
        assert by_channel["telegram"].metadata["notify"] is True

    async def test_boot_ping_survives_the_notify_split(self):
        """End-to-end of the reported bug: ping raised offline, browser connects."""
        from sarathy.gateway.run import build_restart_status, publish_restart_status

        config = MagicMock()
        config.agents.defaults.model = "test-model"
        config.get_provider_name.return_value = "ollama"
        config.providers = {}
        config.tools.web.search.enabled = False

        flag = MagicMock()
        flag.exists.return_value = False  # force the body through anyway

        body = build_restart_status(config)
        ch = _channel()
        ws = _fake_ws()

        await ch.send(
            OutboundMessage(
                channel="dashboard",
                chat_id="console",
                content=body,
                metadata={"notify": True, "tab": "status", "notify_title": "Sarathy restarted"},
            )
        )
        assert ws.send_str.await_count == 0  # nobody home yet

        ch._ws_clients.add(ws)
        await ch._flush_pending_notify(ws)

        frame = _sent(ws)[0]
        assert frame["type"] == "notification"
        assert "Gateway restarted successfully" in frame["payload"]["body"]


def test_notification_parts_still_splits_title_and_body():
    """Guard the helper the notify branch depends on."""
    title, body = notification_parts("hello world", {"notify_title": "Jobs"})
    assert (title, body) == ("Jobs", "hello world")
    # Default title when the sender set none.
    assert notification_parts("x", {})[0] == "Sarathy"

# ---------------------------------------------------------------------------
# Acceptance: the ping actually arrives over a real socket
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
class TestRestartPingOverRealSocket:
    """End-to-end over an actual aiohttp WebSocket (spec §A acceptance).

    This is the reported bug reproduced exactly: the boot ping is raised while
    the dashboard has no client — as it does ~0.1s after ``channels.start_all()``
    on every ``/restart`` and every redeploy — and a browser then connects. The
    frame must arrive over the wire, not sit in a buffer forever.
    """

    async def _app_and_client(self, tmp_path, monkeypatch):
        from aiohttp.test_utils import TestClient, TestServer

        from sarathy.channels.dashboard.server import DashboardChannel
        from sarathy.config.schema import Config, DashboardConfig

        cfg = Config()
        cfg.channels.dashboard.enabled = True
        cfg.channels.dashboard.pairing_keys = ["test-key"]
        cfg.agents.defaults.workspace = str(tmp_path / "ws")

        devices = tmp_path / "devices.json"
        ch = DashboardChannel(
            cfg.channels.dashboard,
            MessageBus(),
            config_path=tmp_path / "config.json",
            devices_path=devices,
        )
        # Pair a real device rather than stubbing auth, so the socket goes
        # through the same handshake a browser does.
        token, _device_id = ch._registry.register("test-key", "Test Device")

        client = TestClient(TestServer(ch._build_app()))
        await client.start_server()
        return ch, client, token

    async def _boot_ping(self, ch, tmp_path):
        """Raise the real boot ping through the real publish path."""
        from unittest.mock import MagicMock

        from sarathy.gateway.run import publish_restart_status

        flag = tmp_path / "restart_pending.json"
        flag.write_text(json.dumps({"targets": ["dashboard:console"]}))

        config = MagicMock()
        config.agents.defaults.model = "test-model"
        config.get_provider_name.return_value = "ollama"
        config.providers = {}
        config.tools.web.search.enabled = False

        bus = MessageBus()
        await publish_restart_status(bus, config, flag_path=flag)
        msg = await bus.consume_outbound()
        # ...and the channel receives it exactly as the channel manager would.
        await ch.send(msg)

    async def test_boot_ping_raised_before_the_browser_connects_still_arrives(
        self, tmp_path, monkeypatch
    ):
        ch, client, token = await self._app_and_client(tmp_path, monkeypatch)

        # No client is connected yet — exactly like the post-restart window.
        await self._boot_ping(ch, tmp_path)
        assert len(ch._pending_notify) == 1

        # A browser now reconnects.
        ws = await client.ws_connect(f"/ws?token={token}")
        frame = json.loads(await asyncio.wait_for(ws.receive_str(), timeout=5))

        assert frame["type"] == "notification"
        assert frame["payload"]["title"] == "Sarathy restarted"
        assert "Gateway restarted successfully" in frame["payload"]["body"]
        assert frame["payload"]["tab"] == "status"

        await ws.close()
        await client.close()

    async def test_a_second_client_does_not_re_receive_the_same_ping(
        self, tmp_path, monkeypatch
    ):
        ch, client, token = await self._app_and_client(tmp_path, monkeypatch)
        await self._boot_ping(ch, tmp_path)

        first = await client.ws_connect(f"/ws?token={token}")
        assert json.loads(await asyncio.wait_for(first.receive_str(), timeout=5))["type"] == (
            "notification"
        )

        second = await client.ws_connect(f"/ws?token={token}")
        # No buffered frame left, so the second tab waits rather than getting a
        # duplicate. A ping over the wire proves it is NOT silent.
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(second.receive_str(), timeout=1.0)

        await first.close()
        await second.close()
        await client.close()

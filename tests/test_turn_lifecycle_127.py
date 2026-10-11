"""Spec 127 — server-owned turn lifecycle, media persistence, notif pref.

Covers:
  §A  AgentLoop turn registry + `turn_state` frames; `GET /api/turn`;
      `turn` block on `GET /api/session`; WS snapshot/turn_state routing.
  §B  outbound media normalization + transcript persistence (turn-keyed).
  §D  per-device notification preference endpoint.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, patch

import pytest
from aiohttp.test_utils import TestClient, TestServer

from sarathy.agent.loop import AgentLoop
from sarathy.bus.events import InboundMessage, OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.channels.dashboard.server import DashboardChannel
from sarathy.channels.manager import ChannelManager
from sarathy.config.loader import save_config
from sarathy.config.schema import Config
from sarathy.providers.base import LLMResponse
from sarathy.session.manager import SessionManager

IDLE = {"active": False, "state": "idle", "turn_id": None, "started_at": None}


# ---------------------------------------------------------------------------
# AgentLoop turn registry (spec 127 §A.1)
# ---------------------------------------------------------------------------


class _FakeProvider:
    def __init__(self, responses):
        self.responses = responses if isinstance(responses, list) else [responses]
        self.calls: list[dict] = []

    def get_default_model(self) -> str:
        return "test-model"

    async def chat(self, messages: list[dict] | None = None, **kwargs: Any) -> LLMResponse:
        self.calls.append(kwargs)
        return self.responses[min(len(self.calls) - 1, len(self.responses) - 1)]


def _fake_add_assistant(messages, content, tool_calls=None, reasoning_content=None):
    messages.append({"role": "assistant", "content": content})
    return messages


def _fake_add_tool_result(messages, tool_id, name, result):
    messages.append({"role": "tool", "tool_call_id": tool_id, "name": name, "content": str(result)})
    return messages


def _make_loop(tmp_path) -> tuple[AgentLoop, MessageBus]:
    workspace = tmp_path / "ws"
    workspace.mkdir(exist_ok=True)
    bus = MessageBus()
    with patch("sarathy.agent.loop.ContextBuilder"), \
         patch("sarathy.agent.loop.SubagentManager") as mock_submgr:
        mock_submgr.return_value.cancel_by_session = AsyncMock(return_value=0)
        loop = AgentLoop(
            bus=bus,
            provider=_FakeProvider(LLMResponse(content="done")),
            workspace=workspace,
            model="test-model",
            session_manager=SessionManager(Config(), workspace=tmp_path / "sessions"),
        )
    loop.context.build_messages.return_value = [{"role": "user", "content": "hi"}]
    loop.context.add_assistant_message.side_effect = _fake_add_assistant
    loop.context.add_tool_result.side_effect = _fake_add_tool_result
    loop.context.get_history.return_value = []
    return loop, bus


def test_turn_registry_idle_begin_phases_end(tmp_path) -> None:
    loop, _ = _make_loop(tmp_path)
    key = "dashboard:console"

    assert loop.turn_state(key) == IDLE
    assert loop.is_turn_active(key) is False

    turn = loop._begin_turn(key)
    assert turn["active"] is True
    assert turn["state"] == "thinking"
    assert turn["turn_id"]
    assert loop.turn_state(key)["turn_id"] == turn["turn_id"]

    loop._set_turn_phase(key, "tool")
    assert loop.turn_state(key)["state"] == "tool"

    loop._end_turn(key)
    assert loop.turn_state(key) == IDLE


@pytest.mark.asyncio
async def test_emit_turn_state_publishes_bus_frames(tmp_path) -> None:
    loop, bus = _make_loop(tmp_path)
    key = "dashboard:console"
    loop._begin_turn(key)

    await loop._emit_turn_state("dashboard", "console", key, active=True)
    msg = await asyncio.wait_for(bus.consume_outbound(), timeout=1)
    assert msg.metadata["_turn_state"] is True
    assert msg.metadata["turn"]["active"] is True
    assert msg.metadata["turn"]["turn_id"]

    loop._end_turn(key)
    await loop._emit_turn_state("dashboard", "console", key, active=False)
    end = await asyncio.wait_for(bus.consume_outbound(), timeout=1)
    assert end.metadata["turn"] == IDLE


@pytest.mark.asyncio
async def test_process_message_brackets_turn_with_state_frames(tmp_path) -> None:
    loop, bus = _make_loop(tmp_path)
    msg = InboundMessage(channel="dashboard", sender_id="u", chat_id="console", content="hi")

    result = await loop._process_message(msg)
    assert result is not None
    # The final answer carries the active turn id (spec 127 §C.4); it is
    # returned to the caller, which publishes it (not published here).
    assert result.metadata.get("turn_id")

    frames: list[OutboundMessage] = []
    while True:
        try:
            frames.append(await asyncio.wait_for(bus.consume_outbound(), timeout=0.3))
        except asyncio.TimeoutError:
            break

    turn_frames = [f for f in frames if f.metadata.get("_turn_state")]
    assert turn_frames, "expected turn_state frames"
    assert turn_frames[0].metadata["turn"]["active"] is True
    assert turn_frames[-1].metadata["turn"]["active"] is False


# ---------------------------------------------------------------------------
# ChannelManager routes turn_state to dashboard only (spec 127 §A.2)
# ---------------------------------------------------------------------------


class _FakeChannel:
    def __init__(self) -> None:
        self.sent: list[OutboundMessage] = []

    async def send(self, msg: OutboundMessage) -> None:
        self.sent.append(msg)


@pytest.mark.asyncio
async def test_manager_routes_turn_state_to_dashboard_only() -> None:
    cfg = Config()
    for ch in ("telegram", "discord", "email", "dashboard", "backend"):
        setattr(getattr(cfg.channels, ch), "enabled", False)
    bus = MessageBus()
    mgr = ChannelManager(cfg, bus)
    dash, tg = _FakeChannel(), _FakeChannel()
    mgr.channels = {"dashboard": dash, "telegram": tg}

    task = asyncio.create_task(mgr._dispatch_outbound())
    try:
        await bus.publish_outbound(
            OutboundMessage(
                channel="telegram",
                chat_id="123",
                content="",
                metadata={"_turn_state": True, "turn": {"active": True}},
            )
        )
        for _ in range(20):
            if dash.sent:
                break
            await asyncio.sleep(0.05)
    finally:
        task.cancel()
        await task

    assert len(dash.sent) == 1
    assert tg.sent == []


# ---------------------------------------------------------------------------
# Dashboard channel: /api/turn, /api/session, media persistence, notif pref
# ---------------------------------------------------------------------------


class _StubAgent:
    """Minimal agent exposing only the turn registry the channel reads."""

    def __init__(self) -> None:
        self._state: dict[str, dict] = {}

    def set(self, key: str, block: dict) -> None:
        self._state[key] = block

    def turn_state(self, key: str) -> dict:
        return dict(self._state.get(key, IDLE))


def _write_config(config_path: Path, workspace: Path, keys: list[str] | None = None) -> None:
    cfg = Config()
    cfg.channels.dashboard.enabled = True
    cfg.channels.dashboard.pairing_keys = keys or ["test-key"]
    cfg.agents.defaults.workspace = str(workspace)
    save_config(cfg, config_path)


def _make_channel(config_path: Path, workspace: Path, agent: _StubAgent) -> DashboardChannel:
    cfg = Config()
    cfg.channels.dashboard.enabled = True
    cfg.channels.dashboard.pairing_keys = ["test-key"]
    cfg.agents.defaults.workspace = str(workspace)
    sm = SessionManager(cfg, workspace=workspace)
    session = sm.get_or_create("dashboard:console")
    session.add_message("user", "hello there")
    session.add_message("assistant", "hi!")
    sm.save(session)
    return DashboardChannel(
        cfg.channels.dashboard,
        MessageBus(),
        session_manager=sm,
        config_path=config_path,
        devices_path=config_path.parent / "devices.json",
        agent=agent,
    )


async def _authed_client(tmp_path) -> tuple[TestClient, DashboardChannel, _StubAgent]:
    config_path = tmp_path / "config.json"
    workspace = tmp_path / "ws"
    _write_config(config_path, workspace, ["test-key"])
    agent = _StubAgent()
    channel = _make_channel(config_path, workspace, agent)
    client = TestClient(TestServer(channel._build_app()))
    return client, channel, agent


async def _pair(client: TestClient) -> str:
    resp = await client.post("/api/auth/pair", json={"key": "test-key", "deviceName": "iphone"})
    assert resp.status == 200
    return (await resp.json())["token"]


@pytest.mark.asyncio
async def test_api_turn_returns_top_level_block(tmp_path) -> None:
    client, _channel, agent = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        headers = {"Authorization": f"Bearer {token}"}

        resp = await client.get("/api/turn", headers=headers)
        assert resp.status == 200
        assert await resp.json() == IDLE

        agent.set(
            "dashboard:console",
            {"active": True, "state": "streaming", "turn_id": "T1", "started_at": 123.0},
        )
        data = await (await client.get("/api/turn", headers=headers)).json()
        # Spec A.4: block is at the TOP level, never nested under "turn".
        assert data["active"] is True
        assert data["turn_id"] == "T1"
        assert "turn" not in data


@pytest.mark.asyncio
async def test_api_session_folds_turn_and_media(tmp_path) -> None:
    client, channel, agent = await _authed_client(tmp_path)
    sm = channel.session_manager
    session = sm.read_session("dashboard:console")
    session.add_message("assistant", "with audio", media=["/media/a.mp3"], turn_id="T1")
    sm.save(session)
    agent.set(
        "dashboard:console",
        {"active": True, "state": "thinking", "turn_id": "T1", "started_at": 5.0},
    )

    async with client:
        token = await _pair(client)
        resp = await client.get(
            "/api/session",
            params={"key": "dashboard:console"},
            headers={"Authorization": f"Bearer {token}"},
        )
        data = await resp.json()
        assert data["turn"]["active"] is True
        assert data["turn"]["turn_id"] == "T1"
        keyed = [m for m in data["messages"] if m.get("turn_id") == "T1"]
        assert keyed and keyed[-1]["media"] == ["/media/a.mp3"]


@pytest.mark.asyncio
async def test_send_broadcasts_turn_state_and_flushes_media(tmp_path, monkeypatch) -> None:
    from sarathy.channels.dashboard import server as server_module

    media_dir = tmp_path / "media"
    media_dir.mkdir()
    monkeypatch.setattr(server_module, "_MEDIA_DIR", media_dir)

    client, channel, agent = await _authed_client(tmp_path)
    src = tmp_path / "voice.wav"
    src.write_bytes(b"RIFF....")

    async with client:
        token = await _pair(client)
        ws = await client.ws_connect(f"/ws?token={token}")
        # First frame on connect is the authoritative snapshot (spec 127 §A.5).
        await asyncio.wait_for(ws.receive(), timeout=5)

        # A turn is in flight; media is tagged with its turn id.
        agent.set(
            "dashboard:console",
            {"active": True, "state": "streaming", "turn_id": "T1", "started_at": 1.0},
        )
        await channel.send(
            OutboundMessage(
                channel="dashboard",
                chat_id="console",
                content="here is the voice note",
                media=[str(src)],
                metadata={"turn_id": "T1"},
            )
        )
        frame = json.loads((await asyncio.wait_for(ws.receive(), timeout=5)).data)
        assert frame["type"] == "message"
        assert frame["metadata"]["turn_id"] == "T1"
        # Normalized into the servable media root, not the original location.
        assert frame["media"] and frame["media"][0].startswith(str(media_dir))
        # ...but NOT yet persisted: ordering is deferred to turn end.
        disk = channel.session_manager.read_session("dashboard:console")
        assert not any(m.get("media") for m in disk.messages)

        # Turn ends — the media flushes into the transcript.
        await channel.send(
            OutboundMessage(
                channel="dashboard",
                chat_id="console",
                content="",
                metadata={"_turn_state": True, "turn": IDLE},
            )
        )
        end = json.loads((await asyncio.wait_for(ws.receive(), timeout=5)).data)
        assert end["type"] == "turn_state"
        assert end["turn"]["active"] is False

        disk = channel.session_manager.read_session("dashboard:console")
        media_msgs = [m for m in disk.messages if m.get("media")]
        assert media_msgs
        assert media_msgs[-1]["turn_id"] == "T1"
        assert media_msgs[-1]["media"][0].startswith(str(media_dir))
        assert media_msgs[-1]["content"] == "here is the voice note"
        await ws.close()


@pytest.mark.asyncio
async def test_ws_snapshot_carries_turn_block(tmp_path) -> None:
    client, _channel, agent = await _authed_client(tmp_path)
    agent.set(
        "dashboard:console",
        {"active": True, "state": "tool", "turn_id": "T9", "started_at": 2.0},
    )
    async with client:
        token = await _pair(client)
        ws = await client.ws_connect(f"/ws?token={token}")
        snap = json.loads((await asyncio.wait_for(ws.receive(), timeout=5)).data)
        assert snap["type"] == "snapshot"
        assert snap["turn"]["active"] is True
        assert snap["turn"]["turn_id"] == "T9"
        await ws.close()


@pytest.mark.asyncio
async def test_cache_buster_headers_preserved(tmp_path) -> None:
    """Spec 127 E.4 — the no-store chain for HTML shells + SW + manifest holds."""
    client, channel, _agent = await _authed_client(tmp_path)
    async with client:
        for path in ("/", "/mobile", "/index.html"):
            resp = await client.get(path)
            if resp.status == 200:
                assert "no-store" in resp.headers.get("Cache-Control", "")

        for path in ("/sw.js", "/registerSW.js", "/manifest.webmanifest"):
            resp = await client.get(path)
            if resp.status != 200:
                continue
            cc = resp.headers.get("Cache-Control", "")
            assert "no-store" in cc and "must-revalidate" in cc, (path, cc)

        # A workbox-*.js file shipped with the build is also no-store.
        for wb in channel._static_dir.glob("workbox-*.js"):
            resp = await client.get(f"/{wb.name}")
            assert resp.status == 200
            assert "no-store" in resp.headers.get("Cache-Control", "")
            break


@pytest.mark.asyncio
async def test_notification_pref_roundtrip(tmp_path) -> None:
    client, _channel, _agent = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        headers = {"Authorization": f"Bearer {token}"}

        resp = await client.get("/api/notifications/pref", headers=headers)
        assert resp.status == 200
        assert (await resp.json())["enabled"] is None

        resp = await client.post("/api/notifications/pref", json={"enabled": True}, headers=headers)
        assert resp.status == 200
        assert (await resp.json())["enabled"] is True
        assert (await (await client.get("/api/notifications/pref", headers=headers)).json())[
            "enabled"
        ] is True

        await client.post("/api/notifications/pref", json={"enabled": False}, headers=headers)
        assert (await (await client.get("/api/notifications/pref", headers=headers)).json())[
            "enabled"
        ] is False

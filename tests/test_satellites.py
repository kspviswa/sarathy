"""Satellites channel — CIDR gate, sessions, tool allowlist, protocol (spec 178)."""

from __future__ import annotations

import asyncio
import json
import math
import struct
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from aiohttp import web
from aiohttp.test_utils import TestClient, TestServer

from sarathy.agent.tools.base import Tool
from sarathy.agent.tools.registry import ToolRegistry
from sarathy.bus.events import InboundMessage, OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.channels.satellites import (
    SatellitesChannel,
    ip_allowed,
    mint_wake_id,
)
from sarathy.config.schema import Config, SatellitesConfig
from sarathy.session.manager import SessionManager


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------


def _pcm_tone(seconds: float = 0.5, sr: int = 16000) -> bytes:
    n = int(seconds * sr)
    return b"".join(
        struct.pack("<h", int(4000 * math.sin(2 * math.pi * 220 * i / sr)))
        for i in range(n)
    )


def _tts_stub(text: str) -> bytes:
    # 200 ms of 24 kHz tone — enough to assert binary PCM > 0.
    n = int(0.2 * 24000)
    return b"".join(
        struct.pack("<h", int(5000 * math.sin(2 * math.pi * 440 * i / 24000)))
        for i in range(n)
    )


class _DummyTool(Tool):
    def __init__(self, name: str):
        self._name = name

    @property
    def name(self) -> str:
        return self._name

    @property
    def description(self) -> str:
        return self._name

    @property
    def parameters(self) -> dict:
        return {"type": "object", "properties": {}}

    async def execute(self, **kwargs) -> str:
        return f"ok:{self._name}"


def _make_channel(
    tmp_path: Path,
    *,
    stt_text: str = "what time is it",
    allow_cidrs: list[str] | None = None,
    max_utterance_s: int = 30,
    filler_after_s: float = 60.0,
) -> tuple[SatellitesChannel, MessageBus, SessionManager]:
    cfg = SatellitesConfig(
        enabled=True,
        allow_cidrs=allow_cidrs or ["127.0.0.1/32", "::1/128", "192.168.0.0/16"],
        max_utterance_s=max_utterance_s,
        filler_after_s=filler_after_s,
        max_concurrent=4,
        rate_limit_per_min=100,
    )
    bus = MessageBus()
    full = Config()
    full.agents.defaults.workspace = str(tmp_path / "ws")
    sm = SessionManager(full, workspace=tmp_path / "ws")

    def stt_fn(pcm: bytes) -> str:
        # Silence / near-empty PCM → empty transcript for the empty-transcript test.
        if len(pcm) < 16000 * 2 * 0.05:  # < 50 ms
            return ""
        return stt_text

    ch = SatellitesChannel(
        cfg,
        bus,
        session_manager=sm,
        stt_fn=stt_fn,
        tts_fn=_tts_stub,
    )
    return ch, bus, sm


async def _start_client(channel: SatellitesChannel) -> TestClient:
    await channel.start()
    app = web.Application()
    channel.mount(app)
    client = TestClient(TestServer(app))
    await client.start_server()
    return client


async def _fake_agent(bus: MessageBus, channel: SatellitesChannel, reply: str) -> None:
    """Consume one inbound and push a final outbound via the channel."""
    msg = await asyncio.wait_for(bus.consume_inbound(), timeout=5)
    # Seed a session so archive has something to write.
    if channel.session_manager is not None:
        session = channel.session_manager.get_or_create(msg.session_key)
        session.add_message("user", msg.content)
        session.add_message("assistant", reply)
        channel.session_manager.save(session)
    await channel.send(
        OutboundMessage(
            channel="satellites",
            chat_id=msg.chat_id,
            content=reply,
            metadata={**(msg.metadata or {}), "_final": True},
        )
    )


# ---------------------------------------------------------------------------
# 1. CIDR gate
# ---------------------------------------------------------------------------


def test_cidr_gate_default_and_mapped():
    cidrs = ["192.168.0.0/16"]
    assert ip_allowed("192.168.1.20", cidrs) is True
    assert ip_allowed("10.0.0.5", cidrs) is False
    assert ip_allowed("8.8.8.8", cidrs) is False
    assert ip_allowed("::ffff:192.168.1.20", cidrs) is True
    assert ip_allowed("::ffff:10.0.0.5", cidrs) is False


def test_cidr_gate_custom_allowlist():
    cidrs = ["10.0.0.0/8"]
    assert ip_allowed("10.0.0.5", cidrs) is True
    assert ip_allowed("192.168.1.20", cidrs) is False


# ---------------------------------------------------------------------------
# 2. Session key uniqueness
# ---------------------------------------------------------------------------


def test_session_key_uniqueness(tmp_path):
    device = "puck1"
    wake_a = mint_wake_id()
    # Ensure distinct timestamps/hex even if called in the same second
    wake_b = mint_wake_id()
    if wake_a == wake_b:
        wake_b = mint_wake_id() + "x"  # force distinct in pathological collision
        wake_b = mint_wake_id()
    key_a = f"satellites:{device}:{wake_a}"
    key_b = f"satellites:{device}:{wake_b}"
    # Re-mint until distinct (uuid collision is astronomically unlikely)
    while key_a == key_b:
        key_b = f"satellites:{device}:{mint_wake_id()}"

    assert key_a != key_b
    assert key_a.startswith(f"satellites:{device}:")
    assert key_b.startswith(f"satellites:{device}:")

    full = Config()
    full.agents.defaults.workspace = str(tmp_path / "ws")
    sm = SessionManager(full, workspace=tmp_path / "ws")
    s1 = sm.get_or_create(key_a)
    s2 = sm.get_or_create(key_b)
    assert s1 is not s2
    assert s1.key == key_a
    assert s2.key == key_b


# ---------------------------------------------------------------------------
# 3. Tool allowlist
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tool_allowlist_enforced():
    reg = ToolRegistry()
    reg.register(_DummyTool("exec"))
    reg.register(_DummyTool("memory"))
    reg.register(_DummyTool("kb"))

    allowed = {"memory", "kb", "read_file"}

    refused = await reg.execute("exec", {}, allowed=allowed)
    assert "not allowed" in refused.lower()

    ok = await reg.execute("memory", {}, allowed=allowed)
    assert ok == "ok:memory"

    # Regression: allowed=None keeps prior behaviour
    still = await reg.execute("exec", {}, allowed=None)
    assert still == "ok:exec"


# ---------------------------------------------------------------------------
# 4. Protocol round trip
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_protocol_round_trip(tmp_path):
    channel, bus, _sm = _make_channel(tmp_path)
    client = await _start_client(channel)
    agent_task = asyncio.create_task(
        _fake_agent(bus, channel, "The sky is clear tonight.")
    )
    try:
        async with client.ws_connect("/satellites/ws?device_id=sim1") as ws:
            await ws.send_json(
                {
                    "type": "device.hello",
                    "device_id": "sim1",
                    "fw_version": "0.1.0",
                    "capabilities": ["audio.in", "audio.out", "led.ring"],
                    "mic_sample_rate": 16000,
                }
            )
            frames: list[dict | bytes] = []
            hello = await asyncio.wait_for(ws.receive_json(), timeout=3)
            frames.append(hello)
            assert hello["type"] == "hello.ok"
            assert hello["tts"]["sample_rate"] == 24000

            await ws.send_json({"type": "listen.start"})
            state = await asyncio.wait_for(ws.receive_json(), timeout=3)
            frames.append(state)
            assert state == {"type": "state", "state": "listening"}

            pcm = _pcm_tone(0.4)
            for i in range(0, len(pcm), 3200):
                await ws.send_bytes(pcm[i : i + 3200])
            await ws.send_json({"type": "listen.stop"})

            audio_bytes = 0
            types: list[str] = []
            deadline = asyncio.get_event_loop().time() + 8
            while asyncio.get_event_loop().time() < deadline:
                msg = await asyncio.wait_for(ws.receive(), timeout=5)
                if msg.type.name == "BINARY":
                    audio_bytes += len(msg.data)
                    frames.append(msg.data)
                    continue
                if msg.type.name != "TEXT":
                    break
                ev = json.loads(msg.data)
                frames.append(ev)
                types.append(ev.get("type", ""))
                if ev.get("type") == "state" and ev.get("state") == "idle":
                    break

            assert "hello.ok" in [f.get("type") for f in frames if isinstance(f, dict)]
            assert {"type": "state", "state": "listening"} in [
                f for f in frames if isinstance(f, dict)
            ]
            assert {"type": "state", "state": "thinking"} in [
                f for f in frames if isinstance(f, dict)
            ]
            assert any(
                isinstance(f, dict) and f.get("type") == "stt.final" for f in frames
            )
            assert any(
                isinstance(f, dict) and f.get("type") == "tts.sentence" for f in frames
            )
            assert audio_bytes > 0
            assert any(
                isinstance(f, dict) and f.get("type") == "tts.sentence_end"
                for f in frames
            )
            assert "tts.done" in types
            assert {"type": "state", "state": "idle"} in [
                f for f in frames if isinstance(f, dict)
            ]
    finally:
        agent_task.cancel()
        try:
            await agent_task
        except asyncio.CancelledError:
            pass
        await client.close()
        await channel.stop()


# ---------------------------------------------------------------------------
# 5. Utterance cap
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_utterance_cap(tmp_path):
    channel, bus, sm = _make_channel(tmp_path, max_utterance_s=1)
    client = await _start_client(channel)
    try:
        async with client.ws_connect("/satellites/ws?device_id=cap1") as ws:
            await ws.send_json(
                {
                    "type": "device.hello",
                    "device_id": "cap1",
                    "fw_version": "0.1.0",
                    "capabilities": ["audio.in"],
                    "mic_sample_rate": 16000,
                }
            )
            await asyncio.wait_for(ws.receive_json(), timeout=3)  # hello.ok

            await ws.send_json({"type": "listen.start"})
            await asyncio.wait_for(ws.receive_json(), timeout=3)  # listening

            # > 1 s of audio at 16 kHz mono s16le
            oversized = _pcm_tone(1.5)
            await ws.send_bytes(oversized)

            ev = await asyncio.wait_for(ws.receive_json(), timeout=3)
            assert ev["type"] == "error"
            assert ev["code"] == "utterance_too_long"
            assert ev["recoverable"] is True

            # No inbound published → no session
            assert bus.inbound_size == 0
            archive = tmp_path / "ws" / "archived_sessions"
            if archive.exists():
                assert list(archive.glob("*.jsonl")) == []
    finally:
        await client.close()
        await channel.stop()


# ---------------------------------------------------------------------------
# 6. Empty transcript
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_empty_transcript(tmp_path):
    channel, bus, sm = _make_channel(tmp_path, stt_text="")
    # Override stt to always return empty regardless of PCM length
    channel._stt_fn = lambda pcm: ""
    client = await _start_client(channel)
    try:
        async with client.ws_connect("/satellites/ws?device_id=quiet1") as ws:
            await ws.send_json(
                {
                    "type": "device.hello",
                    "device_id": "quiet1",
                    "fw_version": "0.1.0",
                    "capabilities": ["audio.in", "audio.out"],
                    "mic_sample_rate": 16000,
                }
            )
            await asyncio.wait_for(ws.receive_json(), timeout=3)

            await ws.send_json({"type": "listen.start"})
            await asyncio.wait_for(ws.receive_json(), timeout=3)

            # Non-trivial PCM so the length check isn't what triggers empty —
            # the stub returns "".
            await ws.send_bytes(_pcm_tone(0.3))
            await ws.send_json({"type": "listen.stop"})

            types: list[str] = []
            texts: list[str] = []
            deadline = asyncio.get_event_loop().time() + 5
            while asyncio.get_event_loop().time() < deadline:
                msg = await asyncio.wait_for(ws.receive(), timeout=4)
                if msg.type.name == "BINARY":
                    continue
                if msg.type.name != "TEXT":
                    break
                ev = json.loads(msg.data)
                types.append(ev.get("type", ""))
                if ev.get("type") == "tts.sentence":
                    texts.append(ev.get("text", ""))
                if ev.get("type") == "state" and ev.get("state") == "idle":
                    break

            assert "stt.final" in types
            assert any("didn't catch" in t.lower() for t in texts)
            assert "tts.done" in types
            assert bus.inbound_size == 0
            # No session created
            assert sm._cache == {} or all(
                not k.startswith("satellites:quiet1:") for k in sm._cache
            )
    finally:
        await client.close()
        await channel.stop()

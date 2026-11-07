"""Voice mode backend (spec 173): /ws/voice, TTS hook, sessions."""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from aiohttp.test_utils import TestClient, TestServer

from sarathy.bus.events import OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.channels.dashboard.server import DashboardChannel, _CSP
from sarathy.config.loader import save_config
from sarathy.config.schema import Config
from sarathy.session.manager import SessionManager
from sarathy.voice.stripper import strip_for_speech
from sarathy.voice.voice_session import SttMode, VoiceSession, VoiceState, session_key
from sarathy.voice.woof_engine import WoofEngine


def _write_config(config_path: Path, workspace: Path, keys: list[str]) -> None:
    cfg = Config()
    cfg.channels.dashboard.enabled = True
    cfg.channels.dashboard.pairing_keys = keys
    cfg.agents.defaults.workspace = str(workspace)
    save_config(cfg, config_path)


def _make_channel(config_path: Path, workspace: Path) -> DashboardChannel:
    cfg = Config()
    cfg.channels.dashboard.enabled = True
    cfg.channels.dashboard.pairing_keys = ["test-key"]
    cfg.agents.defaults.workspace = str(workspace)
    session_manager = SessionManager(cfg, workspace=workspace)
    return DashboardChannel(
        cfg.channels.dashboard,
        MessageBus(),
        session_manager=session_manager,
        config_path=config_path,
        devices_path=config_path.parent / "devices.json",
    )


async def _pair(client: TestClient) -> str:
    resp = await client.post("/api/auth/pair", json={"key": "test-key", "deviceName": "iphone"})
    assert resp.status == 200
    return (await resp.json())["token"]


async def _authed_client(tmp_path: Path) -> tuple[TestClient, DashboardChannel]:
    config_path = tmp_path / "config.json"
    workspace = tmp_path / "ws"
    _write_config(config_path, workspace, ["test-key"])
    channel = _make_channel(config_path, workspace)
    client = TestClient(TestServer(channel._build_app()))
    return client, channel


class _FakeWoof:
    def __init__(self):
        self.calls: list[str] = []

    def __call__(self, text: str):
        self.calls.append(text)
        import numpy as np

        return np.zeros(2400, dtype=np.float32)


@pytest.fixture(autouse=True)
def _reset_woof_singleton():
    WoofEngine.reset_singleton_for_tests()
    yield
    WoofEngine.reset_singleton_for_tests()


# ---------------------------------------------------------------------------
# Stripper
# ---------------------------------------------------------------------------


def test_stripper_drops_code_tables_urls() -> None:
    raw = (
        "Hello world.\n\n"
        "```python\nprint('x')\n```\n\n"
        "| Col | Val |\n| --- | --- |\n| a | 1 |\n\n"
        "See https://example.com for details.\n\n"
        "Done."
    )
    out = strip_for_speech(raw)
    assert "print" not in out
    assert "example.com" not in out
    assert "|" not in out
    assert "Hello world" in out
    assert "Done" in out


def test_stripper_openui_fence() -> None:
    raw = "Summary.\n\n```openui-lang\nCard { title: \"Hi\" }\n```\n\nTail."
    out = strip_for_speech(raw)
    assert "Card" not in out
    assert "Summary" in out
    assert "Tail" in out


# ---------------------------------------------------------------------------
# Session keys
# ---------------------------------------------------------------------------


def test_voice_session_key_namespace() -> None:
    sid = "20261107-025412-a3f9c1"
    key = session_key(sid)
    assert key.startswith("voice:")
    assert key != "dashboard:console"
    assert "voice:" not in "dashboard:console"


# ---------------------------------------------------------------------------
# HTTP / auth / model
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_ws_voice_rejects_bad_token(tmp_path: Path) -> None:
    client, _ = await _authed_client(tmp_path)
    async with client:
        resp = await client.get("/ws/voice?token=bogus")
        assert resp.status == 401


@pytest.mark.asyncio
async def test_voice_model_404_when_missing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))
    client, _ = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        resp = await client.get(
            "/api/voice/model/shruti-tamil.cact",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status == 404


@pytest.mark.asyncio
async def test_voice_model_streams_when_present(tmp_path: Path, monkeypatch) -> None:
    blob = (
        tmp_path / ".sarathy" / "models" / "shruti" / "shruti-tamil.cact"
    )
    blob.parent.mkdir(parents=True)
    blob.write_bytes(b"cact-test-bytes")
    monkeypatch.setattr(Path, "home", classmethod(lambda cls: tmp_path))

    client, _ = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        resp = await client.get(
            "/api/voice/model/shruti-tamil.cact",
            headers={"Authorization": f"Bearer {token}"},
        )
        assert resp.status == 200
        assert resp.headers.get("Cache-Control", "").startswith("public")
        assert "immutable" in resp.headers.get("Cache-Control", "")
        body = await resp.read()
        assert body == b"cact-test-bytes"


# ---------------------------------------------------------------------------
# Prep / cancel / modes
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_prep_sequence_server_stt(tmp_path: Path, monkeypatch) -> None:
    client, channel = await _authed_client(tmp_path)
    woof = channel._voice.woof

    def _load():
        woof._tts = _FakeWoof()
        woof._split_text = lambda t: [t] if t.strip() else []

    monkeypatch.setattr(woof, "load", _load)
    shruti = channel._voice.shruti
    monkeypatch.setattr(shruti, "load", lambda: setattr(shruti, "_engine", object()))

    async with client:
        token = await _pair(client)
        async with client.ws_connect(f"/ws/voice?token={token}") as ws:
            await ws.send_str(
                json.dumps(
                    {"type": "start", "voice": "juno", "stt": "shruti-tamil", "mode": "server_stt"}
                )
            )
            types = []
            for _ in range(20):
                msg = await asyncio.wait_for(ws.receive(), timeout=5)
                if msg.type.name == "CLOSE":
                    break
                data = json.loads(msg.data)
                types.append(data.get("type"))
                if data.get("type") == "ready":
                    break
            assert "prep" in types
            assert "ready" in types
            assert channel._voice.session.state == VoiceState.LIVE
            await ws.send_str(json.dumps({"type": "cancel", "reason": "test"}))
            for _ in range(10):
                msg = await asyncio.wait_for(ws.receive(), timeout=5)
                if msg.type.name == "CLOSE":
                    break
                data = json.loads(msg.data)
                if data.get("type") == "ended":
                    break
            assert not woof.loaded
            assert not shruti.loaded


@pytest.mark.asyncio
async def test_client_stt_skips_server_shruti_load(tmp_path: Path, monkeypatch) -> None:
    client, channel = await _authed_client(tmp_path)
    woof = channel._voice.woof

    def _load():
        woof._tts = _FakeWoof()

        def _split(t):
            return [t] if t.strip() else []

        woof._split_text = _split

    monkeypatch.setattr(woof, "load", _load)
    load_called = {"n": 0}
    real_load = channel._voice.shruti.load

    def _track_load():
        load_called["n"] += 1
        return real_load()

    monkeypatch.setattr(channel._voice.shruti, "load", _track_load)

    async with client:
        token = await _pair(client)
        async with client.ws_connect(f"/ws/voice?token={token}") as ws:
            await ws.send_str(
                json.dumps(
                    {
                        "type": "start",
                        "voice": "juno",
                        "stt": "shruti-tamil",
                        "mode": "client_stt",
                    }
                )
            )
            while True:
                msg = await asyncio.wait_for(ws.receive(), timeout=5)
                data = json.loads(msg.data)
                if data.get("type") == "ready":
                    break
            assert channel._voice.session.stt_mode == SttMode.CLIENT_STT
            assert load_called["n"] == 0
            await ws.send_str(json.dumps({"type": "cancel"}))


# ---------------------------------------------------------------------------
# Sentence order (TTS hook)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_sentence_synthesis_order(monkeypatch) -> None:
    engine = WoofEngine.singleton()
    engine._tts = _FakeWoof()
    engine._split_text = lambda t: [p.strip() for p in t.split(".") if p.strip()]
    order: list[tuple[int, str]] = []

    def _pcm(sentence: str) -> bytes:
        order.append((len(order) + 1, sentence))
        return b"\x00\x01"

    monkeypatch.setattr(engine, "synthesize_sentence_pcm", _pcm)
    for seq, sentence, pcm in engine.synthesize_answer_stream("One. Two. Three."):
        assert pcm == b"\x00\x01"
        assert seq == order[-1][0]
    assert [s for _, s in order] == ["One", "Two", "Three"]


@pytest.mark.asyncio
async def test_send_hook_diffs_progress_not_tool_hint(tmp_path: Path, monkeypatch) -> None:
    client, channel = await _authed_client(tmp_path)
    session = VoiceSession()
    session.session_id = "abc123"
    session.state = VoiceState.LIVE
    channel._voice.session = session
    pcm_calls: list[str] = []

    def _fake_pcm(sentence: str) -> bytes:
        pcm_calls.append(sentence)
        return b"\x00\x00" * 100

    channel._voice.woof._tts = object()
    monkeypatch.setattr(channel._voice.woof, "synthesize_sentence_pcm", _fake_pcm)
    monkeypatch.setattr(
        channel._voice.woof,
        "sentences_from_answer",
        lambda t: [strip_for_speech(t)] if t.strip() else [],
    )
    channel._voice._ws = MagicMock()
    channel._voice._ws.closed = False
    channel._voice._ws.send_str = AsyncMock()
    channel._voice._ws.send_bytes = AsyncMock()

    await channel.send(
        OutboundMessage(
            channel="voice",
            chat_id="abc123",
            content="Searching…",
            metadata={"_progress": True, "_tool_hint": True},
        )
    )
    assert pcm_calls and pcm_calls[0] == _FILLER

    await channel.send(
        OutboundMessage(
            channel="voice",
            chat_id="abc123",
            content="Hello there.",
            metadata={"_progress": True},
        )
    )
    assert "Hello" in "".join(pcm_calls)


_FILLER = "One moment, sir."


# ---------------------------------------------------------------------------
# History keeps original LLM text
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_history_stores_original_llm_text(tmp_path: Path) -> None:
    client, channel = await _authed_client(tmp_path)
    sm = channel.session_manager
    sid = "20261107-111111-deadbe"
    key = session_key(sid)
    session = sm.get_or_create(key)
    original = "Here is the answer.\n\n```python\nx=1\n```\n\nEnd."
    session.add_message("assistant", original)
    sm.save(session)

    async with client:
        token = await _pair(client)
        resp = await client.get("/api/session", params={"key": key}, headers={"Authorization": f"Bearer {token}"})
        assert resp.status == 200
        messages = (await resp.json())["messages"]
        assert messages[-1]["content"] == original
        assert "```" in messages[-1]["content"]


@pytest.mark.asyncio
async def test_voice_prep_step_emits_running_done(tmp_path: Path) -> None:
    session = VoiceSession()
    session.stt_mode = SttMode.CLIENT_STT
    frames: list[tuple[str, str]] = []

    async def emit(step: str, status: str, ms: int | None) -> None:
        frames.append((step, status))

    async def noop() -> None:
        return None

    ready = await session.run_prep(
        emit,
        load_tts=noop,
        load_stt=None,
        open_audio=noop,
    )
    assert ready["session_id"]
    assert session.state == VoiceState.LIVE
    steps = [s for s, st in frames if st == "running"]
    assert "tts" in steps


def test_dashboard_csp_allows_wasm_workers() -> None:
    assert "'wasm-unsafe-eval'" in _CSP
    assert "worker-src 'self' blob:" in _CSP


@pytest.mark.asyncio
async def test_teardown_idempotent() -> None:
    session = VoiceSession()
    session.state = VoiceState.LIVE
    session.session_id = "x"
    n = {"u": 0}

    async def unload() -> None:
        n["u"] += 1

    await session.teardown(unload)
    await session.teardown(unload)
    assert n["u"] == 2
    assert session.state == VoiceState.IDLE

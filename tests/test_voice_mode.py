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
from sarathy.channels.dashboard.server import _CSP, DashboardChannel
from sarathy.config.loader import save_config
from sarathy.config.schema import Config
from sarathy.session.manager import SessionManager
from sarathy.voice.stripper import strip_for_speech
from sarathy.voice.voice_session import SttMode, VoiceSession, VoiceState, session_key
from sarathy.voice.stt_config import DEFAULT_STT_MODEL_ID
from sarathy.voice.utterance_gate import MIN_UTTERANCE_SAMPLES, utterance_passes_gate
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


def test_stripper_drops_inline_markdown_markers() -> None:
    """Emphasis/heading/list markers must never reach the synthesizer.

    Woof's splitter passes them through verbatim, so a leaked ``**`` is spoken
    as "asterisk asterisk".
    """
    raw = (
        "## Status\n\n"
        "The version is **v0.20.0**.\n\n"
        "- bullet one\n"
        "- bullet two\n\n"
        "This is *emphasis* and ~~struck~~.\n\n"
        "See [the docs](https://example.com/x)."
    )
    out = strip_for_speech(raw)
    for marker in ("**", "__", "##", "~~", "](", "https://"):
        assert marker not in out, f"marker {marker!r} leaked into {out!r}"
    assert "v0.20.0" in out
    assert "Status" in out
    assert "bullet one" in out
    assert "emphasis" in out
    assert "the docs" in out


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


def test_utterance_gate_rejects_silence() -> None:
    import struct

    silence = b"\x00\x00" * MIN_UTTERANCE_SAMPLES
    assert not utterance_passes_gate(silence)
    tone = struct.pack("<" + "h" * MIN_UTTERANCE_SAMPLES, *([12000] * MIN_UTTERANCE_SAMPLES))
    assert utterance_passes_gate(tone)


def test_default_stt_is_english() -> None:
    from sarathy.voice.voice_session import VoiceSession

    assert VoiceSession().stt_model == DEFAULT_STT_MODEL_ID
    assert DEFAULT_STT_MODEL_ID == "shruti-en"


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
async def test_voice_capture_worklet_is_served(tmp_path: Path) -> None:
    """``/voice-capture-processor.js`` must be served, not 404.

    capture.ts resolves the AudioWorklet module relative to window.location and
    passes it to audioWorklet.addModule(). A 404 there rejects inside
    capture.start(), which used to be swallowed — the UI hung on
    "Preparing voice session…" with no error.
    """
    client, _ = await _authed_client(tmp_path)
    async with client:
        resp = await client.get("/voice-capture-processor.js")
        assert resp.status == 200, resp.status
        body = await resp.text()
        assert "registerProcessor" in body
        assert "voice-capture-processor" in body


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


# ---------------------------------------------------------------------------
# Outbound routing (regression: "Unknown channel: voice" dropped the answer)
# ---------------------------------------------------------------------------


def test_voice_channel_routes_to_coordinator() -> None:
    """A ``voice`` outbound message must reach the coordinator, not be dropped.

    Without the VoiceChannel adapter the dispatcher logged
    ``Unknown channel: voice`` and the agent's answer never reached the socket.
    """
    from sarathy.voice.channel import VoiceChannel

    coordinator = MagicMock()
    coordinator.handle_outbound = AsyncMock()
    ch = VoiceChannel(MessageBus(), coordinator)
    msg = OutboundMessage(channel="voice", chat_id="s-1", content="hello")
    asyncio.run(ch.send(msg))
    coordinator.handle_outbound.assert_awaited_once_with(msg)


def test_voice_channel_registered_in_manager() -> None:
    """The manager must expose a ``voice`` channel whenever dashboard is on."""
    import inspect

    from sarathy.channels import manager as manager_mod

    src = inspect.getsource(manager_mod.ChannelManager._init_channels)
    assert 'self.channels["voice"]' in src
    assert "VoiceChannel" in src


@pytest.mark.asyncio
async def test_dispatcher_delivers_voice_outbound_to_socket(tmp_path: Path, monkeypatch) -> None:
    """End-to-end: bus outbound for ``voice`` reaches the socket, not the log.

    Regression for ``Unknown channel: voice`` — the agent produced an answer but
    the dispatcher dropped it because no ``voice`` channel was registered, so the
    WebSocket saw ``thinking`` and then silence.
    """
    from sarathy.channels.manager import ChannelManager

    client, channel = await _authed_client(tmp_path)
    voice = channel._voice
    voice.session.session_id = "sess-1"
    voice.session.state = VoiceState.LIVE
    voice.woof._tts = object()
    monkeypatch.setattr(voice.woof, "synthesize_sentence_pcm", lambda s: b"\x00\x00" * 50)
    monkeypatch.setattr(
        voice.woof, "sentences_from_answer", lambda t: [t] if t.strip() else []
    )
    ws = MagicMock()
    ws.closed = False
    ws.send_str = AsyncMock()
    ws.send_bytes = AsyncMock()
    voice._ws = ws
    # The audio pump is normally started by the /ws/voice handler.
    voice._audio_worker = asyncio.create_task(voice._audio_sender())

    cfg = Config()
    cfg.channels.dashboard.enabled = True
    mgr = ChannelManager(cfg, bus=channel.bus)
    # _init_channels builds its own DashboardChannel; point the voice adapter at
    # the coordinator we just armed with a fake socket.
    mgr.channels["voice"].coordinator = voice
    dispatcher = asyncio.create_task(mgr._dispatch_outbound())
    try:
        await channel.bus.publish_outbound(
            OutboundMessage(
                channel="voice", chat_id="sess-1", content="All systems nominal.",
                metadata={"_progress": True},
            )
        )
        for _ in range(50):
            await asyncio.sleep(0.02)
            if ws.send_bytes.await_count:
                break
    finally:
        dispatcher.cancel()
        if voice._audio_worker is not None:
            voice._audio_worker.cancel()
        try:
            await dispatcher
        except asyncio.CancelledError:
            pass

    assert ws.send_bytes.await_count >= 1, "no audio reached the socket"
    frames = [json.loads(c.args[0]) for c in ws.send_str.await_args_list]
    assert any(f.get("type") == "text" for f in frames), frames


# ---------------------------------------------------------------------------
# Server STT accumulation (regression: buffer was replaced, not appended)
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_speech_end_skips_silent_utterance(tmp_path: Path, monkeypatch) -> None:
    client, channel = await _authed_client(tmp_path)
    voice = channel._voice
    woof = voice.woof

    def _load():
        woof._tts = _FakeWoof()
        woof._split_text = lambda t: [t] if t.strip() else []

    monkeypatch.setattr(woof, "load", _load)
    monkeypatch.setattr(voice.shruti, "load", lambda: setattr(voice.shruti, "_engine", object()))
    voice.shruti.transcribe_pcm16_16k = lambda pcm: "hallucination"
    voice._submit_utterance = AsyncMock()

    async with client:
        token = await _pair(client)
        async with client.ws_connect(f"/ws/voice?token={token}") as ws:
            await ws.send_str(json.dumps({"type": "start", "mode": "server_stt"}))
            while True:
                data = json.loads((await asyncio.wait_for(ws.receive(), timeout=5)).data)
                if data.get("type") == "ready":
                    break
            await ws.send_str(json.dumps({"type": "speech_start", "ts": 0}))
            await ws.send_bytes(b"\x00\x00" * 800)
            await ws.send_str(json.dumps({"type": "speech_end", "ts": 1}))
            for _ in range(8):
                data = json.loads((await asyncio.wait_for(ws.receive(), timeout=5)).data)
                if data.get("type") == "state" and data.get("state") == "listening":
                    break
            voice._submit_utterance.assert_not_called()


@pytest.mark.asyncio
async def test_server_stt_accumulates_whole_utterance(tmp_path: Path, monkeypatch) -> None:
    """Each audio chunk must extend the buffer; the final text covers all of it.

    The first implementation assigned ``buffer = text`` per 0.5 s chunk, so a
    three-part utterance submitted only its last fragment ("y").
    """
    client, channel = await _authed_client(tmp_path)
    voice = channel._voice
    woof = voice.woof

    def _load():
        woof._tts = _FakeWoof()
        woof._split_text = lambda t: [t] if t.strip() else []

    monkeypatch.setattr(woof, "load", _load)
    seen: list[int] = []

    def _transcribe(pcm: bytes) -> str:
        seen.append(len(pcm))
        return f"part{len(seen)}"

    monkeypatch.setattr(voice.shruti, "load", lambda: setattr(voice.shruti, "_engine", object()))
    monkeypatch.setattr(voice.shruti, "transcribe_pcm16_16k", _transcribe)
    monkeypatch.setattr(voice, "_submit_utterance", AsyncMock())

    async with client:
        token = await _pair(client)
        async with client.ws_connect(f"/ws/voice?token={token}") as ws:
            await ws.send_str(json.dumps({"type": "start", "mode": "server_stt"}))
            while True:
                data = json.loads((await asyncio.wait_for(ws.receive(), timeout=5)).data)
                if data.get("type") == "ready":
                    break

            await ws.send_str(json.dumps({"type": "speech_start", "ts": 0}))
            import struct

            chunk = struct.pack("<" + "h" * 16000, *([12000] * 16000))
            for _ in range(3):
                await ws.send_bytes(chunk)
                # Skip the throttled live partial so only speech_end transcribes.
                voice._last_partial_ts = 1e9
            await ws.send_str(json.dumps({"type": "speech_end", "ts": 3}))

            for _ in range(10):
                data = json.loads((await asyncio.wait_for(ws.receive(), timeout=5)).data)
                if data.get("type") == "partial" and data.get("is_final"):
                    break

            # The final transcribe saw all three chunks, not just the last one.
            assert seen, "transcribe was never called"
            assert seen[-1] == 3 * len(chunk)
            voice._submit_utterance.assert_awaited_once()
            assert voice._submit_utterance.await_args.args[0] == f"part{len(seen)}"
            assert voice._server_stt_pcm == bytearray()

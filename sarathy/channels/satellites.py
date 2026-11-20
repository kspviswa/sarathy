"""Satellites channel — LAN-only ESP32 voice pucks on the gateway.

Auth is a source-IP CIDR allowlist only. There is no token, pairing code, or
key exchange: the device has no display and cannot enter one. Connections from
outside ``allow_cidrs`` are closed with code 4403 before any frame is read.

Routes mount on the dashboard's existing aiohttp listener (``/satellites/``);
this module never opens its own port and never imports dashboard voice mode.
Wake-word detection runs on the device — the gateway never sees a wake model.
"""

from __future__ import annotations

import asyncio
import ipaddress
import json
import math
import re
import struct
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, Callable
from urllib.parse import parse_qs

from aiohttp import WSMsgType, web
from loguru import logger

from sarathy.bus.events import InboundMessage, OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.channels.base import BaseChannel
from sarathy.config.schema import SatellitesConfig

MIC_SR = 16_000
TTS_SR = 24_000
BYTES_PER_SAMPLE = 2
CHUNK_MS = 100
CHUNK_BYTES = TTS_SR * BYTES_PER_SAMPLE * CHUNK_MS // 1000  # 100 ms @ 24 kHz
_TTS_SCRIPT = Path.home() / ".sarathy" / "workspace" / "voice" / "tts.sh"

_EMPTY_TRANSCRIPT = re.compile(r"^[\W_\s]*$")


def normalize_peer_ip(remote: str | None) -> ipaddress._BaseAddress | None:
    """Parse a peer address; map IPv4-mapped IPv6 (``::ffff:x.x.x.x``) to IPv4."""
    if not remote:
        return None
    try:
        addr = ipaddress.ip_address(remote.split("%")[0])
    except ValueError:
        return None
    if isinstance(addr, ipaddress.IPv6Address) and addr.ipv4_mapped is not None:
        return addr.ipv4_mapped
    return addr


def ip_allowed(remote: str | None, allow_cidrs: list[str]) -> bool:
    """Return True if ``remote`` falls inside any configured CIDR."""
    addr = normalize_peer_ip(remote)
    if addr is None:
        return False
    for cidr in allow_cidrs:
        try:
            network = ipaddress.ip_network(cidr, strict=False)
        except ValueError:
            continue
        if addr in network:
            return True
    return False


def mint_wake_id() -> str:
    """Fresh, unique, sortable wake id: ``YYYYMMDD-HHMMSS-<6 hex>``."""
    return datetime.now().strftime("%Y%m%d-%H%M%S") + "-" + uuid.uuid4().hex[:6]


def is_empty_transcript(text: str) -> bool:
    return not text or bool(_EMPTY_TRANSCRIPT.match(text.strip()))


def pop_complete_sentences(buf: str) -> tuple[list[str], str]:
    """Split ``buf`` into complete sentences and an incomplete remainder."""
    if not buf.strip():
        return [], ""
    complete: list[str] = []
    start = 0
    for m in re.finditer(r"[.!?]+(?:\s+|$)", buf):
        piece = buf[start : m.end()].strip()
        if piece:
            complete.append(piece)
        start = m.end()
    return complete, buf[start:]


def _tone_pcm(seconds: float = 0.4, sr: int = TTS_SR, freq: float = 440.0) -> bytes:
    n = int(seconds * sr)
    return b"".join(
        struct.pack("<h", int(6000 * math.sin(2 * math.pi * freq * i / sr)))
        for i in range(n)
    )


def decode_audio_to_pcm(path: str, sr: int = TTS_SR) -> bytes:
    """Decode an audio file to mono 16-bit PCM at ``sr`` using ffmpeg.

    The device only understands raw PCM s16le, so any container the firmware
    cannot play (mp3, ogg, m4a) is converted once at startup and cached. This
    keeps the wire format identical to TTS output — no codec negotiation.

    Raises ``RuntimeError`` when ffmpeg is missing or the file cannot be read.
    """
    import subprocess

    try:
        proc = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-i",
                str(path),
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ac",
                "1",
                "-ar",
                str(sr),
                "-",
            ],
            capture_output=True,
            check=False,
        )
    except FileNotFoundError as e:
        raise RuntimeError("ffmpeg not found on PATH") from e
    if proc.returncode != 0:
        err = proc.stderr.decode("utf-8", "replace").strip()
        raise RuntimeError(err[:300] or f"ffmpeg exited {proc.returncode}")
    if not proc.stdout:
        raise RuntimeError("decoded audio is empty")
    return proc.stdout


def wav_to_pcm(path: str, sr: int = TTS_SR) -> bytes:
    """Read a WAV's real header, then return int16 mono PCM at ``sr``.

    The engine's advertised rate is never trusted — the header is the truth.
    Linear interpolation resamples when the engine uses another rate (the
    satellite wire contract is 24 kHz).
    """
    import wave

    import numpy as np

    with wave.open(path, "rb") as handle:
        rate = handle.getframerate()
        channels = handle.getnchannels()
        width = handle.getsampwidth()
        frames = handle.readframes(handle.getnframes())
    if width != 2:
        raise ValueError(f"expected 16-bit WAV samples, got {width * 8}-bit")
    if not frames:
        return b""

    samples = np.frombuffer(frames, dtype="<i2")
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    if rate != sr:
        count = max(1, int(round(len(samples) * sr / rate)))
        samples = np.interp(
            np.linspace(0, len(samples) - 1, count),
            np.arange(len(samples)),
            samples.astype(np.float64),
        )
    return np.clip(np.rint(samples), -32768, 32767).astype("<i2").tobytes()


@dataclass
class _LiveTurn:
    ws: web.WebSocketResponse
    device_id: str
    wake_id: str
    session_key: str
    chat_id: str
    mic: bytearray = field(default_factory=bytearray)
    listening: bool = False
    spoken_seq: int = 0
    spoken_chars: int = 0
    buf: str = ""
    filler_spoken: bool = False
    first_sentence: bool = False
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    filler_task: asyncio.Task | None = None
    closed: bool = False


class SatellitesChannel(BaseChannel):
    """WebSocket channel for screenless LAN voice satellites."""

    name = "satellites"

    def __init__(
        self,
        config: SatellitesConfig,
        bus: MessageBus,
        agent: Any = None,
        session_manager: Any = None,
        *,
        stt_fn: Callable[[bytes], str] | None = None,
        tts_fn: Callable[[str], bytes] | None = None,
    ):
        super().__init__(config, bus)
        self.config: SatellitesConfig = config
        self.agent = agent
        self.session_manager = session_manager
        self._stt_fn = stt_fn
        self._tts_fn = tts_fn
        self._turns: dict[str, _LiveTurn] = {}  # chat_id → live turn
        self._live_count = 0
        self._rate: dict[str, list[float]] = {}
        self._filler_pcm: bytes | None = None
        self._filler_is_cue = False  # True when _filler_pcm came from filler_sound
        self._whisper = None
        self._conn_session_ids: dict[int, str] = {}  # id(ws) → session_id

    # ------------------------------------------------------------------ mount

    def mount(self, app: web.Application) -> None:
        """Attach ``/satellites/ws`` and ``/satellites/health`` to ``app``."""
        app.router.add_get("/satellites/ws", self._ws_handler)
        app.router.add_get("/satellites/health", self._health)

    async def _health(self, request: web.Request) -> web.Response:
        return web.json_response({"ok": True, "devices": self._live_count})

    # ------------------------------------------------------------------ lifecycle

    async def start(self) -> None:
        self._running = True
        if self.config.filler_sound:
            try:
                self._filler_pcm = await asyncio.to_thread(
                    decode_audio_to_pcm, self.config.filler_sound
                )
                self._filler_is_cue = True
                logger.info(
                    "Satellites: processing cue loaded from {} ({} bytes PCM)",
                    self.config.filler_sound,
                    len(self._filler_pcm),
                )
            except Exception as e:
                logger.warning(
                    "Satellites: failed to load processing cue {}: {}",
                    self.config.filler_sound,
                    e,
                )
                self._filler_pcm = None
        if self._filler_pcm is None:
            try:
                self._filler_pcm = await asyncio.to_thread(
                    self._synthesize, self.config.filler_phrase
                )
            except Exception as e:
                logger.warning("Satellites: failed to pre-cache filler TTS: {}", e)
                self._filler_pcm = _tone_pcm(0.6)
        logger.info("Satellites channel ready (CIDR gate: {})", self.config.allow_cidrs)

    async def stop(self) -> None:
        self._running = False
        for turn in list(self._turns.values()):
            await self._cleanup_turn(turn)
        self._turns.clear()

    # ------------------------------------------------------------------ access control

    def _rate_ok(self, ip: str) -> bool:
        now = time.monotonic()
        window = [t for t in self._rate.get(ip, []) if now - t < 60.0]
        if len(window) >= self.config.rate_limit_per_min:
            self._rate[ip] = window
            return False
        window.append(now)
        self._rate[ip] = window
        return True

    # ------------------------------------------------------------------ STT / TTS

    def _get_whisper(self):
        if self._whisper is None:
            from faster_whisper import WhisperModel

            self._whisper = WhisperModel(
                self.config.stt_model, device="cpu", compute_type="int8"
            )
        return self._whisper

    def _transcribe(self, pcm: bytes) -> str:
        if self._stt_fn is not None:
            return (self._stt_fn(pcm) or "").strip()
        if not pcm:
            return ""
        import numpy as np

        model = self._get_whisper()
        audio = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        segments, _ = model.transcribe(audio, language="en")
        return " ".join(s.text.strip() for s in segments).strip()

    def _synthesize(self, text: str) -> bytes:
        if self._tts_fn is not None:
            return self._tts_fn(text) or b""
        text = (text or "").strip()
        if not text:
            return b""

        import os
        import subprocess
        import tempfile

        script = Path(
            os.environ.get("SARATHY_TTS_SCRIPT") or str(_TTS_SCRIPT)
        ).expanduser()
        fd, wav_path = tempfile.mkstemp(prefix="sat-tts-", suffix=".wav")
        os.close(fd)
        try:
            proc = subprocess.run(
                [str(script), text, wav_path, "--format", "wav"],
                capture_output=True,
                check=False,
                timeout=180,
            )
            if proc.returncode != 0:
                err = proc.stderr.decode("utf-8", "replace").strip()
                raise RuntimeError(err[:300] or f"tts.sh exited {proc.returncode}")
            return wav_to_pcm(wav_path, TTS_SR)
        except Exception as e:
            logger.warning("TTS script failed ({}): falling back to tone", e)
            return _tone_pcm(0.5)
        finally:
            Path(wav_path).unlink(missing_ok=True)

    # ------------------------------------------------------------------ ws helpers

    async def _send_json(self, ws: web.WebSocketResponse, obj: dict) -> None:
        if ws.closed:
            return
        await ws.send_str(json.dumps(obj, ensure_ascii=False))

    async def _send_state(self, ws: web.WebSocketResponse, state: str) -> None:
        await self._send_json(ws, {"type": "state", "state": state})

    async def _send_error(
        self,
        ws: web.WebSocketResponse,
        code: str,
        message: str,
        *,
        recoverable: bool = True,
    ) -> None:
        await self._send_json(
            ws,
            {
                "type": "error",
                "code": code,
                "message": message,
                "recoverable": recoverable,
            },
        )

    async def _stream_pcm(self, ws: web.WebSocketResponse, pcm: bytes) -> None:
        for i in range(0, len(pcm), CHUNK_BYTES):
            if ws.closed:
                return
            await ws.send_bytes(pcm[i : i + CHUNK_BYTES])
            await asyncio.sleep(0)  # yield

    async def _speak_sentence(self, turn: _LiveTurn, text: str) -> None:
        text = text.strip()
        if not text or turn.closed or turn.ws.closed:
            return
        turn.spoken_seq += 1
        seq = turn.spoken_seq
        pcm = await asyncio.to_thread(self._synthesize, text)
        if not turn.first_sentence:
            turn.first_sentence = True
            await self._send_state(turn.ws, "speaking")
        await self._send_json(
            turn.ws,
            {
                "type": "tts.sentence",
                "seq": seq,
                "text": text,
                "sample_rate": TTS_SR,
            },
        )
        if pcm:
            await self._stream_pcm(turn.ws, pcm)
        await self._send_json(turn.ws, {"type": "tts.sentence_end", "seq": seq})

    async def _speak_text(self, turn: _LiveTurn, text: str) -> None:
        sentences, rest = pop_complete_sentences(text)
        for s in sentences:
            await self._speak_sentence(turn, s)
        if rest.strip():
            await self._speak_sentence(turn, rest.strip())

    async def _speak_new_from_buf(self, turn: _LiveTurn, *, final: bool = False) -> None:
        """Speak only the unspoken tail of the accumulated buffer.

        Progress frames carry growing prefixes of the same reply, so
        ``spoken_chars`` remembers how far we already spoke and we only
        split/emit from the remainder. Incomplete trailing fragments wait
        for the next frame (or for ``final=True``).
        """
        if turn.spoken_chars > len(turn.buf):
            turn.spoken_chars = 0
        unspoken = turn.buf[turn.spoken_chars :]
        sentences, rest = pop_complete_sentences(unspoken)
        for s in sentences:
            await self._speak_sentence(turn, s)
        # Advance past complete sentences only — leave the fragment pending.
        turn.spoken_chars += len(unspoken) - len(rest)
        if final and rest.strip():
            await self._speak_sentence(turn, rest.strip())
            turn.spoken_chars = len(turn.buf)

    async def _finish_turn(self, turn: _LiveTurn) -> None:
        if turn.closed:
            return
        await self._send_json(turn.ws, {"type": "tts.done"})
        await self._send_state(turn.ws, "idle")
        # Archive so the dashboard Sessions drill-down sees one entry per wake.
        if self.session_manager is not None and turn.session_key:
            try:
                session = self.session_manager.get_or_create(turn.session_key)
                if session.messages:
                    session.archive_session()
                self.session_manager.invalidate(turn.session_key)
            except Exception as e:
                logger.warning(
                    "Satellites: failed to archive {}: {}", turn.session_key, e
                )
        await self._cleanup_turn(turn)

    async def _cleanup_turn(self, turn: _LiveTurn) -> None:
        turn.closed = True
        if turn.filler_task and not turn.filler_task.done():
            turn.filler_task.cancel()
            try:
                await turn.filler_task
            except (asyncio.CancelledError, Exception):
                pass
            turn.filler_task = None
        if self._turns.get(turn.chat_id) is turn:
            self._turns.pop(turn.chat_id, None)

    async def _filler_watch(self, turn: _LiveTurn) -> None:
        try:
            await asyncio.sleep(self.config.filler_after_s)
            async with turn.lock:
                if turn.closed or turn.first_sentence or turn.filler_spoken:
                    return
                turn.filler_spoken = True
                pcm = self._filler_pcm or await asyncio.to_thread(
                    self._synthesize, self.config.filler_phrase
                )
                # A cue is audio-only: no phrase text, so the device shows no
                # subtitle while the chime plays.
                text = "" if self._filler_is_cue else self.config.filler_phrase
                turn.spoken_seq += 1
                seq = turn.spoken_seq
                await self._send_state(turn.ws, "speaking")
                await self._send_json(
                    turn.ws,
                    {
                        "type": "tts.sentence",
                        "seq": seq,
                        "text": text,
                        "sample_rate": TTS_SR,
                    },
                )
                if pcm:
                    await self._stream_pcm(turn.ws, pcm)
                await self._send_json(
                    turn.ws, {"type": "tts.sentence_end", "seq": seq}
                )
                # Filler is not the answer — return to thinking LEDs until real TTS.
                if not turn.first_sentence:
                    await self._send_state(turn.ws, "thinking")
        except asyncio.CancelledError:
            return

    # ------------------------------------------------------------------ outbound (agent → device)

    async def send(self, msg: OutboundMessage) -> None:
        turn = self._turns.get(msg.chat_id)
        if turn is None or turn.closed or turn.ws.closed:
            return
        meta = msg.metadata or {}
        if meta.get("_turn_state") or meta.get("_thinking"):
            return
        if meta.get("_tool_hint") and not meta.get("_seal") and not meta.get("_final"):
            return

        content = msg.content or ""
        async with turn.lock:
            if turn.closed:
                return
            if meta.get("_final"):
                # Full final answer — speak only what streaming has not already
                # covered (spoken_chars offset into the accumulated prefix).
                if content.strip():
                    turn.buf = content
                    await self._speak_new_from_buf(turn, final=True)
                elif turn.buf.strip():
                    await self._speak_new_from_buf(turn, final=True)
                await self._finish_turn(turn)
                return

            if meta.get("_seal"):
                # One-shot prose bubble (emitted before a tool call). Speak the
                # whole block once, then reset offsets so a later `_final` that
                # happens to share a prefix cannot be consumed by seal's offset.
                if content.strip():
                    turn.buf = content
                    await self._speak_new_from_buf(turn, final=True)
                turn.buf = ""
                turn.spoken_chars = 0
                return

            if meta.get("_progress"):
                # Accumulated prefix of the growing reply.
                turn.buf = content
                await self._speak_new_from_buf(turn, final=False)
                return

            # Bare outbound (no progress/final flags) — treat as final answer.
            if content.strip():
                turn.buf = content
                await self._speak_new_from_buf(turn, final=True)
                await self._finish_turn(turn)

    # ------------------------------------------------------------------ websocket handler

    async def _ws_handler(self, request: web.Request) -> web.StreamResponse:
        remote = request.remote or ""
        if not ip_allowed(remote, self.config.allow_cidrs):
            logger.warning(
                "Satellites: rejected non-LAN peer {} (allow_cidrs={})",
                remote,
                self.config.allow_cidrs,
            )
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await ws.close(code=4403, message=b"not on allowed LAN")
            return ws

        peer_key = str(normalize_peer_ip(remote) or remote)
        if not self._rate_ok(peer_key):
            logger.warning("Satellites: rate limit exceeded for {}", peer_key)
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await ws.close(code=4429, message=b"rate limited")
            return ws

        if self._live_count >= self.config.max_concurrent:
            logger.warning(
                "Satellites: max_concurrent={} exceeded; rejecting {}",
                self.config.max_concurrent,
                peer_key,
            )
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await ws.close(code=4429, message=b"too many devices")
            return ws

        qs = parse_qs(request.query_string)
        device_id = (qs.get("device_id") or ["unknown"])[0]
        # device_id is self-declared labelling only — never an auth secret.

        ws = web.WebSocketResponse(heartbeat=30, max_msg_size=2 * 1024 * 1024)
        await ws.prepare(request)
        self._live_count += 1
        session_id = f"sat-{device_id}-{uuid.uuid4().hex[:8]}"
        self._conn_session_ids[id(ws)] = session_id
        chat_id = f"sat:{device_id}"
        logger.info(
            "Satellites: device {} connected from {} (session {})",
            device_id,
            peer_key,
            session_id,
        )

        current: _LiveTurn | None = None
        try:
            async for msg in ws:
                if msg.type == WSMsgType.BINARY:
                    if current is not None and current.listening:
                        current.mic.extend(msg.data)
                        cap = self.config.max_utterance_s * MIC_SR * BYTES_PER_SAMPLE
                        if len(current.mic) > cap:
                            await self._send_error(
                                ws,
                                "utterance_too_long",
                                f"max {self.config.max_utterance_s}s",
                                recoverable=True,
                            )
                            current.listening = False
                            current.mic.clear()
                            await self._send_state(ws, "idle")
                            await self._cleanup_turn(current)
                            current = None
                    continue

                if msg.type in (WSMsgType.CLOSE, WSMsgType.CLOSING, WSMsgType.ERROR):
                    break
                if msg.type != WSMsgType.TEXT:
                    continue

                try:
                    ev = json.loads(msg.data)
                except json.JSONDecodeError:
                    await self._send_error(
                        ws, "bad_frame", "invalid JSON", recoverable=True
                    )
                    continue

                t = ev.get("type")
                if t == "device.hello":
                    await self._send_json(
                        ws,
                        {
                            "type": "hello.ok",
                            "session_id": session_id,
                            "stt": {"sample_rate": MIC_SR},
                            "tts": {
                                "codec": "pcm_s16le",
                                "sample_rate": TTS_SR,
                                "channels": 1,
                            },
                        },
                    )
                elif t == "heartbeat":
                    pass
                elif t == "listen.start":
                    if current is not None and not current.closed:
                        await self._cleanup_turn(current)
                    wake_id = mint_wake_id()
                    session_key = f"satellites:{device_id}:{wake_id}"
                    current = _LiveTurn(
                        ws=ws,
                        device_id=device_id,
                        wake_id=wake_id,
                        session_key=session_key,
                        chat_id=chat_id,
                        listening=True,
                    )
                    self._turns[chat_id] = current
                    await self._send_state(ws, "listening")
                elif t == "listen.stop":
                    if current is None or not current.listening:
                        await self._send_error(
                            ws,
                            "not_listening",
                            "listen.stop without listen.start",
                            recoverable=True,
                        )
                        continue
                    current.listening = False
                    pcm = bytes(current.mic)
                    current.mic.clear()
                    await self._send_state(ws, "thinking")

                    transcript = await asyncio.to_thread(self._transcribe, pcm)
                    if is_empty_transcript(transcript):
                        await self._send_json(
                            ws, {"type": "stt.final", "text": ""}
                        )
                        # No session for empty/garbage — just speak and idle.
                        await self._speak_text(
                            current, "I didn't catch that."
                        )
                        await self._send_json(ws, {"type": "tts.done"})
                        await self._send_state(ws, "idle")
                        await self._cleanup_turn(current)
                        current = None
                        continue

                    await self._send_json(
                        ws, {"type": "stt.final", "text": transcript}
                    )
                    current.filler_task = asyncio.create_task(
                        self._filler_watch(current)
                    )
                    inbound = InboundMessage(
                        channel=self.name,
                        sender_id=f"sat:{device_id}",
                        chat_id=chat_id,
                        content=transcript,
                        metadata={
                            "device_id": device_id,
                            "wake_id": current.wake_id,
                            "satellite": True,
                        },
                        session_key_override=current.session_key,
                    )
                    await self.bus.publish_inbound(inbound)
                else:
                    logger.debug("Satellites: unknown frame type {}", t)
        except asyncio.CancelledError:
            raise
        except Exception as e:
            logger.exception("Satellites: connection error for {}: {}", device_id, e)
        finally:
            if current is not None:
                await self._cleanup_turn(current)
            self._conn_session_ids.pop(id(ws), None)
            self._live_count = max(0, self._live_count - 1)
            if not ws.closed:
                try:
                    await ws.close()
                except Exception:
                    pass
            logger.info("Satellites: device {} disconnected", device_id)
        return ws

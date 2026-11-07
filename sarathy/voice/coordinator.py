"""VoiceCoordinator: /ws/voice sessions, TTS queue, agent bridge."""

from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING, Any

import aiohttp
import aiohttp.web as web
from loguru import logger

from sarathy.bus.events import InboundMessage, OutboundMessage
from sarathy.voice.shruti_engine import ShrutiEngine
from sarathy.voice.voice_session import (
    SttMode,
    VoiceSession,
    VoiceState,
    session_key,
)
from sarathy.voice.woof_engine import WoofEngine
from sarathy.voice.ws_voice import parse_control, send_json

if TYPE_CHECKING:
    from sarathy.channels.dashboard.server import DashboardChannel

_FILLER = "One moment, sir."
_AUDIO_QUEUE_MAX = 32


class VoiceCoordinator:
    def __init__(self, channel: DashboardChannel):
        self.channel = channel
        self.woof = WoofEngine.singleton()
        self.shruti = ShrutiEngine()
        self.session = VoiceSession()
        self._ws: web.WebSocketResponse | None = None
        self._device_id: str | None = None
        self._spoken_chars = 0
        self._spoken_sentence_seq = 0
        self._tool_filler_spoken = False
        self._tts_task: asyncio.Task | None = None
        self._audio_queue: asyncio.Queue[tuple[int, bytes]] = asyncio.Queue(
            maxsize=_AUDIO_QUEUE_MAX
        )
        self._audio_worker: asyncio.Task | None = None
        self._turn_accumulated = ""
        self._server_stt_buffer = ""

    def is_live_for(self, msg: OutboundMessage) -> bool:
        if not self.session.is_live or not self.session.session_id:
            return False
        if msg.channel != "voice":
            return False
        return msg.chat_id == self.session.session_id

    async def handle_outbound(self, msg: OutboundMessage) -> None:
        if not self.is_live_for(msg) or self._ws is None or self._ws.closed:
            return
        meta = msg.metadata or {}
        if meta.get("_turn_state"):
            return
        if meta.get("_tool_hint"):
            tool = meta.get("tool_name") or meta.get("tool") or "tool"
            await send_json(self._ws, "tool", name=tool, hint=(msg.content or "")[:200])
            if not self._tool_filler_spoken:
                self._tool_filler_spoken = True
                await self._speak_text(_FILLER, is_filler=True)
            return
        if meta.get("_progress") and not meta.get("_tool_hint"):
            text = msg.content or ""
            self._turn_accumulated = text
            delta = text[self._spoken_chars :]
            if delta:
                await send_json(self._ws, "text", delta=delta)
            await self._speak_progress(text)
            return
        if meta.get("_thinking"):
            await send_json(self._ws, "state", state="thinking")
            return
        if meta.get("_final"):
            await send_json(self._ws, "done", turn_id=meta.get("turn_id") or "")
            await send_json(self._ws, "state", state="listening")
            self._reset_turn_tts_state()

    async def _speak_progress(self, accumulated: str) -> None:
        if not self.woof.loaded:
            return
        speakable = self.woof.sentences_from_answer(accumulated)
        prior = (
            self.woof.sentences_from_answer(accumulated[: self._spoken_chars])
            if self._spoken_chars
            else []
        )
        already = len(prior)
        for idx, sentence in enumerate(speakable[already:], start=already + 1):
            pcm = await asyncio.to_thread(self.woof.synthesize_sentence_pcm, sentence)
            await self._enqueue_audio(idx, pcm)
            await send_json(self._ws, "sentence_end", seq=idx)
            self._spoken_sentence_seq = max(self._spoken_sentence_seq, idx)
        self._spoken_chars = len(accumulated)

    async def _speak_text(self, text: str, *, is_filler: bool = False) -> None:
        if not self.woof.loaded:
            return
        base = self._spoken_sentence_seq
        for idx, sentence in enumerate(self.woof.sentences_from_answer(text), start=1):
            seq = base + idx
            pcm = await asyncio.to_thread(self.woof.synthesize_sentence_pcm, sentence)
            await self._enqueue_audio(seq, pcm)
            await send_json(self._ws, "sentence_end", seq=seq)
            if not is_filler:
                self._spoken_sentence_seq = seq

    async def _enqueue_audio(self, seq: int, pcm: bytes) -> None:
        if self._audio_queue.full():
            try:
                self._audio_queue.get_nowait()
            except asyncio.QueueEmpty:
                pass
            await send_json(
                self._ws,
                "state",
                state="speaking",
            )
        await self._audio_queue.put((seq, pcm))

    async def _audio_sender(self) -> None:
        ws = self._ws
        if ws is None:
            return
        last_seq = 0
        try:
            while not ws.closed:
                seq, pcm = await self._audio_queue.get()
                if seq < last_seq:
                    continue
                last_seq = seq
                await ws.send_bytes(pcm)
                await send_json(ws, "state", state="speaking")
        except asyncio.CancelledError:
            pass
        except Exception as e:
            logger.debug("voice audio sender stopped: {}", e)

    def _reset_turn_tts_state(self) -> None:
        self._spoken_chars = 0
        self._spoken_sentence_seq = 0
        self._tool_filler_spoken = False
        self._turn_accumulated = ""

    async def _ws_voice_handler(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=30)
        await ws.prepare(request)
        token = request.query.get("token", "") or self.channel._extract_token(request) or ""
        device_id = request.get("device_id") or (
            self.channel._registry.validate(token) if token else None
        )
        if not device_id:
            await ws.close()
            return ws

        if self._ws is not None and not self._ws.closed:
            await self._ws.close()
        self._ws = ws
        self._device_id = device_id
        self._audio_worker = asyncio.create_task(self._audio_sender())

        try:
            async for msg in ws:
                if msg.type == aiohttp.WSMsgType.TEXT:
                    await self._on_control(ws, msg.data)
                elif msg.type == aiohttp.WSMsgType.BINARY:
                    await self._on_audio(ws, msg.data)
                elif msg.type == aiohttp.WSMsgType.ERROR:
                    break
        finally:
            self.session.schedule_reaper(self._reap_session)
            if self._audio_worker:
                self._audio_worker.cancel()
            if self._ws is ws:
                self._ws = None

        return ws

    async def _reap_session(self) -> None:
        await self._end_session("reaper")

    async def _on_control(self, ws: web.WebSocketResponse, raw: str) -> None:
        ftype, payload = parse_control(raw)
        if ftype == "hello":
            await send_json(ws, "state", state=self.session.state.value)
            return
        if ftype == "start":
            await self._handle_start(ws, payload)
            return
        if ftype == "cancel":
            await self._end_session(payload.get("reason") or "cancel")
            return
        if ftype == "speech_start":
            await self._cancel_tts()
            await send_json(ws, "state", state="listening")
            return
        if ftype == "speech_end":
            if self.session.stt_mode == SttMode.SERVER_STT:
                text = self._server_stt_buffer.strip()
                self._server_stt_buffer = ""
                if text:
                    await send_json(ws, "partial", text=text, is_final=True)
                    await self._submit_utterance(text)
            return
        if ftype == "stop_turn":
            await self._cancel_tts()
            await self._publish_stop()
            return
        if ftype == "partial" and self.session.stt_mode == SttMode.CLIENT_STT:
            text = str(payload.get("text") or "")
            is_final = bool(payload.get("is_final"))
            await send_json(ws, "partial", text=text, is_final=is_final)
            if is_final and text.strip():
                await self._submit_utterance(text.strip())
            return

    async def _handle_start(self, ws: web.WebSocketResponse, payload: dict[str, Any]) -> None:
        if self.session.state not in (VoiceState.IDLE, VoiceState.UNLOADING):
            await send_json(
                ws,
                "error",
                code="busy",
                message="Voice session already active",
                recoverable=True,
            )
            return
        mode = str(payload.get("mode") or payload.get("stt_mode") or SttMode.SERVER_STT.value)
        try:
            self.session.stt_mode = SttMode(mode)
        except ValueError:
            self.session.stt_mode = SttMode.SERVER_STT
        self.session.voice = str(payload.get("voice") or "juno")
        self.session.stt_model = str(payload.get("stt") or "shruti-tamil")
        self.session.make_session_id()

        async def emit_prep(step: str, status: str, ms: int | None) -> None:
            body: dict[str, Any] = {"step": step, "status": status}
            if ms is not None:
                body["ms"] = ms
            await send_json(ws, "prep", **body)

        async def load_tts() -> None:
            await asyncio.to_thread(self.woof.load)

        async def load_stt() -> None:
            await asyncio.to_thread(self.shruti.load)

        async def open_audio() -> None:
            await asyncio.sleep(0)

        try:
            ready = await self.session.run_prep(
                emit_prep,
                load_tts=load_tts,
                load_stt=load_stt if self.session.stt_mode == SttMode.SERVER_STT else None,
                open_audio=open_audio,
            )
        except Exception as e:
            logger.warning("voice prep failed: {}", e)
            await send_json(
                ws,
                "error",
                code="prep_failed",
                message=str(e),
                recoverable=True,
            )
            await self._end_session("error")
            return

        await send_json(ws, "ready", **ready)
        await send_json(ws, "state", state="listening")

    async def _on_audio(self, ws: web.WebSocketResponse, pcm: bytes) -> None:
        if not self.session.is_live or self.session.stt_mode != SttMode.SERVER_STT:
            return
        if not self.shruti.loaded:
            return
        try:
            text = await asyncio.to_thread(self.shruti.transcribe_pcm16_16k, pcm)
        except Exception as e:
            logger.debug("shruti transcribe failed: {}", e)
            return
        if text.strip():
            self._server_stt_buffer = text.strip()
            await send_json(ws, "partial", text=text.strip(), is_final=False)

    async def _submit_utterance(self, text: str) -> None:
        if not self.session.is_live or not self._device_id:
            return
        await send_json(self._ws, "state", state="thinking")
        meta = {"voice_session": True, "device_id": self._device_id}
        inbound = InboundMessage(
            channel="voice",
            sender_id=f"dashboard:{self._device_id}",
            chat_id=self.session.session_id,
            content=text,
            media=[],
            metadata=meta,
            session_key_override=session_key(self.session.session_id),
        )
        await self.channel.bus.publish_inbound(inbound)

    async def _publish_stop(self) -> None:
        if not self.session.is_live or not self._device_id:
            return
        inbound = InboundMessage(
            channel="voice",
            sender_id=f"dashboard:{self._device_id}",
            chat_id=self.session.session_id,
            content="/stop",
            media=[],
            metadata={"device_id": self._device_id},
            session_key_override=session_key(self.session.session_id),
        )
        await self.channel.bus.publish_inbound(inbound)

    async def _cancel_tts(self) -> None:
        while not self._audio_queue.empty():
            try:
                self._audio_queue.get_nowait()
            except asyncio.QueueEmpty:
                break
        self._reset_turn_tts_state()

    async def _end_session(self, reason: str) -> None:
        sid = self.session.session_id

        async def unload() -> None:
            await asyncio.to_thread(self.woof.unload)
            await asyncio.to_thread(self.shruti.unload)

        await self.session.teardown(unload)
        if self._ws and not self._ws.closed:
            await send_json(
                self._ws,
                "ended",
                session_id=sid,
                reason=reason,
            )
            await send_json(self._ws, "state", state="idle")

    async def shutdown(self) -> None:
        self.session.cancel_reaper()
        await self._end_session("shutdown")

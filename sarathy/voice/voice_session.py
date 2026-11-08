"""Voice session state machine (spec 173 §C)."""

from __future__ import annotations

import asyncio
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from typing import Any, Awaitable, Callable

from sarathy.voice.stt_config import DEFAULT_STT_MODEL_ID

REAPER_GRACE_S = 30.0

PREP_STEPS = ("tts", "stt", "vad", "audio")


class VoiceState(str, Enum):
    IDLE = "idle"
    PREPARING = "preparing"
    LIVE = "live"
    UNLOADING = "unloading"


class SttMode(str, Enum):
    CLIENT_STT = "client_stt"
    SERVER_STT = "server_stt"


def new_session_id() -> str:
    ts = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    return f"{ts}-{secrets.token_hex(3)}"


def session_key(session_id: str) -> str:
    return f"voice:{session_id}"


PrepCallback = Callable[[str, str, int | None], Awaitable[None]]
StepRunner = Callable[[], Awaitable[None]]


@dataclass
class VoiceSession:
    """One activation: idle → preparing → live → unloading → idle."""

    stt_mode: SttMode = SttMode.SERVER_STT
    voice: str = "juno"
    stt_model: str = DEFAULT_STT_MODEL_ID
    state: VoiceState = VoiceState.IDLE
    session_id: str = ""
    prep_started_ms: float = 0.0
    _reaper_task: asyncio.Task | None = field(default=None, repr=False)
    _unload_lock: asyncio.Lock = field(default_factory=asyncio.Lock, repr=False)
    _unloading: bool = field(default=False, repr=False)

    def make_session_id(self) -> str:
        self.session_id = new_session_id()
        return self.session_id

    @property
    def key(self) -> str:
        return session_key(self.session_id) if self.session_id else ""

    @property
    def is_live(self) -> bool:
        return self.state == VoiceState.LIVE

    def cancel_reaper(self) -> None:
        task = self._reaper_task
        self._reaper_task = None
        if task is not None and not task.done():
            task.cancel()

    def schedule_reaper(self, on_reap: Callable[[], Awaitable[None]]) -> None:
        self.cancel_reaper()

        async def _reap() -> None:
            try:
                await asyncio.sleep(REAPER_GRACE_S)
                await on_reap()
            except asyncio.CancelledError:
                pass

        self._reaper_task = asyncio.create_task(_reap())

    async def run_prep(
        self,
        emit_prep: PrepCallback,
        *,
        load_tts: StepRunner,
        load_stt: StepRunner | None,
        open_audio: StepRunner,
    ) -> dict[str, Any]:
        """Warm path: real prep frames, then ready payload."""
        self.state = VoiceState.PREPARING
        t0 = time.monotonic()
        self.prep_started_ms = t0 * 1000
        if not self.session_id:
            self.make_session_id()

        async def _step(name: str, fn: StepRunner) -> None:
            step_t0 = time.monotonic()
            await emit_prep(name, "running", None)
            await fn()
            ms = int((time.monotonic() - step_t0) * 1000)
            await emit_prep(name, "done", ms)

        await _step("tts", load_tts)
        if self.stt_mode == SttMode.SERVER_STT and load_stt is not None:
            await _step("stt", load_stt)
        else:
            await emit_prep("stt", "done", 0)
        await emit_prep("vad", "done", 0)
        await _step("audio", open_audio)

        prep_ms = int((time.monotonic() - t0) * 1000)
        self.state = VoiceState.LIVE
        return {
            "voice": self.voice,
            "stt": self.stt_model,
            "mode": self.stt_mode.value,
            "session_id": self.session_id,
            "prep_ms": prep_ms,
        }

    async def teardown(self, unload: Callable[[], Awaitable[None]]) -> None:
        """Idempotent unload (cancel, error, end session, reaper)."""
        async with self._unload_lock:
            if self._unloading and self.state == VoiceState.IDLE:
                return
            self._unloading = True
            self.cancel_reaper()
            prev = self.state
            if prev != VoiceState.IDLE:
                self.state = VoiceState.UNLOADING
            try:
                await unload()
            finally:
                self.state = VoiceState.IDLE
                self.session_id = ""
                self._unloading = False

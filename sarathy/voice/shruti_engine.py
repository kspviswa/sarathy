"""Shruti STT holder (server_stt mode). Optional at runtime."""

from __future__ import annotations

import os
from pathlib import Path

from sarathy.voice.stt_config import DEFAULT_STT_MODEL_ID, normalize_stt_model_id, resolve_stt_path


class ShrutiEngine:
    """Lazy STT engine — load on Activate, unload on End Session."""

    def __init__(self, model_id: str | None = None, model_path: Path | None = None):
        self.model_id = normalize_stt_model_id(model_id or DEFAULT_STT_MODEL_ID)
        env = os.environ.get("SHRUTI_MODEL", "")
        if model_path is not None:
            self.model_path = Path(model_path)
            self._language: str | None = None
        elif env:
            self.model_path = Path(env)
            self._language = None
        else:
            self.model_path, self._language = resolve_stt_path(self.model_id)
        self._engine = None

    @property
    def loaded(self) -> bool:
        return self._engine is not None

    def configure(self, model_id: str) -> None:
        if self._engine is not None:
            return
        self.model_id = normalize_stt_model_id(model_id)
        self.model_path, self._language = resolve_stt_path(self.model_id)

    def load(self) -> None:
        if self._engine is not None:
            return
        if not self.model_path.is_file():
            raise FileNotFoundError(f"Shruti model missing: {self.model_path}")
        try:
            from cactus import Whistle  # type: ignore[import-not-found]
        except ImportError as e:
            raise RuntimeError(
                "cactus-compute is required for server_stt (pip install cactus-compute)"
            ) from e
        self._engine = Whistle(str(self.model_path))

    def unload(self) -> None:
        self._engine = None

    def transcribe_pcm16_16k(self, pcm: bytes) -> str:
        if self._engine is None:
            raise RuntimeError("Shruti is not loaded")
        import numpy as np

        arr = np.frombuffer(pcm, dtype=np.int16).astype(np.float32) / 32768.0
        lang = self._language
        out = self._engine.transcribe(arr, language=lang) if lang else self._engine.transcribe(arr)
        if isinstance(out, dict):
            return str(out.get("text") or "")
        return str(out)

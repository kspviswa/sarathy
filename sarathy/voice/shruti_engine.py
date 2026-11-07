"""Shruti-Tamil STT holder (server_stt mode). Optional at runtime."""

from __future__ import annotations

import os
from pathlib import Path


class ShrutiEngine:
    """Lazy STT engine — load on Activate, unload on End Session."""

    def __init__(self, model_path: Path | None = None):
        default = Path.home() / ".sarathy" / "models" / "shruti" / "shruti-tamil.cact"
        env = os.environ.get("SHRUTI_MODEL", "")
        self.model_path = Path(model_path or env or default)
        self._engine = None

    @property
    def loaded(self) -> bool:
        return self._engine is not None

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
        out = self._engine.transcribe(arr)
        if isinstance(out, dict):
            return str(out.get("text") or "")
        return str(out)

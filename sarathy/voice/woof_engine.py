"""Woof TTS singleton (Juno), int16 PCM @ 24 kHz."""

from __future__ import annotations

import os
import sys
import threading
from pathlib import Path
from typing import Iterator

from sarathy.voice.stripper import strip_for_speech

_DEFAULT_WOOF_ROOT = Path(
    os.environ.get("WOOF_PATH", "~/ws/woof-sample/underdog-woof")
).expanduser()
_SR = 24_000


def _f32_to_int16_pcm(wav) -> bytes:
    import numpy as np

    pcm = (np.clip(wav, -1.0, 1.0) * 32767.0).round().astype(np.int16)
    return pcm.tobytes()


class WoofEngine:
    """Process-wide Woof loader; one resident model at a time."""

    _instance: WoofEngine | None = None
    _lock = threading.Lock()

    def __init__(self, woof_root: Path | None = None):
        self.woof_root = Path(woof_root or _DEFAULT_WOOF_ROOT)
        self._tts = None
        self._split_text = None

    @classmethod
    def singleton(cls, woof_root: Path | None = None) -> WoofEngine:
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls(woof_root)
            return cls._instance

    @classmethod
    def reset_singleton_for_tests(cls) -> None:
        with cls._lock:
            if cls._instance is not None:
                cls._instance.unload()
            cls._instance = None

    @property
    def loaded(self) -> bool:
        return self._tts is not None

    def load(self) -> None:
        if self._tts is not None:
            return
        root = self.woof_root.resolve()
        if not (root / "underdog_woof" / "__init__.py").is_file():
            raise RuntimeError(
                f"Woof checkout not found at {root} (expected underdog_woof/__init__.py). "
                "Set WOOF_PATH to the underdog-woof directory."
            )
        if not (root / "woof_int8.npz").is_file():
            raise RuntimeError(f"Woof weights missing: {root / 'woof_int8.npz'}")
        root_s = str(root)
        if root_s not in sys.path:
            sys.path.insert(0, root_s)
        from underdog_woof import Woof  # type: ignore[import-not-found]
        from underdog_woof.textsplit import split_text  # type: ignore[import-not-found]

        self._split_text = split_text
        self._tts = Woof(voice="juno", normalize=True)

    def unload(self) -> None:
        self._tts = None
        self._split_text = None

    def synthesize_sentence_pcm(self, sentence: str) -> bytes:
        """One sentence → raw int16 mono PCM."""
        if self._tts is None:
            raise RuntimeError("Woof is not loaded")
        import numpy as np

        wav = self._tts(sentence)
        return _f32_to_int16_pcm(np.asarray(wav, dtype=np.float32))

    def sentences_from_answer(self, answer_text: str) -> list[str]:
        speakable = strip_for_speech(answer_text)
        if not speakable or self._split_text is None:
            return []
        return [s for s in self._split_text(speakable) if s.strip()]

    def synthesize_answer_stream(self, answer_text: str) -> Iterator[tuple[int, str, bytes]]:
        """Yield (seq, sentence, pcm) in order."""
        if self._tts is None:
            raise RuntimeError("Woof is not loaded")
        for seq, sentence in enumerate(self.sentences_from_answer(answer_text), start=1):
            pcm = self.synthesize_sentence_pcm(sentence)
            yield seq, sentence, pcm

    @property
    def sample_rate(self) -> int:
        return _SR

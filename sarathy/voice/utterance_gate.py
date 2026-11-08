"""Reject silence/noise before STT or agent submission (spec 174 §N1)."""

from __future__ import annotations

import math

# 16 kHz mono int16 — minimum voiced duration before we call STT (~150 ms).
MIN_UTTERANCE_SAMPLES = 2400

# Mean RMS energy floor (0–1 scale on int16 samples).
MIN_UTTERANCE_RMS = 0.008


def pcm16_rms(pcm: bytes) -> float:
    if not pcm:
        return 0.0
    n_samples = len(pcm) // 2
    if n_samples <= 0:
        return 0.0
    acc = 0.0
    for i in range(0, len(pcm), 2):
        sample = int.from_bytes(pcm[i : i + 2], "little", signed=True)
        v = sample / 32768.0
        acc += v * v
    return math.sqrt(acc / n_samples)


def utterance_passes_gate(pcm: bytes) -> bool:
    """True when ``pcm`` looks like real speech, not silence/noise."""
    if len(pcm) < MIN_UTTERANCE_SAMPLES * 2:
        return False
    return pcm16_rms(pcm) >= MIN_UTTERANCE_RMS

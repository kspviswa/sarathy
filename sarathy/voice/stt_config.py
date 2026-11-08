"""STT model ids → on-disk paths and language hints (spec 174 §N1)."""

from __future__ import annotations

import re
from pathlib import Path

_MODEL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")

DEFAULT_STT_MODEL_ID = "shruti-en"
TAMIL_STT_MODEL_ID = "shruti-tamil"

_STT_MODELS: dict[str, dict[str, str | None]] = {
    DEFAULT_STT_MODEL_ID: {
        "filename": "shruti.cact",
        "fallback_filename": "shruti-tamil.cact",
        "language": "en",
    },
    TAMIL_STT_MODEL_ID: {
        "filename": "shruti-tamil.cact",
        "fallback_filename": None,
        "language": "ta",
    },
}


def models_dir() -> Path:
    return Path.home() / ".sarathy" / "models" / "shruti"


def normalize_stt_model_id(value: str | None) -> str:
    raw = (value or "").strip()
    if raw in _STT_MODELS:
        return raw
    return DEFAULT_STT_MODEL_ID


def resolve_stt_path(model_id: str) -> tuple[Path, str | None]:
    """Return the first existing model path for ``model_id`` and its language hint."""
    mid = normalize_stt_model_id(model_id)
    spec = _STT_MODELS[mid]
    root = models_dir()
    primary = root / str(spec["filename"])
    if primary.is_file():
        return primary, spec.get("language")  # type: ignore[return-value]
    fallback = spec.get("fallback_filename")
    if fallback:
        alt = root / str(fallback)
        if alt.is_file():
            return alt, spec.get("language")  # type: ignore[return-value]
    return primary, spec.get("language")  # type: ignore[return-value]


def model_asset_name(model_id: str) -> str:
    """Filename served at ``/api/voice/model/<name>`` for client STT."""
    mid = normalize_stt_model_id(model_id)
    path, _ = resolve_stt_path(mid)
    return path.name


def is_safe_model_asset(name: str) -> bool:
    return bool(_MODEL_ID_RE.match(name)) and name.endswith(".cact")

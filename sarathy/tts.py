"""Shared resolution for half-duplex TTS (satellites + voice notes).

Live full-duplex dashboard voice uses WoofEngine and is deliberately not part
of this module. The single source of truth is ``config.json -> voice.tts``;
``tts.sh`` does the actual dispatch. Adding an engine needs a script plus one
``voice.tts.engines`` block — no Python changes.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path

from sarathy.config.loader import get_config_path, load_config, save_config
from sarathy.config.schema import Config, VoiceTTSConfig

CONFIG_PATH_ENV = "SARATHY_CONFIG_PATH"
SCRIPT_ENV = "SARATHY_TTS_SCRIPT"
LEGACY_CONF_ENV = "SARATHY_LEGACY_ENGINE_CONF"
DEFAULT_SCRIPT = Path.home() / ".sarathy" / "workspace" / "voice" / "tts.sh"
DEFAULT_LEGACY_CONF = Path.home() / ".sarathy" / "voice" / "engine.conf"


class TTSResolutionError(RuntimeError):
    """Raised when no TTS engine can be resolved or synthesis fails."""


def config_path_from_env() -> Path:
    return Path(os.environ.get(CONFIG_PATH_ENV) or get_config_path()).expanduser()


def get_tts_script() -> Path:
    return Path(os.environ.get(SCRIPT_ENV) or DEFAULT_SCRIPT).expanduser()


def _env(env: dict[str, str] | None) -> dict[str, str]:
    return dict(os.environ if env is None else env)


def migrate_legacy_engine_conf(
    config_path: Path | None = None, env: dict[str, str] | None = None
) -> str | None:
    """Move the retired ``~/.sarathy/voice/engine.conf`` ENGINE= value once.

    Returns the migrated engine name, or None when there was nothing to move.
    The legacy file is left on disk but is never read again afterwards.
    """
    environ = _env(env)
    path = config_path or Path(environ.get(CONFIG_PATH_ENV) or get_config_path())
    legacy = Path(environ.get(LEGACY_CONF_ENV) or DEFAULT_LEGACY_CONF).expanduser()
    data: dict = {}
    if path.is_file():
        try:
            loaded = json.loads(path.read_text(encoding="utf-8") or "{}")
            data = loaded if isinstance(loaded, dict) else {}
        except (OSError, ValueError):
            data = {}
    voice = data.get("voice") if isinstance(data.get("voice"), dict) else {}
    tts = voice.get("tts") if isinstance(voice.get("tts"), dict) else {}
    if tts.get("engine"):
        return None
    if not legacy.is_file():
        return None
    try:
        match = re.search(
            r"^\s*ENGINE\s*=\s*([A-Za-z0-9_.-]+)",
            legacy.read_text(encoding="utf-8"),
            re.MULTILINE,
        )
    except OSError:
        return None
    if not match:
        return None
    tts["engine"] = match.group(1)
    voice["tts"] = tts
    data["voice"] = voice
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(
            json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
        )
    except OSError:
        return None
    return tts["engine"]


def engine_script(name: str, tts: VoiceTTSConfig) -> Path:
    """Resolve an engine's script path without knowing anything about engines."""
    voice_dir = get_tts_script().parent
    block = tts.engines.get(name)
    if block is not None and block.command:
        path = Path(block.command).expanduser()
    else:
        path = voice_dir / "engines" / f"{name}.sh"
    if not path.is_absolute():
        path = voice_dir / path
    return path


def script_status(name: str, tts: VoiceTTSConfig) -> dict:
    path = engine_script(name, tts)
    block = tts.engines.get(name)
    available = path.is_file() and os.access(path, os.X_OK)
    if not path.exists():
        reason = "script not found"
    elif not os.access(path, os.X_OK):
        reason = "script not executable"
    else:
        reason = "ok"
    return {
        "name": name,
        "type": block.type if block else "script",
        "command": str(path),
        "sampleRate": block.sample_rate if block else 24_000,
        "available": available,
        "reason": reason,
    }


def primary_engine(tts: VoiceTTSConfig, env: dict[str, str] | None = None) -> str:
    return str(_env(env).get("TTS_ENGINE") or tts.engine)


def fallback_engines(tts: VoiceTTSConfig, env: dict[str, str] | None = None) -> list[str]:
    environ = _env(env)
    if environ.get("TTS_NO_FALLBACK") == "1":
        return []
    return [str(name) for name in tts.fallback]


def resolution(
    config: Config | None = None,
    *,
    env: dict[str, str] | None = None,
    config_path: Path | None = None,
) -> dict:
    """What each half-duplex consumer would resolve to right now."""
    cfg = config or load_config(config_path or config_path_from_env())
    tts = cfg.voice.tts
    engine = primary_engine(tts, env)
    fallback = fallback_engines(tts, env)
    candidates = list(dict.fromkeys([engine, *fallback]))

    names = list(dict.fromkeys([*tts.engines.keys(), *candidates]))
    statuses = [script_status(name, tts) for name in names]
    by_name = {item["name"]: item for item in statuses}
    resolved = next(
        (name for name in candidates if by_name.get(name, {}).get("available")), None
    )
    return {
        "engine": engine,
        "fallback": fallback,
        "resolved": {"satellite": resolved, "note": resolved},
        "engines": statuses,
        "error": None
        if resolved
        else "no TTS engine available: " + ", ".join(candidates),
    }


def require_resolution(
    config: Config | None = None,
    *,
    env: dict[str, str] | None = None,
    config_path: Path | None = None,
) -> dict:
    result = resolution(config, env=env, config_path=config_path)
    if result["resolved"]["satellite"] is None:
        raise TTSResolutionError(result["error"] or "no TTS engine available")
    return result


def set_engine(name: str, config_path: Path | None = None) -> dict:
    """Persist the primary engine and return the resulting resolution."""
    path = config_path or config_path_from_env()
    migrate_legacy_engine_conf(path)
    cfg = load_config(path)
    cfg.voice.tts.engine = name
    save_config(cfg, path)
    return resolution(cfg)


def note_format(path: str | Path) -> str:
    suffix = Path(path).suffix.lower().lstrip(".")
    return suffix if suffix in {"wav", "ogg", "pcm"} else "ogg"


def synthesize_note(
    text: str,
    out: str | Path,
    *,
    lang: str | None = None,
    voice: str | None = None,
    config_path: Path | None = None,
) -> dict:
    """Synthesize a voice-note file through the one shared tts.sh entry point."""
    path = config_path or config_path_from_env()
    migrate_legacy_engine_conf(path)
    args = [str(get_tts_script()), text, str(out), "--format", note_format(out)]
    if lang:
        args += ["--lang", lang]
    if voice:
        args += ["--voice", voice]
    try:
        proc = subprocess.run(
            args,
            capture_output=True,
            text=True,
            timeout=300,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        raise TTSResolutionError(f"tts.sh failed: {exc}") from exc
    if proc.returncode != 0:
        detail = proc.stderr.strip() or f"exit {proc.returncode}"
        raise TTSResolutionError(detail)
    line = proc.stdout.strip().splitlines()[-1] if proc.stdout.strip() else ""
    match = re.fullmatch(
        r"engine=(\S+) sample_rate=(\d+) format=(\S+)", line.strip()
    )
    if not match:
        raise TTSResolutionError(f"unexpected tts.sh output: {line!r}")
    return {
        "engine": match.group(1),
        "sample_rate": int(match.group(2)),
        "format": match.group(3),
        "output": str(out),
    }

"""Configuration loading utilities."""

import json
from pathlib import Path

from sarathy.config.schema import Config


def get_config_path() -> Path:
    """Get the default configuration file path."""
    return Path.home() / ".sarathy" / "config.json"


def get_data_dir() -> Path:
    """Get the sarathy data directory."""
    from sarathy.utils.helpers import get_data_path

    return get_data_path()


def load_config(config_path: Path | None = None) -> Config:
    """
    Load configuration from file or create default.

    Args:
        config_path: Optional path to config file. Uses default if not provided.

    Returns:
        Loaded configuration object.
    """
    path = config_path or get_config_path()

    if path.exists():
        try:
            with open(path, encoding="utf-8") as f:
                data = json.load(f)
            data = _migrate_config(data)
            return Config.model_validate(data)
        except (json.JSONDecodeError, ValueError) as e:
            print(f"Warning: Failed to load config from {path}: {e}")
            print("Using default configuration.")

    return Config()


def save_config(config: Config, config_path: Path | None = None) -> None:
    """
    Save configuration to file.

    Args:
        config: Configuration to save.
        config_path: Optional path to save to. Uses default if not provided.
    """
    path = config_path or get_config_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    data = config.model_dump(by_alias=True)

    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def _migrate_config(data: dict) -> dict:
    """Migrate old config formats to current."""
    # Move tools.exec.restrictToWorkspace → tools.restrictToWorkspace
    tools = data.get("tools", {})
    exec_cfg = tools.get("exec", {})
    if "restrictToWorkspace" in exec_cfg and "restrictToWorkspace" not in tools:
        tools["restrictToWorkspace"] = exec_cfg.pop("restrictToWorkspace")

    # Infer provider `kind` for legacy provider blocks that predate the
    # dynamic-provider rework (ollama/lmstudio/vllm were fixed fields).
    providers = data.get("providers")
    if isinstance(providers, dict):
        legacy_kinds = {"custom": "custom", "ollama": "ollama", "lmstudio": "lmstudio", "vllm": "vllm"}
        for name, p in providers.items():
            if isinstance(p, dict) and "kind" not in p and name in legacy_kinds:
                p["kind"] = legacy_kinds[name]

    # channels.satellites.tts_* are deprecated aliases of voice.tts.*. An
    # explicit voice.tts value always wins; the legacy keys are left intact so
    # older clients that still read them keep working.
    channels = data.get("channels")
    satellites = channels.get("satellites") if isinstance(channels, dict) else None
    if isinstance(satellites, dict):
        aliases = (
            ("ttsVoice", "voice"),
            ("ttsLang", "lang"),
            ("ttsSpeed", "speed"),
            ("tts_voice", "voice"),
            ("tts_lang", "lang"),
            ("tts_speed", "speed"),
        )
        if any(legacy in satellites for legacy, _ in aliases):
            voice = data.get("voice")
            if not isinstance(voice, dict):
                voice = {}
                data["voice"] = voice
            tts = voice.get("tts")
            if not isinstance(tts, dict):
                tts = {}
                voice["tts"] = tts
            for legacy, canonical in aliases:
                if legacy in satellites and canonical not in tts:
                    tts[canonical] = satellites[legacy]
    return data

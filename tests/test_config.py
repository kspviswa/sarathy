"""Config schema + loader round trips with the new sarathy package."""

from __future__ import annotations

import json
from pathlib import Path

from sarathy.config.loader import (
    _migrate_config,
    load_config,
    save_config,
)
from sarathy.config.schema import Config, ProviderConfig, WebConfig


def test_config_defaults() -> None:
    config = Config()
    assert config.agents.defaults.model
    assert isinstance(config.providers.ollama, ProviderConfig)
    assert isinstance(config.web, WebConfig)


def test_workspace_path_expands() -> None:
    config = Config()
    config.agents.defaults.workspace = "~/ws"
    assert str(config.workspace_path).endswith("ws")


def test_provider_resolution() -> None:
    config = Config()
    config.agents.defaults.provider = "custom"
    assert config.get_provider() is config.providers.custom
    assert config.get_provider_name() == "custom"


def test_unknown_provider_rejected() -> None:
    config = Config()
    config.agents.defaults.provider = "nope"
    try:
        config.get_provider_name()
        raise AssertionError("expected ValueError")
    except ValueError as exc:
        assert "Unknown provider 'nope'" in str(exc)


def test_load_config_default_when_missing(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SARATHY_CONFIG", str(tmp_path / "missing.json"))
    config = load_config()
    assert config.agents.defaults.model  # valid defaults are returned


def test_save_then_load_round_trip(tmp_path: Path, monkeypatch) -> None:
    path = tmp_path / "config.json"
    monkeypatch.setenv("SARATHY_CONFIG", str(path))

    config = Config()
    config.agents.defaults.model = "hermes-3"
    save_config(config, path)

    loaded = load_config(path)
    assert loaded.agents.defaults.model == "hermes-3"


def test_migrate_restrict_to_workspace() -> None:
    data = {
        "tools": {
            "exec": {"restrictToWorkspace": True},
        }
    }
    out = _migrate_config(data)
    assert out["tools"]["restrictToWorkspace"] is True
    assert "restrictToWorkspace" not in out["tools"]["exec"]


def test_config_accepts_camelcase_input(tmp_path: Path, monkeypatch) -> None:
    monkeypatch.setenv("SARATHY_CONFIG", str(tmp_path / "cfg.json"))
    (tmp_path / "cfg.json").write_text(
        json.dumps(
            {
                "agents": {"defaults": {"provider": "ollama"}},
                "providers": {"ollama": {"apiBase": "http://localhost:11434"}},
            }
        ),
        encoding="utf-8",
    )
    config = load_config()
    assert config.agents.defaults.provider == "ollama"
    assert config.providers.ollama.api_base == "http://localhost:11434"

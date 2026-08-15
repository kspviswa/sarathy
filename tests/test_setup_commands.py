"""CLI `setup` command: non-interactive config generation."""

from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from sarathy.cli.commands import app
from sarathy.config.loader import load_config

runner = CliRunner()


def test_setup_writes_config(monkeypatch, tmp_path: Path) -> None:
    import sarathy.config.loader as loader

    config_path = tmp_path / "config.json"
    monkeypatch.setattr(loader, "get_config_path", lambda: config_path)

    result = runner.invoke(
        app,
        [
            "setup",
            "--provider", "ollama",
            "--model", "llama3.2",
            "--api-base", "http://localhost:11434/v1",
            "--config", str(config_path),
        ],
    )

    assert result.exit_code == 0
    assert "Config written" in result.stdout
    assert config_path.exists()

    cfg = load_config(config_path)
    assert cfg.agents.defaults.provider == "ollama"
    assert cfg.agents.defaults.model == "llama3.2"
    assert cfg.providers.ollama.api_base == "http://localhost:11434/v1"


def test_setup_rejects_unknown_provider(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    result = runner.invoke(
        app, ["setup", "--provider", "doesnotexist", "--config", str(config_path)]
    )
    assert result.exit_code == 1
    assert "Unknown provider" in result.stdout
    assert not config_path.exists()


def test_setup_refuses_overwrite_without_force(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("{}", encoding="utf-8")

    result = runner.invoke(
        app, ["setup", "--provider", "ollama", "--config", str(config_path)]
    )
    assert result.exit_code == 1
    assert "already exists" in result.stdout


def test_setup_force_overwrites(tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    config_path.write_text("""{"agents":{"defaults":{"model":"old"}}}""", encoding="utf-8")

    result = runner.invoke(
        app,
        [
            "setup",
            "--provider", "vllm",
            "--model", "qwen2.5",
            "--force",
            "--config", str(config_path),
        ],
    )
    assert result.exit_code == 0
    cfg = load_config(config_path)
    assert cfg.agents.defaults.provider == "vllm"
    assert cfg.agents.defaults.model == "qwen2.5"


def test_setup_workspace_defaults_to_sarathy_home(monkeypatch, tmp_path: Path) -> None:
    """With SARATHY_HOME set, workspace defaults into the data dir (volume-friendly)."""
    import sarathy.config.loader as loader

    data_dir = tmp_path / "data"
    config_path = tmp_path / "config.json"

    monkeypatch.setenv("SARATHY_HOME", str(data_dir))
    monkeypatch.setattr(loader, "get_config_path", lambda: config_path)

    result = runner.invoke(
        app, ["setup", "--provider", "ollama", "--config", str(config_path)]
    )
    assert result.exit_code == 0
    cfg = load_config(config_path)
    assert cfg.agents.defaults.workspace == str(data_dir / "workspace")
    assert (data_dir / "workspace").exists()


def test_setup_explicit_workspace(monkeypatch, tmp_path: Path) -> None:
    config_path = tmp_path / "config.json"
    ws = tmp_path / "custom-ws"
    result = runner.invoke(
        app,
        [
            "setup",
            "--provider", "ollama",
            "--workspace", str(ws),
            "--config", str(config_path),
        ],
    )
    assert result.exit_code == 0
    cfg = load_config(config_path)
    assert cfg.agents.defaults.workspace == str(ws)
    assert ws.exists()

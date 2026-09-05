import shutil
from pathlib import Path
from unittest.mock import patch

import pytest
from typer.testing import CliRunner

from sarathy.cli.commands import app
from sarathy.config.schema import Config
from sarathy.providers.litellm_provider import LiteLLMProvider
from sarathy.providers.registry import find_by_model

runner = CliRunner()


@pytest.fixture
def mock_paths():
    """Mock config/workspace paths for test isolation."""
    with patch("sarathy.config.loader.get_config_path") as mock_cp, \
         patch("sarathy.config.loader.save_config") as mock_sc, \
         patch("sarathy.config.loader.load_config"), \
         patch("sarathy.utils.helpers.get_workspace_path") as mock_ws:

        base_dir = Path("./test_onboard_data")
        if base_dir.exists():
            shutil.rmtree(base_dir)
        base_dir.mkdir()

        config_file = base_dir / "config.json"
        workspace_dir = base_dir / "workspace"

        mock_cp.return_value = config_file
        mock_ws.return_value = workspace_dir
        mock_sc.side_effect = lambda config: config_file.write_text("{}")

        yield config_file, workspace_dir

        if base_dir.exists():
            shutil.rmtree(base_dir)


@pytest.fixture
def stub_wizard(monkeypatch):
    """Replace the interactive Textual onboarding wizard with a stub.

    The wizard is a TUI that requires a terminal and manual button presses, so
    it can never run headless under pytest. Its only durable side effect is
    persisting the config on the finish screen — the stub reproduces exactly
    that.
    """
    from sarathy.cli import onboard as onboard_module
    from sarathy.config.loader import save_config

    def _fake_run_onboarding(config, config_path, workspace):
        save_config(config)

    monkeypatch.setattr(onboard_module, "run_onboarding", _fake_run_onboarding)


def test_onboard_fresh_install(mock_paths, stub_wizard):
    """No existing config — should create from scratch."""
    config_file, workspace_dir = mock_paths

    result = runner.invoke(app, ["onboard"])

    assert result.exit_code == 0
    assert config_file.exists()
    assert (workspace_dir / "AGENTS.md").exists()
    assert (workspace_dir / "memory" / "MEMORY.md").exists()
    assert (workspace_dir / "memory" / "HISTORY.md").exists()


def test_onboard_existing_config_refresh(mock_paths, stub_wizard):
    """Config exists and the wizard runs again — refresh succeeds."""
    config_file, workspace_dir = mock_paths
    config_file.write_text('{"existing": true}')

    result = runner.invoke(app, ["onboard"])

    assert result.exit_code == 0
    assert config_file.exists()
    assert workspace_dir.exists()
    assert (workspace_dir / "AGENTS.md").exists()


def test_onboard_existing_config_overwrite(mock_paths, stub_wizard):
    """Config exists and gets re-persisted through the wizard's finish step."""
    config_file, workspace_dir = mock_paths
    config_file.write_text('{"existing": true}')

    result = runner.invoke(app, ["onboard"])

    assert result.exit_code == 0
    assert config_file.exists()
    assert workspace_dir.exists()


def test_onboard_existing_workspace_safe_create(mock_paths, stub_wizard):
    """Workspace exists — should not recreate, but still add missing templates."""
    config_file, workspace_dir = mock_paths
    workspace_dir.mkdir(parents=True)
    existing = workspace_dir / "AGENTS.md"
    existing.write_text("# Existing\nkeep me")
    config_file.write_text("{}")

    result = runner.invoke(app, ["onboard"])

    assert result.exit_code == 0
    assert existing.read_text() == "# Existing\nkeep me"
    assert (workspace_dir / "memory" / "MEMORY.md").exists()


def test_config_requires_explicit_provider():
    """Provider matching now requires agents.defaults.provider to be set."""
    config = Config()
    config.agents.defaults.provider = "ollama"
    config.agents.defaults.model = "github-copilot/gpt-5.3-codex"

    assert config.get_provider_name() == "ollama"


def test_config_missing_provider_raises():
    """Without an explicit provider, name resolution fails loudly."""
    config = Config()
    config.agents.defaults.model = "openai-codex/gpt-5.1-codex"

    with pytest.raises(ValueError, match="Missing required 'provider'"):
        config.get_provider_name()


def test_find_by_model_prefers_explicit_prefix_over_generic_keyword():
    """An explicit model prefix wins even when a generic keyword also matches."""
    spec = find_by_model("vllm/gpt-ollama-5")

    assert spec is not None
    assert spec.name == "vllm"


def test_litellm_provider_canonicalizes_explicit_hyphen_prefix():
    """Hyphenated provider prefixes are canonicalized to underscore names."""
    resolved = LiteLLMProvider._canonicalize_explicit_prefix(
        "github-copilot/gpt-5.3-codex", "github_copilot", "github_copilot"
    )

    assert resolved == "github_copilot/gpt-5.3-codex"

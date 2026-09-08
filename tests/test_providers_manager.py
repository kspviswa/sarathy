"""Tests for the provider manager, dynamic provider config, and hot-reload."""

import json
from pathlib import Path
from unittest.mock import Mock, patch

import pytest

from sarathy.config.loader import _migrate_config, save_config
from sarathy.config.schema import Config, ProviderConfig
from sarathy.providers.custom_provider import CustomProvider
from sarathy.providers.litellm_provider import LiteLLMProvider
from sarathy.providers.manager import (
    RuntimeProvider,
    build_provider,
    create_provider,
    describe_provider,
    list_models,
    resolve_kind,
)

# ---------------------------------------------------------------------------
# Schema / config
# ---------------------------------------------------------------------------


def test_default_providers_seeded():
    cfg = Config()
    assert set(cfg.providers.keys()) == {"custom", "ollama", "lmstudio", "vllm"}
    assert cfg.providers["ollama"].kind == "ollama"
    assert cfg.providers["custom"].kind == "custom"


def test_providers_dict_like_ops():
    cfg = Config()
    assert "ollama" in cfg.providers
    assert cfg.providers.get("missing") is None
    cfg.providers["myprov"] = ProviderConfig(kind="custom", api_base="http://x/v1", api_key="k")
    assert cfg.providers["myprov"].api_key == "k"
    assert list(cfg.providers.keys()) and len(cfg.providers.values()) == 5
    assert cfg.providers.pop("myprov") is not None
    assert "myprov" not in cfg.providers


def test_migrate_config_infers_kind():
    raw = {
        "agents": {"defaults": {"provider": "ollama", "model": "llama3"}},
        "providers": {
            "ollama": {"apiBase": "http://localhost:11434"},
            "custom": {"apiBase": "http://x/v1", "apiKey": "sk-1"},
            "extra": {"apiBase": "http://y/v1", "apiKey": "sk-2"},
        },
    }
    data = _migrate_config(json.loads(json.dumps(raw)))
    assert data["providers"]["ollama"]["kind"] == "ollama"
    assert data["providers"]["custom"]["kind"] == "custom"
    assert "kind" not in data["providers"]["extra"]


def test_legacy_config_round_trip():
    raw = {
        "agents": {"defaults": {"provider": "ollama", "model": "llama3", "temperature": 0.7}},
        "providers": {
            "ollama": {"apiBase": "http://localhost:11434"},
            "custom": {"apiBase": "http://x/v1", "apiKey": "sk-1"},
        },
    }
    cfg = Config.model_validate(_migrate_config(raw))
    assert cfg.providers["ollama"].kind == "ollama"
    assert cfg.providers["custom"].api_key == "sk-1"
    assert cfg.agents.defaults.model == "llama3"


def test_resolve_kind_and_describe():
    assert resolve_kind("ollama", None) == "ollama"
    cfg = ProviderConfig(kind="custom", api_base="http://x/v1", api_key="sk", label="My Thing")
    desc = describe_provider("mything", cfg)
    assert desc["name"] == "mything"
    assert desc["label"] == "My Thing"
    assert desc["kind"] == "custom"
    assert desc["apiBase"] == "http://x/v1"
    assert desc["hasApiKey"] is True
    assert desc["isLocal"] is False


def test_describe_local_and_dummy_key():
    cfg = ProviderConfig(kind="ollama", api_base="http://localhost:11434", api_key="dummy")
    desc = describe_provider("ollama", cfg)
    assert desc["isLocal"] is True
    assert desc["hasApiKey"] is False


# ---------------------------------------------------------------------------
# Provider building
# ---------------------------------------------------------------------------


def test_create_provider_custom():
    cfg = Config()
    cfg.agents.defaults.provider = "custom"
    p = create_provider(cfg)
    assert isinstance(p, CustomProvider)


def test_create_provider_ollama_via_litellm():
    cfg = Config()
    cfg.agents.defaults.provider = "ollama"
    p = create_provider(cfg)
    assert isinstance(p, LiteLLMProvider)


def test_create_provider_lmstudio_direct():
    cfg = Config()
    cfg.agents.defaults.provider = "lmstudio"
    p = create_provider(cfg)
    assert isinstance(p, CustomProvider)


def test_create_provider_missing():
    cfg = Config()
    cfg.agents.defaults.provider = "nope"
    with pytest.raises(ValueError):
        create_provider(cfg)


def test_build_provider_remote_requires_key():
    cfg = ProviderConfig(kind="litellm", api_base="https://api.remote.dev/v1", api_key="dummy")
    # /v1 endpoint → direct OpenAI client even without a real key
    assert isinstance(build_provider("remote", cfg, "gpt-4o"), CustomProvider)

    # Non-/v1 remote kind without a real key → must raise
    cfg2 = ProviderConfig(kind="litellm", api_base="https://api.remote.dev", api_key="dummy")
    with pytest.raises(ValueError):
        build_provider("remote", cfg2, "gpt-4o")


def test_build_provider_v1_endpoint_direct():
    cfg = ProviderConfig(kind="litellm", api_base="https://api.remote.dev/v1", api_key="sk-real")
    p = build_provider("remote", cfg, "gpt-4o")
    assert isinstance(p, CustomProvider)


def test_build_provider_openai_kind_direct():
    cfg = ProviderConfig(kind="openai", api_base="http://localhost:8000", api_key="sk-test")
    p = build_provider("myopenai", cfg, "gpt-4o")
    assert isinstance(p, CustomProvider)
    # api_base normalized to a /v1 endpoint
    assert p.api_base == "http://localhost:8000/v1"


def test_build_provider_openai_kind_v1_passthrough():
    cfg = ProviderConfig(kind="openai", api_base="https://api.openai.com/v1", api_key="sk-test")
    p = build_provider("myopenai", cfg, "gpt-4o")
    assert isinstance(p, CustomProvider)
    assert p.api_base == "https://api.openai.com/v1"


def test_build_provider_anthropic_kind():
    cfg = ProviderConfig(
        kind="anthropic", api_base="https://api.anthropic.com", api_key="sk-ant-test"
    )
    p = build_provider("claude", cfg, "claude-3-5-sonnet")
    assert isinstance(p, LiteLLMProvider)
    assert p.api_base == "https://api.anthropic.com"


def test_build_provider_anthropic_kind_requires_key():
    cfg = ProviderConfig(kind="anthropic", api_base="https://api.anthropic.com", api_key="dummy")
    with pytest.raises(ValueError):
        build_provider("claude", cfg, "claude-3-5-sonnet")


# ---------------------------------------------------------------------------
# Model listing
# ---------------------------------------------------------------------------


def test_model_list_url():
    from sarathy.providers.manager import _model_list_url

    assert _model_list_url("ollama", "http://localhost:11434") == "http://localhost:11434/api/tags"
    assert _model_list_url("custom", "http://x/v1") == "http://x/v1/models"
    assert _model_list_url("custom", "http://x") == "http://x/v1/models"


def test_list_models_ollama():
    cfg = Config()
    resp = Mock()
    resp.raise_for_status.return_value = None
    resp.json.return_value = {"models": [{"name": "llama3"}, {"name": "qwen2"}]}
    with patch("sarathy.providers.manager.httpx.get", return_value=resp) as m:
        models = list_models("ollama", cfg)
    assert models == ["llama3", "qwen2"]
    assert m.call_args[0][0] == "http://localhost:11434/api/tags"


def test_list_models_openai():
    cfg = Config()
    cfg.providers["custom"].api_base = "http://x/v1"
    resp = Mock()
    resp.raise_for_status.return_value = None
    resp.json.return_value = {"data": [{"id": "gpt-4o"}, {"id": "gpt-4o-mini"}]}
    with patch("sarathy.providers.manager.httpx.get", return_value=resp) as m:
        models = list_models("custom", cfg)
    assert models == ["gpt-4o", "gpt-4o-mini"]
    assert m.call_args[0][0] == "http://x/v1/models"


def test_list_models_error():
    cfg = Config()
    cfg.providers["custom"].api_base = "http://x/v1"
    resp = Mock()
    resp.raise_for_status.side_effect = Exception("boom")
    with patch("sarathy.providers.manager.httpx.get", return_value=resp):
        with pytest.raises(ValueError) as e:
            list_models("custom", cfg)
    assert "Failed to list models" in str(e.value)


def test_list_models_missing_provider():
    cfg = Config()
    with pytest.raises(ValueError):
        list_models("ghost", cfg)


# ---------------------------------------------------------------------------
# RuntimeProvider hot-reload
# ---------------------------------------------------------------------------


_M_TIME_COUNTER = [1_700_000_000.0]


def _write_config(path: Path, provider: str, model: str, temperature: float = 0.7) -> None:
    cfg = Config()
    cfg.agents.defaults.provider = provider
    cfg.agents.defaults.model = model
    cfg.agents.defaults.temperature = temperature
    save_config(cfg, path)
    # Force a distinct mtime (this environment's FS doesn't advance it reliably).
    import os

    _M_TIME_COUNTER[0] += 1.0
    os.utime(path, (_M_TIME_COUNTER[0], _M_TIME_COUNTER[0]))


def _runtime(tmp_path, provider: str = "ollama", model: str = "llama3"):
    config_path = tmp_path / "config.json"
    _write_config(config_path, provider, model)
    cfg = Config()
    cfg.agents.defaults.provider = provider
    cfg.agents.defaults.model = model
    cfg.agents.defaults.temperature = 0.7
    return RuntimeProvider(cfg, config_path=config_path), config_path


def test_runtime_reload_on_mtime_change(tmp_path):
    runtime, config_path = _runtime(tmp_path)
    assert runtime.model == "llama3"

    # No change to the file → refresh reports no change
    assert runtime.refresh() is False

    _write_config(config_path, "ollama", "qwen2", temperature=0.3)
    assert runtime.refresh() is True
    assert runtime.model == "qwen2"
    assert runtime.temperature == 0.3


def test_runtime_reload_ignores_other_config_sections(tmp_path):
    runtime, config_path = _runtime(tmp_path)

    cfg = Config()
    cfg.agents.defaults.provider = "ollama"
    cfg.agents.defaults.model = "llama3"
    cfg.agents.defaults.temperature = 0.7
    cfg.channels.telegram.enabled = True
    save_config(cfg, config_path)
    assert runtime.refresh() is False


def test_runtime_set_active_persists(tmp_path):
    runtime, config_path = _runtime(tmp_path)

    from sarathy.config.loader import load_config

    cfg = Config()
    cfg.agents.defaults.provider = "myprov"
    cfg.agents.defaults.model = "llama3"
    cfg.providers["myprov"] = ProviderConfig(kind="custom", api_base="http://x/v1", api_key="k")
    cfg.providers.pop("ollama")
    save_config(cfg, config_path)

    runtime.set_active("myprov", model="gpt-4o")
    assert runtime.model == "gpt-4o"
    assert runtime.config.agents.defaults.provider == "myprov"
    reloaded = load_config(config_path)
    assert reloaded.agents.defaults.provider == "myprov"
    assert reloaded.agents.defaults.model == "gpt-4o"


def test_runtime_on_change_callback(tmp_path):
    runtime, config_path = _runtime(tmp_path)
    calls = []
    runtime.on_change(lambda: calls.append("changed"))

    _write_config(config_path, "ollama", "qwen2")
    runtime.refresh()
    assert calls == ["changed"]


# ---------------------------------------------------------------------------
# Provider roles (main / local)
# ---------------------------------------------------------------------------


def _role_config(tmp_path):
    """Config with three providers: active main, tagged local, ad-hoc."""
    from sarathy.config.loader import save_config

    cfg = Config()
    cfg.agents.defaults.provider = "mainprov"
    cfg.agents.defaults.model = "llama3"
    cfg.providers["mainprov"] = ProviderConfig(
        kind="custom", api_base="http://main/v1", api_key="k", role="main"
    )
    cfg.providers["localprov"] = ProviderConfig(
        kind="custom", api_base="http://local/v1", api_key="k", role="local"
    )
    cfg.providers["adhoc"] = ProviderConfig(
        kind="custom", api_base="http://adhoc/v1", api_key="k"
    )
    for drop in ("ollama", "lmstudio", "vllm"):
        cfg.providers.pop(drop)
    save_config(cfg, tmp_path / "config.json")
    return cfg, tmp_path / "config.json"


def test_provider_role_schema_default():
    cfg = ProviderConfig(kind="custom", api_base="http://x/v1", api_key="k")
    assert cfg.role == ""


def test_provider_role_schema_model_field():
    cfg = ProviderConfig(kind="custom", api_base="http://x/v1", api_key="k", model="qwen3:27b")
    assert cfg.model == "qwen3:27b"
    assert ProviderConfig(kind="custom", api_base="http://x/v1", api_key="k").model == ""


def test_provider_role_status(tmp_path):
    cfg, config_path = _role_config(tmp_path)
    runtime = RuntimeProvider(cfg, config_path=config_path)
    roles = runtime.role_status()
    assert roles["main"] == "mainprov"
    assert roles["local"] == "localprov"
    assert roles["active"] == "mainprov"


def test_provider_for_local(tmp_path):
    cfg, config_path = _role_config(tmp_path)
    runtime = RuntimeProvider(cfg, config_path=config_path)
    p = runtime.provider_for("local")
    assert p is not None
    assert p.api_base == "http://local/v1"


def test_provider_for_local_uses_own_model(tmp_path):
    cfg, config_path = _role_config(tmp_path)
    cfg.providers["localprov"].model = "qwen3:27b"
    runtime = RuntimeProvider(cfg, config_path=config_path)
    p = runtime.provider_for("local")
    assert p is not None
    assert p.get_default_model() == "qwen3:27b"


def test_provider_role_falls_back_to_active_model(tmp_path):
    cfg, config_path = _role_config(tmp_path)
    runtime = RuntimeProvider(cfg, config_path=config_path)
    p = runtime.provider_for("local")
    assert p is not None
    assert p.get_default_model() == "llama3"


def test_provider_for_main_unassigned_falls_back_to_active(tmp_path):
    runtime, config_path = _runtime(tmp_path)
    p = runtime.provider_for("main")
    assert p is not None
    assert p.api_base == runtime.provider.api_base


def test_provider_for_unknown_role_none(tmp_path):
    cfg, config_path = _role_config(tmp_path)
    runtime = RuntimeProvider(cfg, config_path=config_path)
    assert runtime.provider_for("bogus") is None


def test_provider_for_local_missing_returns_none(tmp_path):
    runtime, config_path = _runtime(tmp_path)
    assert runtime.provider_for("local") is None


def test_set_role_persists(tmp_path):
    cfg, config_path = _role_config(tmp_path)
    runtime = RuntimeProvider(cfg, config_path=config_path)

    runtime.set_role("local", "adhoc")
    from sarathy.config.loader import load_config

    reloaded = load_config(config_path)
    assert reloaded.providers["adhoc"].role == "local"
    assert runtime.provider_for("local").api_base == "http://adhoc/v1"


def test_set_role_main_is_exclusive(tmp_path):
    cfg, config_path = _role_config(tmp_path)
    runtime = RuntimeProvider(cfg, config_path=config_path)

    runtime.set_role("main", "adhoc")
    from sarathy.config.loader import load_config

    reloaded = load_config(config_path)
    assert reloaded.providers["adhoc"].role == "main"
    assert reloaded.providers["mainprov"].role == ""


def test_set_role_unknown_raises(tmp_path):
    cfg, config_path = _role_config(tmp_path)
    runtime = RuntimeProvider(cfg, config_path=config_path)
    import pytest

    with pytest.raises(ValueError, match="main' or 'local"):
        runtime.set_role("bogus", "adhoc")


# ---------------------------------------------------------------------------
# /provider add handler (chat)
# ---------------------------------------------------------------------------


class TestHandleProviderAdd:
    @pytest.mark.asyncio
    async def test_add_openai_provider(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path))
        from unittest.mock import MagicMock, patch

        from sarathy.agent.loop import AgentLoop
        from sarathy.bus.events import InboundMessage
        from sarathy.bus.queue import MessageBus
        from sarathy.session.manager import SessionManager

        provider = MagicMock()
        provider.get_default_model.return_value = "test-model"
        workspace = MagicMock()
        workspace.__truediv__ = MagicMock(return_value=MagicMock())
        sm = MagicMock(spec=SessionManager)
        bus = MessageBus()

        with patch("sarathy.agent.loop.ContextBuilder"), patch(
            "sarathy.agent.loop.SubagentManager"
        ):
            loop = AgentLoop(bus=bus, provider=provider, workspace=workspace, session_manager=sm)

        msg = InboundMessage(
            channel="telegram", sender_id="u1", chat_id="c1", content="/provider add"
        )
        out = await loop._handle_provider_add(
            sm, msg, "mylms --api-base http://localhost:1234 --set-active"
        )
        assert "Added provider 'mylms'" in out.content
        assert "http://localhost:1234/v1" in out.content

        from sarathy.config.loader import load_config

        cfg = load_config()
        assert cfg.providers["mylms"].kind == "openai"
        assert cfg.providers["mylms"].api_base == "http://localhost:1234/v1"
        assert cfg.agents.defaults.provider == "mylms"

    @pytest.mark.asyncio
    async def test_add_provider_rejects_unknown_kind(self, tmp_path, monkeypatch):
        monkeypatch.setenv("HOME", str(tmp_path))
        from unittest.mock import MagicMock, patch

        from sarathy.agent.loop import AgentLoop
        from sarathy.bus.events import InboundMessage
        from sarathy.bus.queue import MessageBus
        from sarathy.session.manager import SessionManager

        provider = MagicMock()
        provider.get_default_model.return_value = "test-model"
        workspace = MagicMock()
        workspace.__truediv__ = MagicMock(return_value=MagicMock())
        sm = MagicMock(spec=SessionManager)
        bus = MessageBus()

        with patch("sarathy.agent.loop.ContextBuilder"), patch(
            "sarathy.agent.loop.SubagentManager"
        ):
            loop = AgentLoop(bus=bus, provider=provider, workspace=workspace, session_manager=sm)

        msg = InboundMessage(
            channel="telegram", sender_id="u1", chat_id="c1", content="/provider add"
        )
        out = await loop._handle_provider_add(sm, msg, "foo --kind ollama")
        assert "openai" in out.content and "anthropic" in out.content


# ---------------------------------------------------------------------------
# /provider role handler (chat) — role + optional per-provider model
# ---------------------------------------------------------------------------


class TestHandleProviderRole:
    @pytest.mark.asyncio
    async def test_role_local_sets_role_and_model(self, tmp_path):
        from unittest.mock import MagicMock, patch

        from sarathy.agent.loop import AgentLoop
        from sarathy.bus.events import InboundMessage
        from sarathy.bus.queue import MessageBus
        from sarathy.config.loader import load_config, save_config
        from sarathy.session.manager import SessionManager

        cfg = Config()
        cfg.agents.defaults.provider = "ollama"
        cfg.agents.defaults.model = "llama3"
        cfg.providers["ollama"] = ProviderConfig(
            kind="ollama", api_base="http://localhost:11434", api_key="dummy"
        )
        for drop in ("custom", "lmstudio", "vllm"):
            cfg.providers.pop(drop)
        save_config(cfg, tmp_path / "config.json")

        provider = MagicMock()
        provider.get_default_model.return_value = "llama3"
        workspace = MagicMock()
        workspace.__truediv__ = MagicMock(return_value=MagicMock())
        sm = MagicMock(spec=SessionManager)
        bus = MessageBus()
        runtime = RuntimeProvider(cfg, config_path=tmp_path / "config.json")

        with patch("sarathy.agent.loop.ContextBuilder"), patch(
            "sarathy.agent.loop.SubagentManager"
        ):
            loop = AgentLoop(
                bus=bus,
                provider=provider,
                workspace=workspace,
                session_manager=sm,
                runtime=runtime,
            )

        msg = InboundMessage(
            channel="telegram", sender_id="u1", chat_id="c1", content="/provider role"
        )
        out = await loop._handle_provider_command(sm, msg, "role local ollama qwen3:27b")
        assert "Tagged ollama as local provider with model qwen3:27b" in out.content

        reloaded = load_config(tmp_path / "config.json")
        assert reloaded.providers["ollama"].role == "local"
        assert reloaded.providers["ollama"].model == "qwen3:27b"
        assert runtime.provider_for("local").get_default_model() == "qwen3:27b"

    @pytest.mark.asyncio
    async def test_role_local_without_model_falls_back(self, tmp_path):
        from unittest.mock import MagicMock, patch

        from sarathy.agent.loop import AgentLoop
        from sarathy.bus.events import InboundMessage
        from sarathy.bus.queue import MessageBus
        from sarathy.config.loader import load_config, save_config
        from sarathy.session.manager import SessionManager

        cfg = Config()
        cfg.agents.defaults.provider = "ollama"
        cfg.agents.defaults.model = "llama3"
        cfg.providers["ollama"] = ProviderConfig(
            kind="ollama", api_base="http://localhost:11434", api_key="dummy"
        )
        for drop in ("custom", "lmstudio", "vllm"):
            cfg.providers.pop(drop)
        save_config(cfg, tmp_path / "config.json")

        provider = MagicMock()
        provider.get_default_model.return_value = "llama3"
        workspace = MagicMock()
        workspace.__truediv__ = MagicMock(return_value=MagicMock())
        sm = MagicMock(spec=SessionManager)
        bus = MessageBus()
        runtime = RuntimeProvider(cfg, config_path=tmp_path / "config.json")

        with patch("sarathy.agent.loop.ContextBuilder"), patch(
            "sarathy.agent.loop.SubagentManager"
        ):
            loop = AgentLoop(
                bus=bus,
                provider=provider,
                workspace=workspace,
                session_manager=sm,
                runtime=runtime,
            )

        msg = InboundMessage(
            channel="telegram", sender_id="u1", chat_id="c1", content="/provider role"
        )
        out = await loop._handle_provider_command(sm, msg, "role local ollama")
        assert "Tagged ollama as local provider." in out.content

        reloaded = load_config(tmp_path / "config.json")
        assert reloaded.providers["ollama"].role == "local"
        assert reloaded.providers["ollama"].model == ""
        assert runtime.provider_for("local").get_default_model() == "llama3"

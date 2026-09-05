"""Tests for /context upgrade + provider context-length detection (job 68 §3D)."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from sarathy.config.schema import Config, ProviderConfig
from sarathy.providers import manager


@pytest.fixture(autouse=True)
def _clear_context_cache():
    manager._CONTEXT_LENGTH_CACHE.clear()
    yield
    manager._CONTEXT_LENGTH_CACHE.clear()


# ---------------------------------------------------------------------------
# get_context_length
# ---------------------------------------------------------------------------


def test_openai_compatible_models_payload():
    cfg = Config()
    cfg.providers["custom"].api_base = "http://x/v1"
    resp = MagicMock()
    resp.raise_for_status.side_effect = None
    resp.json.return_value = {
        "data": [
            {"id": "model-x", "max_model_len": 32768},
            {"id": "other", "context_length": 4096},
        ]
    }
    with patch.object(manager.httpx, "get", return_value=resp) as mock_get:
        length = manager.get_context_length("custom", cfg, "model-x")

    assert length == 32768
    assert mock_get.call_args[0][0] == "http://x/v1/models"


def test_ollama_show_payload():
    cfg = Config()
    resp = MagicMock()
    resp.raise_for_status.side_effect = None
    resp.json.return_value = {
        "model_info": {
            "context_length": 131072,
            "architecture": "llama",
            "quantization_level": "Q4_K_M",
        },
        "details": {"families": ["llama"], "parameter_size": "8.0B"},
    }
    with patch.object(manager.httpx, "get", return_value=resp) as mock_get:
        length = manager.get_context_length("ollama", cfg, "llama3:8b")

    assert length == 131072
    assert mock_get.call_args[0][0] == "http://localhost:11434/api/show/llama3:8b"


def test_returns_none_on_http_error():
    cfg = Config()
    cfg.providers["custom"].api_base = "http://x/v1"
    with patch.object(manager.httpx, "get", side_effect=Exception("boom")):
        assert manager.get_context_length("custom", cfg, "gpt-4o") is None


def test_returns_none_when_model_not_listed():
    cfg = Config()
    cfg.providers["custom"].api_base = "http://x/v1"
    resp = MagicMock()
    resp.raise_for_status.side_effect = None
    resp.json.return_value = {"data": [{"id": "other", "context_length": 4096}]}
    with patch.object(manager.httpx, "get", return_value=resp):
        assert manager.get_context_length("custom", cfg, "missing") is None


def test_caches_per_provider_model_pair():
    cfg = Config()
    cfg.providers["custom"].api_base = "http://x/v1"
    resp = MagicMock()
    resp.raise_for_status.side_effect = None
    resp.json.return_value = {"data": [{"id": "gpt-4o", "context_length": 128000}]}
    with patch.object(manager.httpx, "get", return_value=resp) as mock_get:
        assert manager.get_context_length("custom", cfg, "gpt-4o") == 128000
        assert manager.get_context_length("custom", cfg, "gpt-4o") == 128000
    assert mock_get.call_count == 1


def test_litellm_hosted_best_effort():
    cfg = Config()
    cfg.providers["claude"] = ProviderConfig(
        kind="anthropic", api_base="https://api.anthropic.com", api_key="sk-thing"
    )
    length = manager.get_context_length("claude", cfg, "gpt-4o")
    assert isinstance(length, int) and length > 0


# ---------------------------------------------------------------------------
# /context handler
# ---------------------------------------------------------------------------


def _make_loop(tmp_path):
    from conftest import make_test_config

    from sarathy.agent.loop import AgentLoop
    from sarathy.bus.queue import MessageBus
    from sarathy.session.manager import SessionManager

    bus = MessageBus()
    provider = MagicMock()
    provider.get_default_model.return_value = "gpt-4o"
    sm = SessionManager(config=make_test_config(tmp_path), workspace=tmp_path)
    loop = AgentLoop(
        bus=bus,
        provider=provider,
        workspace=tmp_path,
        model="gpt-4o",
        session_manager=sm,
        context_length=8192,
    )
    loop.tools.get_definitions = MagicMock(return_value=[])
    return loop


def _context_reply(loop, session):
    from sarathy.bus.events import InboundMessage

    msg = InboundMessage(channel="cli", sender_id="user", chat_id="direct", content="/context")
    return loop._handle_context_command(session, msg)


def test_context_command_with_detected_length(tmp_path):
    cfg = Config()
    cfg.agents.defaults.provider = "custom"
    loop = _make_loop(tmp_path)
    loop.runtime = MagicMock()
    loop.runtime.config = cfg

    session = loop.sessions.get_or_create("cli:direct")
    session.add_message("user", "hello")
    session.add_message("assistant", "hi there")

    with (
        patch.object(manager, "get_context_length", return_value=128000),
        patch("sarathy.agent.loop.estimate_tokens", return_value=1000),
        patch("sarathy.agent.loop.estimate_messages_tokens", return_value=500),
    ):
        out = _context_reply(loop, session)

    assert "Session: cli:direct" in out.content
    assert "Messages in session: 2" in out.content
    assert "~128,000 tokens (detected)" in out.content
    assert "Est. prompt tokens: ~2,500" in out.content
    assert "Usage: 2.0%" in out.content
    assert "✅ Context OK" in out.content


def test_context_command_falls_back_to_config_length(tmp_path):
    cfg = Config()
    cfg.agents.defaults.provider = "custom"
    loop = _make_loop(tmp_path)
    loop.runtime = MagicMock()
    loop.runtime.config = cfg

    session = loop.sessions.get_or_create("cli:direct")

    with (
        patch.object(manager, "get_context_length", return_value=None),
        patch("sarathy.agent.loop.estimate_tokens", return_value=1000),
        patch("sarathy.agent.loop.estimate_messages_tokens", return_value=500),
    ):
        out = _context_reply(loop, session)

    assert "~8,192 tokens (config)" in out.content
    assert "Remaining: ~5,692 tokens" in out.content


def test_context_command_warns_near_full(tmp_path):
    cfg = Config()
    cfg.agents.defaults.provider = "custom"
    loop = _make_loop(tmp_path)
    loop.context_length = 2000
    loop.runtime = MagicMock()
    loop.runtime.config = cfg

    session = loop.sessions.get_or_create("cli:direct")

    with (
        patch.object(manager, "get_context_length", return_value=None),
        patch("sarathy.agent.loop.estimate_tokens", return_value=1000),
        patch("sarathy.agent.loop.estimate_messages_tokens", return_value=500),
    ):
        out = _context_reply(loop, session)

    assert "Usage: 125.0%" in out.content
    assert "⚠️ Consider /new to start fresh" in out.content

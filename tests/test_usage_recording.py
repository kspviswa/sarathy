"""Tests for usage recording in the agent loop."""

import asyncio
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sarathy.agent.loop import AgentLoop
from sarathy.bus.events import InboundMessage, OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from sarathy.session.manager import SessionManager
from sarathy.config.schema import Config


class MockProvider(LLMProvider):
    """Mock provider for testing."""

    def __init__(self, responses=None):
        super().__init__("test-key", "http://localhost:8000/v1")
        self.responses = responses or []
        self.call_count = 0
        self.default_model = "test-model"
        self.provider_name = "mock-provider"
        self.api_base = "http://localhost:8000/v1"

    async def chat(self, *args, **kwargs):
        if self.call_count < len(self.responses):
            resp = self.responses[self.call_count]
        else:
            resp = LLMResponse(content="Done", finish_reason="stop")
        self.call_count += 1
        return resp

    def get_default_model(self):
        return self.default_model


class MockProviderWithTools(MockProvider):
    """Mock provider that returns tool calls in first response."""

    def __init__(self, responses=None):
        super().__init__(responses)

    async def chat(self, *args, **kwargs):
        if self.call_count < len(self.responses):
            resp = self.responses[self.call_count]
        else:
            resp = LLMResponse(content="Done", finish_reason="stop")
        self.call_count += 1
        return resp


class MockSessionManager(SessionManager):
    """Mock session manager that doesn't need config."""

    def __init__(self):
        # Don't call super().__init__ to avoid config requirements
        self._cache = {}
        self._max_cache_size = 50

    def get_or_create(self, key):
        if key not in self._cache:
            from sarathy.session.manager import Session

            self._cache[key] = Session(key=key)
        return self._cache[key]

    def save(self, session):
        pass

    def invalidate(self, key):
        self._cache.pop(key, None)

    def _create_new_session(self, key):
        from sarathy.session.manager import Session

        session = Session(key=key)
        self._cache[key] = session
        return session


@pytest.fixture
def mock_config():
    """Create a minimal mock config."""
    config = MagicMock(spec=Config)
    config.agents = MagicMock()
    config.agents.defaults = MagicMock()
    config.agents.defaults.workspace = "/tmp/test"
    config.agents.memory_archival = MagicMock()
    config.agents.memory_archival.max_session_size = 500
    config.agents.memory_archival.auto_create_new_session = True
    config.channels = MagicMock()
    config.channels.telegram = MagicMock(streaming=False)
    config.channels.discord = MagicMock(streaming=False)
    config.channels.dashboard = MagicMock(streaming=False)
    config.channels.email = MagicMock(enabled=False)
    return config


@pytest.fixture
def temp_workspace(tmp_path):
    """Create a temporary workspace."""
    workspace = tmp_path / "workspace"
    workspace.mkdir()
    return workspace


def test_record_usage_writes_one_row_per_model_call(temp_workspace, mock_config):
    """Test that _record_usage writes one row per model call."""
    from sarathy.usage.store import get_usage_store, reset_usage_store

    # Use temp database
    db_path = temp_workspace / "usage.db"
    import os

    os.environ["SARATHY_USAGE_DB"] = str(db_path)
    reset_usage_store()

    try:
        bus = MessageBus()
        session_manager = MockSessionManager()
        provider = MockProvider(
                responses=[
                    LLMResponse(
                        content="First response",
                        finish_reason="stop",
                        usage={"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
                        tool_calls=[ToolCallRequest(id="tc1", name="test_tool", arguments={})],
                    ),
                    LLMResponse(
                        content="Second response",
                        finish_reason="stop",
                        usage={"prompt_tokens": 200, "cached_tokens": 50, "completion_tokens": 80, "total_tokens": 280},
                    ),
                ]
            )

        loop = AgentLoop(
            bus=bus,
            provider=provider,
            workspace=temp_workspace,
            session_manager=session_manager,
        )

        # Run a simple message processing
        msg = InboundMessage(
            channel="test",
            sender_id="user1",
            chat_id="chat1",
            content="Hello",
            session_key_override="test:chat1",
        )

        # Process the message
        asyncio.run(loop._process_message(msg))

        # Check that usage was recorded
        store = get_usage_store()
        summary = store.summary(days=7)

        # Should have 2 records (one per model call)
        assert summary["available"] is True
        assert summary["totals"]["requests"] == 2
        assert summary["totals"]["prompt_tokens"] == 300
        assert summary["totals"]["cached_tokens"] == 50
        assert summary["totals"]["completion_tokens"] == 130
    finally:
        reset_usage_store()
        os.environ.pop("SARATHY_USAGE_DB", None)


def test_store_failure_does_not_break_turn(temp_workspace, mock_config):
    """Test that a store failure does not break the turn."""
    from sarathy.usage.store import get_usage_store, reset_usage_store

    # Use temp database
    db_path = temp_workspace / "usage.db"
    import os

    os.environ["SARATHY_USAGE_DB"] = str(db_path)
    reset_usage_store()

    try:
        bus = MessageBus()
        session_manager = MockSessionManager()

        # Create a provider that returns valid responses
        provider = MockProvider(
            responses=[
                LLMResponse(
                    content="Response",
                    finish_reason="stop",
                    usage={"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
                ),
            ]
        )

        loop = AgentLoop(
            bus=bus,
            provider=provider,
            workspace=temp_workspace,
            session_manager=session_manager,
        )

        # Mock get_usage_store to raise an exception
        with patch("sarathy.usage.store.get_usage_store") as mock_get_store:
            mock_store = MagicMock()
            mock_store.record.side_effect = Exception("DB error")
            mock_get_store.return_value = mock_store

            msg = InboundMessage(
                channel="test",
                sender_id="user1",
                chat_id="chat1",
                content="Hello",
                session_key_override="test:chat1",
            )

            # This should not raise despite the store failure
            response = asyncio.run(loop._process_message(msg))

            # Should still get a response
            assert response is not None
            assert response.content == "Response"
    finally:
        reset_usage_store()
        os.environ.pop("SARATHY_USAGE_DB", None)


def test_session_key_threaded_to_provider(temp_workspace, mock_config):
    """Test that session_key is passed to provider as session_id for OpenRouter."""
    from sarathy.usage.store import get_usage_store, reset_usage_store

    db_path = temp_workspace / "usage.db"
    import os

    os.environ["SARATHY_USAGE_DB"] = str(db_path)
    reset_usage_store()

    try:
        bus = MessageBus()
        session_manager = MockSessionManager()

        # Create a provider that captures the session_id kwarg
        captured_kwargs = {}

        class CapturingProvider(MockProvider):
            async def chat(self, *args, **kwargs):
                captured_kwargs.update(kwargs)
                return await super().chat(*args, **kwargs)

        provider = CapturingProvider(
            responses=[
                LLMResponse(
                    content="Response",
                    finish_reason="stop",
                    usage={"prompt_tokens": 100, "completion_tokens": 50, "total_tokens": 150},
                ),
            ]
        )
        # Make it look like OpenRouter
        provider.api_base = "https://openrouter.ai/api/v1"

        loop = AgentLoop(
            bus=bus,
            provider=provider,
            workspace=temp_workspace,
            session_manager=session_manager,
        )

        msg = InboundMessage(
            channel="test",
            sender_id="user1",
            chat_id="chat1",
            content="Hello",
            session_key_override="test:chat1",
        )

        asyncio.run(loop._process_message(msg))

        # Check that session_id was passed to provider.chat
        assert "session_id" in captured_kwargs
        assert captured_kwargs["session_id"] == "test:chat1"
    finally:
        reset_usage_store()
        os.environ.pop("SARATHY_USAGE_DB", None)
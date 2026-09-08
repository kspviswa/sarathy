"""Tests for per-turn provider-role dispatch (task-declared routing).

A task payload may carry ``metadata.provider_role`` (e.g. ``"local"``) so the
message parser routes that single turn to the tagged provider without touching
the global active provider. Covers the cron / manana-fill / wiki-lint paths.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sarathy.agent.loop import AgentLoop
from sarathy.bus.events import InboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.config.schema import Config
from sarathy.session.manager import SessionManager


class FakeProvider:
    """Minimal provider stub that records the model it was asked to use."""

    def __init__(self, name: str = "main"):
        self.name = name
        self.calls: list[dict] = []

    def get_default_model(self) -> str:
        return f"{self.name}-model"

    async def chat(self, messages: list[dict] | None = None, **kwargs) -> "LLMResponse":
        from sarathy.providers.base import LLMResponse

        self.calls.append({"messages": list(messages or []), **kwargs})
        return LLMResponse(content=f"reply from {self.name}")


class FakeRuntime:
    """RuntimeProvider stand-in: returns a provider per role, records lookups."""

    def __init__(self, local_provider=None):
        self.main_provider = FakeProvider("main")
        self.local_provider = local_provider
        self.lookups: list[str] = []

    def provider_for(self, role: str):
        self.lookups.append(role)
        if role == "local":
            return self.local_provider
        return self.main_provider

    def apply_to(self, agent) -> bool:
        return False


def _make_loop(tmp_path, provider, runtime):
    workspace = tmp_path / "ws"
    workspace.mkdir(exist_ok=True)
    bus = MessageBus()
    sm = SessionManager(Config(), workspace=tmp_path / "sessions")
    with patch("sarathy.agent.loop.ContextBuilder"), \
         patch("sarathy.agent.loop.SubagentManager"):
        loop = AgentLoop(
            bus=bus,
            provider=provider,
            workspace=workspace,
            model="main-model",
            session_manager=sm,
        )
    loop.runtime = runtime
    loop.context.build_messages.return_value = [{"role": "user", "content": "hi"}]
    loop.context.add_assistant_message.side_effect = (
        lambda msgs, content=None, tool_calls=None, reasoning_content=None: (
            msgs.append({"role": "assistant", "content": content}), msgs
        )[1]
    )
    loop.context.add_tool_result.side_effect = (
        lambda msgs, tool_id, name, result: (
            msgs.append({"role": "tool", "tool_call_id": tool_id, "name": name, "content": str(result)}),
            msgs,
        )[1]
    )
    loop.context.get_history.return_value = []
    loop.channels_config = Config().channels
    return loop, bus


@pytest.mark.asyncio
async def test_provider_role_local_uses_local_provider(tmp_path):
    """A message with metadata.provider_role='local' runs on the local provider
    and restores the main provider after the turn."""
    local = FakeProvider("local")
    runtime = FakeRuntime(local_provider=local)
    main = FakeProvider("main")
    loop, bus = _make_loop(tmp_path, main, runtime)

    msg = InboundMessage(
        channel="cli",
        sender_id="user",
        chat_id="direct",
        content="fill the page",
        metadata={"provider_role": "local"},
    )
    out = await loop._process_message(msg, session_key="cron:test")

    assert runtime.lookups == ["local"]
    assert local.calls, "local provider should have served the turn"
    assert main.calls == [], "main provider should not have been touched"
    assert "local" in (out.content or "")
    # Active provider restored after the turn.
    assert loop.provider is main


@pytest.mark.asyncio
async def test_provider_role_unset_uses_active(tmp_path):
    """No provider_role metadata → the active provider serves the turn as usual."""
    local = FakeProvider("local")
    runtime = FakeRuntime(local_provider=local)
    main = FakeProvider("main")
    loop, bus = _make_loop(tmp_path, main, runtime)

    msg = InboundMessage(
        channel="cli", sender_id="user", chat_id="direct", content="hello", metadata={}
    )
    out = await loop._process_message(msg, session_key="cron:test")

    assert runtime.lookups == []
    assert main.calls, "active provider should serve the turn"
    assert local.calls == []


@pytest.mark.asyncio
async def test_provider_role_local_missing_falls_back_to_active(tmp_path):
    """provider_role='local' with no local provider configured → active provider
    handles the turn (graceful fallback, no crash)."""
    runtime = FakeRuntime(local_provider=None)
    main = FakeProvider("main")
    loop, bus = _make_loop(tmp_path, main, runtime)

    msg = InboundMessage(
        channel="cli",
        sender_id="user",
        chat_id="direct",
        content="hello",
        metadata={"provider_role": "local"},
    )
    out = await loop._process_message(msg, session_key="cron:test")

    assert runtime.lookups == ["local"]
    assert main.calls, "fell back to active provider"
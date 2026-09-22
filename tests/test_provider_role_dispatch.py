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

    def __init__(self, local_provider=None, image_provider=None):
        self.main_provider = FakeProvider("main")
        self.local_provider = local_provider
        self.image_provider = image_provider
        self.lookups: list[str] = []

    def provider_for(self, role: str):
        self.lookups.append(role)
        if role == "local":
            return self.local_provider
        if role == "image":
            return self.image_provider
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


@pytest.mark.asyncio
async def test_image_provider_describes_then_main_drives(tmp_path):
    """When messages contain images and an image provider is configured,
    the image provider is called for description, then messages are rewritten
    with [image description: ...] hint, and the main provider drives the turn."""
    image = FakeProvider("image")
    runtime = FakeRuntime(local_provider=None, image_provider=image)
    main = FakeProvider("main")
    loop, bus = _make_loop(tmp_path, main, runtime)

    # Override the class method for this instance
    def mock_has_image_content(msgs):
        return any(
            isinstance(m.get("content"), list) and any(p.get("type") == "image_url" for p in m.get("content", []))
            for m in msgs
        )
    loop._has_image_content = mock_has_image_content

    # Track if _describe_images_with_image_provider was called
    describe_called = {"called": False, "provider": None}
    original_describe = loop._describe_images_with_image_provider
    async def mock_describe(msgs, img_provider, **kwargs):
        describe_called["called"] = True
        describe_called["provider"] = img_provider
        # Rewrite user message content
        new_msgs = []
        for m in msgs:
            if m.get("role") == "user" and isinstance(m.get("content"), list):
                new_msgs.append({**m, "content": [{"type": "text", "text": "[image description: a cat sitting on a mat]"}]} )
            else:
                new_msgs.append(m)
        return new_msgs
    loop._describe_images_with_image_provider = mock_describe

    msg = InboundMessage(
        channel="cli",
        sender_id="user",
        chat_id="direct",
        content="What's in this image?",
        metadata={},
    )
    # Inject image content into the messages that will be built
    loop.context.build_messages.return_value = [
        {"role": "user", "content": [
            {"type": "text", "text": "What's in this image?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc123"}}
        ]}
    ]

    out = await loop._process_message(msg, session_key="test:image")

    # Image provider should have been looked up
    assert "image" in runtime.lookups
    # _describe_images_with_image_provider should have been called with the image provider
    assert describe_called["called"], "_describe_images_with_image_provider should have been called"
    assert describe_called["provider"] is image, "image provider should be passed to describe method"

    # Main provider should have been called with rewritten messages
    assert main.calls, "main provider should drive the turn"
    # Check that the main provider received the description hint
    main_call_messages = main.calls[0]["messages"]
    user_msgs = [m for m in main_call_messages if m.get("role") == "user"]
    assert user_msgs, "should have user message"
    # The user message should have the description hint
    found_hint = False
    for m in user_msgs:
        content = m.get("content")
        if isinstance(content, list):
            for part in content:
                if part.get("type") == "text" and "[image description:" in part.get("text", ""):
                    found_hint = True
    assert found_hint, "main provider should receive [image description: ...] hint"


@pytest.mark.asyncio
async def test_plain_text_turn_skips_image_description(tmp_path):
    """A plain text turn without images skips the image description step entirely."""
    image = FakeProvider("image")
    runtime = FakeRuntime(local_provider=None, image_provider=image)
    main = FakeProvider("main")
    loop, bus = _make_loop(tmp_path, main, runtime)

    msg = InboundMessage(
        channel="cli", sender_id="user", chat_id="direct", content="hello", metadata={}
    )
    loop.context.build_messages.return_value = [{"role": "user", "content": "hello"}]

    out = await loop._process_message(msg, session_key="test:plain")

    # Image provider should NOT be called
    assert "image" not in runtime.lookups
    assert image.calls == [], "image provider should not be called for plain text"

    # Main provider should serve the turn normally
    assert main.calls, "active provider should serve the turn"


@pytest.mark.asyncio
async def test_no_image_provider_falls_back_to_raw_images(tmp_path):
    """When no image provider is configured, messages with images pass through unchanged."""
    runtime = FakeRuntime(local_provider=None, image_provider=None)
    main = FakeProvider("main")
    loop, bus = _make_loop(tmp_path, main, runtime)

    loop._has_image_content = lambda msgs: any(
        isinstance(m.get("content"), list) and any(p.get("type") == "image_url" for p in m.get("content", []))
        for m in msgs
    )

    msg = InboundMessage(
        channel="cli",
        sender_id="user",
        chat_id="direct",
        content="What's in this image?",
        metadata={},
    )
    loop.context.build_messages.return_value = [
        {"role": "user", "content": [
            {"type": "text", "text": "What's in this image?"},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,abc123"}}
        ]}
    ]

    out = await loop._process_message(msg, session_key="test:noimage")

    # Image provider should be looked up but return None
    assert "image" in runtime.lookups
    # Main provider should handle the turn with raw images
    assert main.calls, "main provider should handle the turn with raw images"
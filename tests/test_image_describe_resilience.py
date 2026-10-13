"""Tests for image-describe resilience: progress signal + bounded timeout."""

import asyncio
from pathlib import Path

import pytest

from sarathy.agent.loop import AgentLoop


class _SlowProvider:
    """Provider whose describe call hangs until cancelled."""

    def __init__(self, delay: float = 10.0):
        self.delay = delay

    async def chat(self, messages, tools, model, temperature, max_tokens, stream):
        await asyncio.sleep(self.delay)

        class Response:
            content = "too late"

        return Response()

    def get_default_model(self):
        return "slow-model"


class _FastProvider:
    def __init__(self):
        self.seen = []

    async def chat(self, messages, tools, model, temperature, max_tokens, stream):
        self.seen = messages

        class Response:
            content = "A cat on a mat."

        return Response()

    def get_default_model(self):
        return "fast-model"


def _loop():
    loop = AgentLoop.__new__(AgentLoop)
    loop.workspace = Path("/tmp")
    return loop


@pytest.mark.asyncio
async def test_describe_emits_progress_before_calling_provider(monkeypatch):
    """A '🔍 Sending image to VLM…' progress frame is emitted before the vision call."""
    from sarathy.agent import loop as loop_mod

    monkeypatch.setattr(loop_mod, "IMAGE_DESCRIBE_TIMEOUT_S", 5.0)
    loop = _loop()
    events = []

    async def on_progress(text, *, tool_hint=False, sealed=False):
        events.append((text, tool_hint))

    messages = [
        {"role": "user", "content": "look [image: http://example.com/x.png]"}
    ]
    await loop._describe_images_with_image_provider(
        messages, _FastProvider(), on_progress=on_progress
    )
    assert any("Sending image to VLM" in t for t, _ in events)


@pytest.mark.asyncio
async def test_describe_times_out_gracefully(monkeypatch):
    """A hanging describe call is bounded and yields a '(timed out)' hint."""
    from sarathy.agent import loop as loop_mod

    monkeypatch.setattr(loop_mod, "IMAGE_DESCRIBE_TIMEOUT_S", 0.2)
    loop = _loop()
    messages = [
        {"role": "user", "content": "look [image: http://example.com/x.png]"}
    ]
    result = await loop._describe_images_with_image_provider(messages, _SlowProvider(5.0))
    text = result[-1]["content"][-1]["text"]
    assert "timed out" in text.lower()


@pytest.mark.asyncio
async def test_describe_progress_failure_does_not_break_turn(monkeypatch):
    """A raising on_progress callback must not abort the describe."""
    from sarathy.agent import loop as loop_mod

    monkeypatch.setattr(loop_mod, "IMAGE_DESCRIBE_TIMEOUT_S", 5.0)
    loop = _loop()

    async def bad_progress(text, *, tool_hint=False, sealed=False):
        raise RuntimeError("progress channel down")

    messages = [
        {"role": "user", "content": "look [image: http://example.com/x.png]"}
    ]
    result = await loop._describe_images_with_image_provider(
        messages, _FastProvider(), on_progress=bad_progress
    )
    text = result[-1]["content"][-1]["text"]
    assert "A cat on a mat." in text

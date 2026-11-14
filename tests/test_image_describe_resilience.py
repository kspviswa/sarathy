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

    async def on_progress(text, *, tool_hint=False, seal=False, phase=False):
        events.append((text, tool_hint))

    messages = [
        {"role": "user", "content": "look [image: http://example.com/x.png]"}
    ]
    await loop._describe_images_with_image_provider(
        messages, _FastProvider(), on_progress=on_progress
    )
    assert any("Sending image to VLM" in t for t, _ in events)


@pytest.mark.asyncio
async def test_describe_times_out_and_aborts(monkeypatch):
    """A hanging describe call is bounded and ABORTS the turn — no placeholder."""
    from sarathy.agent import loop as loop_mod

    monkeypatch.setattr(loop_mod, "IMAGE_DESCRIBE_TIMEOUT_S", 0.2)
    loop = _loop()
    messages = [
        {"role": "user", "content": "look [image: http://example.com/x.png]"}
    ]
    with pytest.raises(loop_mod.ImageDescriptionError) as exc:
        await loop._describe_images_with_image_provider(messages, _SlowProvider(5.0))
    assert "timed out" in str(exc.value).lower()
    assert "slow-model" in str(exc.value)


@pytest.mark.asyncio
async def test_describe_omits_max_tokens(monkeypatch):
    """The describe call must pass max_tokens=None (reasoning models bill
    reasoning tokens against the cap — a fixed budget truncates the answer)."""
    from sarathy.agent import loop as loop_mod

    monkeypatch.setattr(loop_mod, "IMAGE_DESCRIBE_TIMEOUT_S", 5.0)
    loop = _loop()
    seen = {}

    class _Capturing(_FastProvider):
        async def chat(self, messages, tools, model, temperature, max_tokens, stream):
            seen["max_tokens"] = max_tokens
            return await super().chat(messages, tools, model, temperature, max_tokens, stream)

    messages = [
        {"role": "user", "content": "look [image: http://example.com/x.png]"}
    ]
    await loop._describe_images_with_image_provider(messages, _Capturing())
    assert seen["max_tokens"] is None


@pytest.mark.asyncio
async def test_empty_content_retries_then_aborts(monkeypatch):
    """content=null (finish_reason=length) is not a description: retry once,
    then abort with the reason — never inject a placeholder."""
    from sarathy.agent import loop as loop_mod

    monkeypatch.setattr(loop_mod, "IMAGE_DESCRIBE_TIMEOUT_S", 5.0)
    loop = _loop()
    calls = {"n": 0}

    class _Truncating:
        async def chat(self, messages, tools, model, temperature, max_tokens, stream):
            calls["n"] += 1

            class Response:
                content = None
                finish_reason = "length"

            return Response()

        def get_default_model(self):
            return "reasoning-vlm"

    messages = [
        {"role": "user", "content": "look [image: http://example.com/x.png]"}
    ]
    with pytest.raises(loop_mod.ImageDescriptionError) as exc:
        await loop._describe_images_with_image_provider(messages, _Truncating())
    assert calls["n"] == 2  # one retry, then abort
    assert "truncated" in str(exc.value)


@pytest.mark.asyncio
async def test_truncated_then_good_description_succeeds(monkeypatch):
    """A truncated first attempt is recovered by the single retry."""
    from sarathy.agent import loop as loop_mod

    monkeypatch.setattr(loop_mod, "IMAGE_DESCRIBE_TIMEOUT_S", 5.0)
    loop = _loop()

    class _Recovers:
        def __init__(self):
            self.n = 0

        async def chat(self, messages, tools, model, temperature, max_tokens, stream):
            self.n += 1

            class Response:
                content = None if self.n == 1 else "A cat on a mat."
                finish_reason = "length" if self.n == 1 else "stop"

            return Response()

        def get_default_model(self):
            return "reasoning-vlm"

    messages = [
        {"role": "user", "content": "look [image: http://example.com/x.png]"}
    ]
    result = await loop._describe_images_with_image_provider(messages, _Recovers())
    assert "A cat on a mat." in result[-1]["content"][-1]["text"]


@pytest.mark.asyncio
async def test_describe_progress_failure_does_not_break_turn(monkeypatch):
    """A raising on_progress callback must not abort the describe."""
    from sarathy.agent import loop as loop_mod

    monkeypatch.setattr(loop_mod, "IMAGE_DESCRIBE_TIMEOUT_S", 5.0)
    loop = _loop()

    async def bad_progress(text, *, tool_hint=False, seal=False, phase=False):
        raise RuntimeError("progress channel down")

    messages = [
        {"role": "user", "content": "look [image: http://example.com/x.png]"}
    ]
    result = await loop._describe_images_with_image_provider(
        messages, _FastProvider(), on_progress=bad_progress
    )
    text = result[-1]["content"][-1]["text"]
    assert "A cat on a mat." in text


@pytest.mark.asyncio
async def test_provider_error_response_is_not_a_description(monkeypatch):
    """Providers swallow API failures into content with finish_reason='error'.
    That must abort the turn, never be injected as a description."""
    from sarathy.agent import loop as loop_mod

    monkeypatch.setattr(loop_mod, "IMAGE_DESCRIBE_TIMEOUT_S", 5.0)
    loop = _loop()

    class _ErrorResponse:
        async def chat(self, messages, tools, model, temperature, max_tokens, stream):
            class Response:
                content = "Error: Error code: 400 - Invalid URL format"
                finish_reason = "error"

            return Response()

        def get_default_model(self):
            return "vision-model"

    messages = [
        {"role": "user", "content": "look [image: http://example.com/x.png]"}
    ]
    with pytest.raises(loop_mod.ImageDescriptionError) as exc:
        await loop._describe_images_with_image_provider(messages, _ErrorResponse())
    assert "Invalid URL format" in str(exc.value)


@pytest.mark.asyncio
async def test_file_url_parts_are_encoded_not_passed_through(monkeypatch, tmp_path):
    """A file:// image_url part is read and base64-encoded before the vision call."""
    import base64
    import io

    from PIL import Image

    from sarathy.agent import loop as loop_mod

    monkeypatch.setattr(loop_mod, "IMAGE_DESCRIBE_TIMEOUT_S", 5.0)
    loop = _loop()
    img = tmp_path / "x.png"
    buf = io.BytesIO()
    Image.new("RGB", (32, 32), (10, 20, 30)).save(buf, format="PNG")
    img.write_bytes(buf.getvalue())

    seen = {}

    class _Capturing(_FastProvider):
        async def chat(self, messages, tools, model, temperature, max_tokens, stream):
            seen["url"] = messages[1]["content"][0]["image_url"]["url"]
            return await super().chat(messages, tools, model, temperature, max_tokens, stream)

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": f"file://{img}"}},
            ],
        }
    ]
    await loop._describe_images_with_image_provider(messages, _Capturing())
    assert seen["url"].startswith("data:image/")
    assert base64.b64decode(seen["url"].split(",", 1)[1])[:4] == b"\x89PNG"

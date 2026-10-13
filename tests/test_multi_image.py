"""Tests for multi-image handling in the describe path."""

import base64
import io
import tempfile
from pathlib import Path

import pytest
from PIL import Image

from sarathy.agent.loop import AgentLoop


def _png_data_url(size=(64, 64), color=(10, 120, 200)):
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode()


class _RecordingProvider:
    """Records each describe call's image URL and returns a distinct answer."""

    def __init__(self):
        self.calls = []

    async def chat(self, messages, tools, model, temperature, max_tokens, stream):
        content = messages[-1]["content"]
        urls = [
            p["image_url"]["url"] for p in content if p.get("type") == "image_url"
        ]
        self.calls.append(urls)

        class Response:
            content = f"description #{len(self.calls)}"

        return Response()

    def get_default_model(self):
        return "vision-model"


def _loop():
    loop = AgentLoop.__new__(AgentLoop)
    loop.workspace = Path("/tmp")
    return loop


@pytest.mark.asyncio
async def test_two_images_described_separately():
    """Two images -> two describe calls, each carrying exactly one image."""
    loop = _loop()
    provider = _RecordingProvider()
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": _png_data_url()}},
                {"type": "image_url", "image_url": {"url": _png_data_url()}},
                {"type": "text", "text": "compare these"},
            ],
        }
    ]

    result = await loop._describe_images_with_image_provider(messages, provider)

    assert len(provider.calls) == 2
    assert all(len(urls) == 1 for urls in provider.calls)

    hint = result[-1]["content"][-1]["text"]
    assert "[image 1 description: description #1]" in hint
    assert "[image 2 description: description #2]" in hint


@pytest.mark.asyncio
async def test_single_image_uses_singular_hint():
    """One image -> singular '[image description: ...]' hint."""
    loop = _loop()
    provider = _RecordingProvider()
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": _png_data_url()}},
                {"type": "text", "text": "what is this"},
            ],
        }
    ]
    result = await loop._describe_images_with_image_provider(messages, provider)
    hint = result[-1]["content"][-1]["text"]
    assert hint == "[image description: description #1]"


@pytest.mark.asyncio
async def test_per_image_progress_frames():
    """Each image emits its own 'Reading image i/N' progress frame."""
    loop = _loop()
    provider = _RecordingProvider()
    events = []

    async def on_progress(text, *, tool_hint=False, sealed=False):
        events.append(text)

    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": _png_data_url()}},
                {"type": "image_url", "image_url": {"url": _png_data_url()}},
                {"type": "image_url", "image_url": {"url": _png_data_url()}},
            ],
        }
    ]
    await loop._describe_images_with_image_provider(
        messages, provider, on_progress=on_progress
    )
    assert "🔍 Reading image 1/3…" in events
    assert "🔍 Reading image 2/3…" in events
    assert "🔍 Reading image 3/3…" in events


@pytest.mark.asyncio
async def test_text_preserved_alongside_multiple_images():
    """Original text parts survive the rewrite when multiple images are present."""
    loop = _loop()
    provider = _RecordingProvider()
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "text", "text": "runtime context"},
                {"type": "image_url", "image_url": {"url": _png_data_url()}},
                {"type": "image_url", "image_url": {"url": _png_data_url()}},
                {"type": "text", "text": "summarize"},
            ],
        }
    ]
    result = await loop._describe_images_with_image_provider(messages, provider)
    texts = [
        p.get("text") for p in result[-1]["content"] if p.get("type") == "text"
    ]
    assert "runtime context" in texts
    assert "summarize" in texts


@pytest.mark.asyncio
async def test_one_image_failing_does_not_kill_the_others():
    """A provider error on one image yields a placeholder; others still describe."""

    class FlakyProvider:
        def __init__(self):
            self.n = 0

        async def chat(self, messages, tools, model, temperature, max_tokens, stream):
            self.n += 1
            if self.n == 1:
                raise RuntimeError("boom")

            class Response:
                content = "second ok"

            return Response()

        def get_default_model(self):
            return "vision-model"

    loop = _loop()
    messages = [
        {
            "role": "user",
            "content": [
                {"type": "image_url", "image_url": {"url": _png_data_url()}},
                {"type": "image_url", "image_url": {"url": _png_data_url()}},
            ],
        }
    ]
    result = await loop._describe_images_with_image_provider(messages, FlakyProvider())
    hint = result[-1]["content"][-1]["text"]
    assert "[image 1 description: Image description unavailable]" in hint
    assert "[image 2 description: second ok]" in hint


class TestContextBuilderDownscales:
    def test_build_user_content_downscales_large_media(self):
        """The context builder downscales large media instead of raw base64."""
        from sarathy.agent.context import ContextBuilder

        with tempfile.TemporaryDirectory() as tmp:
            big = Path(tmp) / "big.png"
            buf = io.BytesIO()
            Image.new("RGB", (4000, 3000), (5, 5, 5)).save(buf, format="PNG")
            big.write_bytes(buf.getvalue())

            ctx = ContextBuilder.__new__(ContextBuilder)
            content = ctx._build_user_content("hello", [str(big)])
            assert isinstance(content, list)
            url = content[0]["image_url"]["url"]
            decoded = base64.b64decode(url.split(",", 1)[1])
            assert max(Image.open(io.BytesIO(decoded)).size) <= 1568

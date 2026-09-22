"""Regression tests for streaming usage capture and session_id transport.

Guards two bugs found in review of job 97:

1. ``_stream_chat`` crashed with IndexError on the usage-only final chunk
   (``choices: []``) emitted when ``stream_options.include_usage`` is set,
   which turned every streamed turn into an error response.
2. ``session_id`` was passed as a top-level kwarg to the OpenAI SDK, which has
   no catch-all ``**kwargs`` and raises TypeError for unknown arguments. It must
   travel in ``extra_body`` instead.
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

from sarathy.providers.custom_provider import CustomProvider


class MockUsage:
    def __init__(
        self,
        prompt_tokens=0,
        completion_tokens=0,
        total_tokens=0,
        prompt_tokens_details=None,
        cache_discount=None,
        cost=None,
    ):
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.total_tokens = total_tokens
        self.prompt_tokens_details = prompt_tokens_details
        self.cache_discount = cache_discount
        self.cost = cost


class MockDelta:
    def __init__(self, content=None, reasoning_content=None, tool_calls=None):
        self.content = content
        self.reasoning = None
        self.thinking = None
        self.reasoning_content = reasoning_content
        self.tool_calls = tool_calls


class MockStreamChoice:
    def __init__(self, delta, finish_reason=None):
        self.delta = delta
        self.finish_reason = finish_reason


class MockChunk:
    def __init__(self, choices=None, usage=None):
        self.choices = choices if choices is not None else []
        self.usage = usage


def _make_response_usage():
    return MockUsage(prompt_tokens=1000, completion_tokens=2, total_tokens=1002)


async def test_stream_chat_survives_usage_only_final_chunk():
    """A trailing chunk with empty choices must not break the stream."""
    provider = CustomProvider(api_key="test", api_base="https://openrouter.ai/api/v1")

    async def gen():
        yield MockChunk(choices=[MockStreamChoice(MockDelta(content="Hello"))])
        yield MockChunk(
            choices=[MockStreamChoice(MockDelta(content=" world"), finish_reason="stop")]
        )
        # The usage-only chunk: no choices, usage present.
        yield MockChunk(
            choices=[],
            usage=MockUsage(
                prompt_tokens=1000,
                completion_tokens=2,
                total_tokens=1002,
                prompt_tokens_details={"cached_tokens": 800, "cache_write_tokens": 100},
            ),
        )

    provider._client.chat.completions.create = AsyncMock(return_value=gen())

    resp = await provider.chat(
        messages=[{"role": "user", "content": "hi"}],
        stream=True,
        on_progress=lambda _c: None,
        session_id="telegram:1",
    )

    assert resp.finish_reason == "stop", resp
    assert resp.content == "Hello world"
    assert "Error" not in (resp.content or "")
    assert resp.usage["prompt_tokens"] == 1000
    assert resp.usage["cached_tokens"] == 800
    assert resp.usage["cache_write_tokens"] == 100


async def test_stream_chat_returns_usage_when_no_usage_chunk():
    """Streams without a usage chunk still succeed with empty usage."""
    provider = CustomProvider(api_key="test", api_base="https://openrouter.ai/api/v1")

    async def gen():
        yield MockChunk(choices=[MockStreamChoice(MockDelta(content="ok"), finish_reason="stop")])

    provider._client.chat.completions.create = AsyncMock(return_value=gen())

    resp = await provider.chat(
        messages=[{"role": "user", "content": "hi"}],
        stream=True,
        on_progress=lambda _c: None,
    )

    assert resp.content == "ok"
    assert resp.usage == {}


async def test_session_id_travels_in_extra_body_not_top_level():
    """session_id must be in extra_body; top-level would raise TypeError."""
    provider = CustomProvider(api_key="test", api_base="https://openrouter.ai/api/v1")
    captured: dict = {}

    async def fake_create(**kwargs):
        captured.update(kwargs)
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = "ok"
        response.choices[0].message.tool_calls = []
        response.choices[0].message.reasoning_content = None
        response.choices[0].message.thinking_blocks = None
        response.choices[0].finish_reason = "stop"
        response.usage = _make_response_usage()
        return response

    provider._client.chat.completions.create = fake_create

    await provider.chat(
        messages=[{"role": "user", "content": "hi"}],
        session_id="telegram:1",
    )

    assert "session_id" not in captured, "session_id must not be a top-level kwarg"
    assert captured.get("extra_body", {}).get("session_id") == "telegram:1"


async def test_session_id_omitted_for_non_openrouter_base():
    """Non-OpenRouter endpoints must not receive extra_body.session_id."""
    provider = CustomProvider(api_key="test", api_base="http://localhost:8000/v1")
    captured: dict = {}

    async def fake_create(**kwargs):
        captured.update(kwargs)
        response = MagicMock()
        response.choices = [MagicMock()]
        response.choices[0].message.content = "ok"
        response.choices[0].message.tool_calls = []
        response.choices[0].message.reasoning_content = None
        response.choices[0].message.thinking_blocks = None
        response.choices[0].finish_reason = "stop"
        response.usage = _make_response_usage()
        return response

    provider._client.chat.completions.create = fake_create

    await provider.chat(
        messages=[{"role": "user", "content": "hi"}],
        session_id="telegram:1",
    )

    assert "extra_body" not in captured
    assert "session_id" not in captured


def test_usage_from_captures_cost_attribute_style():
    """Test _usage_from captures cost from attribute-style usage object."""
    usage_obj = MockUsage(
        prompt_tokens=1000,
        completion_tokens=500,
        total_tokens=1500,
        cost=0.0123,
    )

    result = CustomProvider._usage_from(usage_obj)

    assert "cost" in result
    assert result["cost"] == 0.0123
    assert result["prompt_tokens"] == 1000
    assert result["completion_tokens"] == 500
    assert result["total_tokens"] == 1500


def test_usage_from_captures_cost_dict_style():
    """Test _usage_from captures cost from dict-style usage object."""
    usage_dict = {
        "prompt_tokens": 1000,
        "completion_tokens": 500,
        "total_tokens": 1500,
        "cost": 0.0123,
    }

    result = CustomProvider._usage_from(usage_dict)

    assert "cost" in result
    assert result["cost"] == 0.0123
    assert result["prompt_tokens"] == 1000
    assert result["completion_tokens"] == 500
    assert result["total_tokens"] == 1500


def test_usage_from_no_cost_when_absent():
    """Test _usage_from does not include cost key when absent."""
    usage_obj = MockUsage(
        prompt_tokens=1000,
        completion_tokens=500,
        total_tokens=1500,
    )

    result = CustomProvider._usage_from(usage_obj)

    assert "cost" not in result
    assert result["prompt_tokens"] == 1000


def test_usage_from_cost_none_not_included():
    """Test _usage_from does not include cost when explicitly None."""
    usage_obj = MockUsage(
        prompt_tokens=1000,
        completion_tokens=500,
        total_tokens=1500,
        cost=None,
    )

    result = CustomProvider._usage_from(usage_obj)

    assert "cost" not in result


def test_usage_from_dict_cost_none_not_included():
    """Test _usage_from does not include cost when dict has None cost."""
    usage_dict = {
        "prompt_tokens": 1000,
        "completion_tokens": 500,
        "total_tokens": 1500,
        "cost": None,
    }

    result = CustomProvider._usage_from(usage_dict)

    assert "cost" not in result
"""Tests for provider cache usage extraction."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from sarathy.providers.custom_provider import CustomProvider
from sarathy.providers.litellm_provider import LiteLLMProvider


class MockUsage:
    def __init__(
        self,
        prompt_tokens=0,
        completion_tokens=0,
        total_tokens=0,
        prompt_tokens_details=None,
        cache_discount=None,
    ):
        self.prompt_tokens = prompt_tokens
        self.completion_tokens = completion_tokens
        self.total_tokens = total_tokens
        self.prompt_tokens_details = prompt_tokens_details
        self.cache_discount = cache_discount


class MockChoice:
    def __init__(self, message, finish_reason="stop"):
        self.message = message
        self.finish_reason = finish_reason


class MockMessage:
    def __init__(
        self,
        content="test",
        tool_calls=None,
        reasoning_content=None,
        thinking_blocks=None,
    ):
        self.content = content
        self.tool_calls = tool_calls or []
        self.reasoning_content = reasoning_content
        self.thinking_blocks = thinking_blocks


class MockToolCall:
    def __init__(self, id="tc1", name="test_tool", arguments="{}"):
        self.id = id
        self.function = MagicMock()
        self.function.name = name
        self.function.arguments = arguments


def test_custom_provider_parse_attribute_style_cached_tokens():
    """Test _parse extracts cached_tokens from attribute-style prompt_tokens_details."""
    provider = CustomProvider(api_key="test", api_base="https://openrouter.ai/api/v1")

    details = MagicMock()
    details.cached_tokens = 150
    details.cache_write_tokens = 50

    usage = MockUsage(
        prompt_tokens=1000,
        completion_tokens=200,
        total_tokens=1200,
        prompt_tokens_details=details,
    )

    message = MockMessage()
    choice = MockChoice(message)
    response = MagicMock()
    response.choices = [choice]
    response.usage = usage

    result = provider._parse(response)

    assert result.usage["cached_tokens"] == 150
    assert result.usage["cache_write_tokens"] == 50
    assert result.usage["prompt_tokens"] == 1000
    assert result.usage["completion_tokens"] == 200
    assert result.usage["total_tokens"] == 1200


def test_custom_provider_parse_dict_style_cached_tokens():
    """Test _parse extracts cached_tokens from dict-style prompt_tokens_details."""
    provider = CustomProvider(api_key="test", api_base="https://openrouter.ai/api/v1")

    details = {"cached_tokens": 200, "cache_write_tokens": 75}

    usage = MockUsage(
        prompt_tokens=1000,
        completion_tokens=200,
        total_tokens=1200,
        prompt_tokens_details=details,
    )

    message = MockMessage()
    choice = MockChoice(message)
    response = MagicMock()
    response.choices = [choice]
    response.usage = usage

    result = provider._parse(response)

    assert result.usage["cached_tokens"] == 200
    assert result.usage["cache_write_tokens"] == 75


def test_custom_provider_parse_no_cached_tokens_omits_key():
    """Test _parse omits cached_tokens key when not present."""
    provider = CustomProvider(api_key="test", api_base="https://openrouter.ai/api/v1")

    usage = MockUsage(
        prompt_tokens=1000,
        completion_tokens=200,
        total_tokens=1200,
        prompt_tokens_details=None,
    )

    message = MockMessage()
    choice = MockChoice(message)
    response = MagicMock()
    response.choices = [choice]
    response.usage = usage

    result = provider._parse(response)

    assert "cached_tokens" not in result.usage
    assert "cache_write_tokens" not in result.usage
    assert result.usage["prompt_tokens"] == 1000


def test_custom_provider_parse_cache_discount_from_usage():
    """Test _parse extracts cache_discount from usage object."""
    provider = CustomProvider(api_key="test", api_base="https://openrouter.ai/api/v1")

    usage = MockUsage(
        prompt_tokens=1000,
        completion_tokens=200,
        total_tokens=1200,
        cache_discount=0.15,
    )

    message = MockMessage()
    choice = MockChoice(message)
    response = MagicMock()
    response.choices = [choice]
    response.usage = usage

    result = provider._parse(response)

    assert result.usage["cache_discount"] == 0.15


def test_custom_provider_parse_never_raises_on_bad_usage():
    """Test _parse never raises even with malformed usage."""
    provider = CustomProvider(api_key="test", api_base="https://openrouter.ai/api/v1")

    # Usage with broken prompt_tokens_details
    usage = MockUsage(prompt_tokens=100, completion_tokens=50, total_tokens=150)
    usage.prompt_tokens_details = "not-an-object"  # type: ignore

    message = MockMessage()
    choice = MockChoice(message)
    response = MagicMock()
    response.choices = [choice]
    response.usage = usage

    # Should not raise
    result = provider._parse(response)
    assert result.usage["prompt_tokens"] == 100


def test_litellm_provider_parse_attribute_style_cached_tokens():
    """Test LiteLLMProvider._parse_response extracts cached_tokens from attribute-style."""
    provider = LiteLLMProvider(api_key="test", default_model="test-model")

    details = MagicMock()
    details.cached_tokens = 120
    details.cache_write_tokens = 30

    usage = MockUsage(
        prompt_tokens=800,
        completion_tokens=150,
        total_tokens=950,
        prompt_tokens_details=details,
        cache_discount=0.05,
    )

    message = MockMessage()
    choice = MockChoice(message)
    response = MagicMock()
    response.choices = [choice]
    response.usage = usage

    result = provider._parse_response(response)

    assert result.usage["cached_tokens"] == 120
    assert result.usage["cache_write_tokens"] == 30
    assert result.usage["cache_discount"] == 0.05


def test_litellm_provider_parse_dict_style_cached_tokens():
    """Test LiteLLMProvider._parse_response extracts cached_tokens from dict-style."""
    provider = LiteLLMProvider(api_key="test", default_model="test-model")

    details = {"cached_tokens": 180, "cache_write_tokens": 40}

    usage = MockUsage(
        prompt_tokens=800,
        completion_tokens=150,
        total_tokens=950,
        prompt_tokens_details=details,
    )

    message = MockMessage()
    choice = MockChoice(message)
    response = MagicMock()
    response.choices = [choice]
    response.usage = usage

    result = provider._parse_response(response)

    assert result.usage["cached_tokens"] == 180
    assert result.usage["cache_write_tokens"] == 40


def test_litellm_provider_parse_no_cached_tokens_omits_key():
    """Test LiteLLMProvider._parse_response omits key when absent."""
    provider = LiteLLMProvider(api_key="test", default_model="test-model")

    usage = MockUsage(prompt_tokens=800, completion_tokens=150, total_tokens=950)

    message = MockMessage()
    choice = MockChoice(message)
    response = MagicMock()
    response.choices = [choice]
    response.usage = usage

    result = provider._parse_response(response)

    assert "cached_tokens" not in result.usage
    assert "cache_write_tokens" not in result.usage
    assert result.usage["prompt_tokens"] == 800


def test_litellm_provider_parse_never_raises():
    """Test LiteLLMProvider._parse_response never raises on malformed usage."""
    provider = LiteLLMProvider(api_key="test", default_model="test-model")

    usage = MockUsage(prompt_tokens=100, completion_tokens=50, total_tokens=150)
    usage.prompt_tokens_details = "not-an-object"  # type: ignore

    message = MockMessage()
    choice = MockChoice(message)
    response = MagicMock()
    response.choices = [choice]
    response.usage = usage

    # Should not raise
    result = provider._parse_response(response)
    assert result.usage["prompt_tokens"] == 100
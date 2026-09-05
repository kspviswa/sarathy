"""Tests for the token estimation helpers (job 68 §3B)."""

from __future__ import annotations

import copy

from sarathy.utils.tokens import estimate_messages_tokens, estimate_tokens


class TestEstimateTokens:
    def test_returns_positive_int(self) -> None:
        assert estimate_tokens("hello world, this is a sentence.") > 0
        assert isinstance(estimate_tokens("x" * 10), int)

    def test_empty_string_is_zero(self) -> None:
        assert estimate_tokens("") == 0

    def test_fallback_for_unknown_model(self) -> None:
        # litellm has no tokenizer for this model: char-based fallback len//4.
        assert estimate_tokens("x" * 100, model="nonexistent/model") == 25

    def test_never_raises_for_binary_content(self) -> None:
        assert estimate_tokens("x" * 10, model=None) >= 1


class TestEstimateMessagesTokens:
    def test_string_list_toolcalls_and_reasoning(self) -> None:
        messages = [
            {"role": "user", "content": "hello there"},
            {
                "role": "assistant",
                "content": "I'll look that up",
                "tool_calls": [
                    {
                        "id": "call_1",
                        "type": "function",
                        "function": {
                            "name": "read_file",
                            "arguments": '{"path": "/tmp/x.md"}',
                        },
                    }
                ],
            },
            {"role": "tool", "tool_call_id": "call_1", "content": "the file contents"},
            {
                "role": "assistant",
                "content": [{"type": "text", "text": "multimodal answer"}],
                "reasoning_content": "thinking deeply about the answer",
            },
            {"role": "user", "content": None},
        ]
        total = estimate_messages_tokens(messages, model="nonexistent/model")
        assert isinstance(total, int)
        assert total > 0
        # At least the plain text parts each contribute their char-based estimate.
        assert total >= len("hello there") // 4

    def test_empty_messages(self) -> None:
        assert estimate_messages_tokens([], model="nonexistent/model") == 0

    def test_does_not_mutate_messages(self) -> None:
        messages: list[dict] = [
            {"role": "user", "content": "a" * 40},
            {
                "role": "assistant",
                "content": "b" * 40,
                "tool_calls": [{"id": "c", "type": "function", "function": {"name": "f"}}],
                "reasoning_content": "d" * 40,
            },
        ]
        before = copy.deepcopy(messages)
        estimate_messages_tokens(messages, model="nonexistent/model")
        assert messages == before

    def test_matches_sum_of_parts(self) -> None:
        messages = [
            {"role": "user", "content": "a" * 40},
            {"role": "assistant", "content": "b" * 40},
        ]
        parts = estimate_tokens("a" * 40, model="nonexistent/model") + estimate_tokens(
            "b" * 40, model="nonexistent/model"
        )
        assert estimate_messages_tokens(messages, model="nonexistent/model") == parts

"""Best-effort token estimation helpers.

These are deterministic, offline, and never raise: litellm's tokenizer is used
when available, otherwise a character-based fallback keeps the prompt lean.
"""

from __future__ import annotations

import json
from functools import lru_cache
from typing import Any


@lru_cache(maxsize=64)
def _token_encoder(model: str | None) -> Any:
    """Return a cached litellm tokenizer for ``model``.

    Raises on any failure (unknown model, missing tokenizer, old litellm) —
    callers fall back to a char-based estimate.
    """
    from litellm.utils import get_tokenizer

    return get_tokenizer(model=model)


def estimate_tokens(text: str, model: str | None = None) -> int:
    """Estimate the number of tokens in ``text``. Never raises.

    Uses ``litellm.utils.get_tokenizer`` when available; on ANY exception
    falls back to ``max(1, len(text) // 4)``.
    """
    if not text:
        return 0
    try:
        return len(_token_encoder(model).encode(text))
    except Exception:
        return max(1, len(text) // 4)


def _content_tokens(content: Any, model: str | None) -> int:
    """Token estimate for a message content field (str or multimodal list)."""
    if content is None:
        return 0
    if isinstance(content, str):
        return estimate_tokens(content, model)
    if isinstance(content, list):
        return sum(_content_tokens(part, model) for part in content)
    if isinstance(content, dict):
        return estimate_tokens(json.dumps(content, ensure_ascii=False), model)
    return estimate_tokens(str(content), model)


def estimate_messages_tokens(messages: list[dict], model: str | None = None) -> int:
    """Estimate tokens for a message list. Never raises.

    Counts string/list ``content``, ``tool_calls`` (JSON), and
    ``reasoning_content`` for each message.
    """
    total = 0
    for message in messages:
        total += _content_tokens(message.get("content"), model)
        tool_calls = message.get("tool_calls")
        if tool_calls:
            total += estimate_tokens(json.dumps(tool_calls, ensure_ascii=False), model)
        reasoning = message.get("reasoning_content")
        if reasoning:
            total += estimate_tokens(reasoning, model)
    return total

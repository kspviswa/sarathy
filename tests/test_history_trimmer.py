"""Tests for token-budget history trimming (job 68 §3C).

The estimator falls back to ``len(content) // 4`` (no litellm tokenizer for the
test models), so expected token counts are exact and deterministic.
"""

from __future__ import annotations

import copy

from sarathy.agent.context import trim_history
from sarathy.utils.tokens import estimate_messages_tokens

MODEL = "nonexistent/model"
LONG = 300  # 75 tokens each
TRUNCATED = 212  # 200 + 12-char suffix -> 53 tokens after truncation
OMITTED = "[tool result omitted]"


def _tool(tool_call_id: str, content: str) -> dict:
    return {"role": "tool", "tool_call_id": tool_call_id, "content": content}


def _user(content: str) -> dict:
    return {"role": "user", "content": content}


def _assistant(content: str) -> dict:
    return {"role": "assistant", "content": content}


def test_keeps_newest_recent_verbatim_and_trims_old() -> None:
    history = [
        _tool("t0", "T" * LONG),
        _tool("t1", "T" * LONG),
        _user("U" * LONG),
        _assistant("A" * LONG),
        _user("U" * LONG),
        _assistant("A" * LONG),
        _user("tail-1"),
        _assistant("tail-2"),
        _user("tail-3"),
        _assistant("tail-4"),
        _user("tail-5"),
        _assistant("tail-6"),
        _user("tail-7"),
        _assistant("tail-8"),
    ]
    tail = history[-8:]
    trimmed = trim_history(history, budget_tokens=250, model=MODEL)

    assert trimmed[0]["content"] == OMITTED
    assert trimmed[1]["content"] == OMITTED
    assert estimate_messages_tokens(trimmed, MODEL) <= 250
    assert trimmed[-8:] == [dict(m) for m in tail]


def test_sheds_old_tool_results_before_truncating_text() -> None:
    history = [
        _tool("t0", "T" * LONG),
        _tool("t1", "T" * LONG),
        _user("U" * LONG),
        _assistant("A" * LONG),
        _user("U" * LONG),
        _assistant("A" * LONG),
        _user("recent-1"),
        _assistant("recent-2"),
        _user("recent-3"),
    ]
    trimmed = trim_history(history, budget_tokens=350, keep_recent=3, model=MODEL)

    # Tools shed first (75 -> ~5 tokens each) to get under budget...
    assert trimmed[0]["content"] == OMITTED
    assert trimmed[1]["content"] == OMITTED
    # ...without yet touching the long text messages.
    assert len(trimmed[2]["content"]) == LONG
    assert len(trimmed[3]["content"]) == LONG
    assert len(trimmed[4]["content"]) == LONG
    assert len(trimmed[5]["content"]) == LONG


def test_truncates_older_text_to_200_chars() -> None:
    history = [
        _user("U" * LONG),
        _assistant("A" * LONG),
        _tool("t0", "T" * LONG),
        _user("U" * LONG),
        _assistant("A" * LONG),
        _user("recent-1"),
        _assistant("recent-2"),
        _user("recent-3"),
        _assistant("recent-4"),
    ]
    trimmed = trim_history(history, budget_tokens=200, keep_recent=4, model=MODEL)

    old = trimmed[:-4]
    assert any(o["content"].endswith("…[truncated]") for o in old)
    for original, current in zip(history, trimmed):
        if original.get("role") == "tool":
            continue
        if isinstance(original["content"], str) and len(original["content"]) > 200:
            assert current["content"].endswith("…[truncated]")
    assert trimmed[-4:] == [dict(m) for m in history[-4:]]


def test_never_mutates_input_history() -> None:
    history = [
        _tool("t0", "T" * LONG),
        _user("U" * LONG),
        _assistant("A" * LONG),
        _user("recent-1"),
        _assistant("recent-2"),
        _user("recent-3"),
    ]
    original = copy.deepcopy(history)
    trim_history(history, budget_tokens=150, model=MODEL)
    assert history == original


def test_always_keeps_most_recent_user_message() -> None:
    history = [
        _user("OLD USER " * 30),
        _assistant("OLD ASSIST " * 30),
        _user("MID USER " * 30),
        _assistant("MID ASSIST " * 30),
        _assistant("AFTER USER 1 " * 30),
        _assistant("AFTER USER 2 " * 30),
    ]
    trimmed = trim_history(history, budget_tokens=150, keep_recent=2, model=MODEL)

    # The most recent user message (index 2) is NOT in the keep_recent window
    # (only indices 4-5 are) but must still be kept fully intact.
    assert trimmed[2]["content"] == history[2]["content"]
    assert len(trimmed[0]["content"]) == TRUNCATED
    assert len(trimmed[1]["content"]) == TRUNCATED


def test_back_to_back_trimming_is_stable() -> None:
    history = [
        _tool("t0", "T" * LONG),
        _tool("t1", "T" * LONG),
        _user("U" * LONG),
        _assistant("A" * LONG),
        _user("U" * LONG),
        _assistant("A" * LONG),
        _user("tail-1"),
        _assistant("tail-2"),
        _user("tail-3"),
        _assistant("tail-4"),
    ]
    first = trim_history(history, budget_tokens=250, model=MODEL)
    second = trim_history(first, budget_tokens=250, model=MODEL)
    assert first == second

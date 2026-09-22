"""Tests for usage footer formatting."""

import os
import tempfile
from pathlib import Path

import pytest

from sarathy.usage.footer import format_usage_footer
from sarathy.usage.store import UsageStore, get_usage_store, reset_usage_store


@pytest.fixture
def temp_db():
    """Create a temporary database for testing."""
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = Path(f.name)
    os.environ["SARATHY_USAGE_DB"] = str(db_path)
    reset_usage_store()
    yield db_path
    reset_usage_store()
    os.environ.pop("SARATHY_USAGE_DB", None)
    if db_path.exists():
        db_path.unlink()


def test_footer_compact_format_with_real_cost(temp_db):
    """Test footer renders compact format with real cost."""
    store = UsageStore(temp_db)
    session_key = "test:session1"

    # Record some events with cost
    store.record({
        "ts": "2026-01-01T00:00:00Z",
        "session_key": session_key,
        "model": "test-model",
        "provider": "openrouter",
        "prompt_tokens": 100,
        "completion_tokens": 50,
        "total_tokens": 150,
        "cost": 0.00123,
    })
    store.record({
        "ts": "2026-01-01T00:01:00Z",
        "session_key": session_key,
        "model": "test-model",
        "provider": "openrouter",
        "prompt_tokens": 200,
        "completion_tokens": 100,
        "total_tokens": 300,
        "cost": 0.00234,
    })

    stats = {"total_tokens": 450, "total_time": 10.0, "tokens_per_sec": 45.0}
    footer = format_usage_footer(stats, session_key)

    assert footer is not None
    assert "⚡ 450 tkn @ 45.0 tps" in footer
    assert "💵 $0.0036 session" in footer  # 0.00123 + 0.00234 = 0.00357 -> 0.0036
    assert " · " in footer


def test_footer_placeholder_cost_when_no_cost_data(temp_db):
    """Test footer renders placeholder when no cost data exists."""
    store = UsageStore(temp_db)
    session_key = "test:session2"

    # Record events WITHOUT cost
    store.record({
        "ts": "2026-01-01T00:00:00Z",
        "session_key": session_key,
        "model": "test-model",
        "provider": "local",
        "prompt_tokens": 100,
        "completion_tokens": 50,
        "total_tokens": 150,
    })

    stats = {"total_tokens": 150, "total_time": 5.0, "tokens_per_sec": 30.0}
    footer = format_usage_footer(stats, session_key)

    assert footer is not None
    assert "⚡ 150 tkn @ 30.0 tps" in footer
    assert "💵 $xx.xx session" in footer  # Placeholder
    assert " · " in footer


def test_footer_no_stats_only_cost(temp_db):
    """Test footer renders only cost line when no stats but session_key exists."""
    store = UsageStore(temp_db)
    session_key = "test:session3"

    store.record({
        "ts": "2026-01-01T00:00:00Z",
        "session_key": session_key,
        "model": "test-model",
        "provider": "openrouter",
        "prompt_tokens": 100,
        "completion_tokens": 50,
        "total_tokens": 150,
        "cost": 0.0050,
    })

    footer = format_usage_footer(None, session_key)

    assert footer is not None
    assert "⚡" not in footer  # No stats line
    assert "💵 $0.0050 session" in footer
    assert " · " not in footer  # Only one part, no join needed


def test_footer_none_when_nothing_to_render():
    """Test footer returns None when no stats and no session_key."""
    footer = format_usage_footer(None, None)
    assert footer is None


def test_footer_none_when_no_tokens_or_tps():
    """Test footer returns None when stats has zero tokens/tps and no session_key."""
    stats = {"total_tokens": 0, "total_time": 0.0, "tokens_per_sec": 0.0}
    footer = format_usage_footer(stats, None)
    assert footer is None


def test_footer_with_zero_tps_shows_placeholder_cost(temp_db):
    """Test footer shows cost placeholder when tps is zero but session has cost."""
    store = UsageStore(temp_db)
    session_key = "test:session4"

    store.record({
        "ts": "2026-01-01T00:00:00Z",
        "session_key": session_key,
        "model": "test-model",
        "provider": "openrouter",
        "prompt_tokens": 100,
        "completion_tokens": 50,
        "total_tokens": 150,
        "cost": 0.0010,
    })

    stats = {"total_tokens": 0, "total_time": 0.0, "tokens_per_sec": 0.0}
    footer = format_usage_footer(stats, session_key)

    assert footer is not None
    assert "⚡" not in footer
    assert "💵 $0.0010 session" in footer


def test_footer_store_failure_returns_placeholder(temp_db, monkeypatch):
    """Test footer handles store failure gracefully (returns placeholder)."""
    import sarathy.usage.footer as footer_module

    def failing_session_cost(*args, **kwargs):
        raise Exception("DB error")

    monkeypatch.setattr(footer_module.get_usage_store(), "session_cost", failing_session_cost)

    stats = {"total_tokens": 100, "total_time": 2.0, "tokens_per_sec": 50.0}
    footer = format_usage_footer(stats, "test:session")

    assert footer is not None
    assert "⚡ 100 tkn @ 50.0 tps" in footer
    assert "💵 $xx.xx session" in footer  # Placeholder on error


def test_footer_cost_none_when_no_cost_rows(temp_db):
    """Test footer shows placeholder when session_cost returns None."""
    # Fresh DB, no records for this session
    stats = {"total_tokens": 100, "total_time": 2.0, "tokens_per_sec": 50.0}
    footer = format_usage_footer(stats, "nonexistent:session")

    assert footer is not None
    assert "⚡ 100 tkn @ 50.0 tps" in footer
    assert "💵 $xx.xx session" in footer
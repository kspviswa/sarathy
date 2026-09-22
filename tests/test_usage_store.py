"""Tests for usage store."""

import os
import tempfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest

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


def test_record_and_summary_roundtrip(temp_db):
    """Test record -> summary round-trip with correct totals and cache_hit_pct."""
    store = UsageStore(temp_db)

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    # Record two events
    store.record(
        {
            "ts": now,
            "session_key": "test:1",
            "channel": "telegram",
            "model": "model-a",
            "provider": "openrouter",
            "prompt_tokens": 1000,
            "cached_tokens": 300,
            "completion_tokens": 200,
            "total_tokens": 1200,
            "cache_discount": 0.1,
            "duration_ms": 500,
            "finish_reason": "stop",
        }
    )
    store.record(
        {
            "ts": now,
            "session_key": "test:2",
            "channel": "dashboard",
            "model": "model-a",
            "provider": "openrouter",
            "prompt_tokens": 500,
            "cached_tokens": 100,
            "completion_tokens": 150,
            "total_tokens": 650,
            "duration_ms": 300,
            "finish_reason": "stop",
        }
    )

    summary = store.summary(days=7)

    assert summary["available"] is True
    assert summary["window_days"] == 7
    assert summary["totals"]["requests"] == 2
    assert summary["totals"]["prompt_tokens"] == 1500
    assert summary["totals"]["cached_tokens"] == 400
    assert summary["totals"]["completion_tokens"] == 350
    assert summary["totals"]["total_tokens"] == 1850
    # cache_hit_pct = 100 * 400 / 1500 = 26.666... -> 26.7
    assert summary["totals"]["cache_hit_pct"] == 26.7


def test_cache_hit_pct_zero_when_no_prompt_tokens(temp_db):
    """Test cache_hit_pct is 0.0 when prompt_tokens == 0 (no ZeroDivisionError)."""
    store = UsageStore(temp_db)

    store.record(
        {
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "model": "model-a",
            "provider": "openrouter",
            "prompt_tokens": 0,
            "cached_tokens": 0,
            "completion_tokens": 100,
            "total_tokens": 100,
        }
    )

    summary = store.summary(days=7)
    assert summary["totals"]["cache_hit_pct"] == 0.0


def test_by_model_groups_correctly(temp_db):
    """Test by_model groups correctly across two models."""
    store = UsageStore(temp_db)

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")

    store.record(
        {
            "ts": now,
            "model": "model-a",
            "provider": "openrouter",
            "prompt_tokens": 1000,
            "cached_tokens": 300,
            "completion_tokens": 200,
        }
    )
    store.record(
        {
            "ts": now,
            "model": "model-b",
            "provider": "local",
            "prompt_tokens": 500,
            "cached_tokens": 0,
            "completion_tokens": 100,
        }
    )
    store.record(
        {
            "ts": now,
            "model": "model-a",
            "provider": "openrouter",
            "prompt_tokens": 200,
            "cached_tokens": 50,
            "completion_tokens": 50,
        }
    )

    summary = store.summary(days=7)

    assert len(summary["by_model"]) == 2
    # model-a should be first (more requests)
    assert summary["by_model"][0]["model"] == "model-a"
    assert summary["by_model"][0]["requests"] == 2
    assert summary["by_model"][0]["prompt_tokens"] == 1200
    assert summary["by_model"][0]["cached_tokens"] == 350
    assert summary["by_model"][0]["cache_hit_pct"] == round(100 * 350 / 1200, 1)

    assert summary["by_model"][1]["model"] == "model-b"
    assert summary["by_model"][1]["requests"] == 1
    assert summary["by_model"][1]["cache_hit_pct"] == 0.0


def test_summary_model_filter(temp_db):
    """Test summary(model=...) restricts totals/timeseries but keeps by_model full."""
    store = UsageStore(temp_db)

    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    store.record(
        {"ts": now, "model": "model-a", "provider": "openrouter",
         "prompt_tokens": 1000, "cached_tokens": 300, "completion_tokens": 200, "total_tokens": 1200}
    )
    store.record(
        {"ts": now, "model": "model-b", "provider": "local",
         "prompt_tokens": 500, "cached_tokens": 100, "completion_tokens": 100, "total_tokens": 600}
    )

    # Unfiltered
    all_summary = store.summary(days=7)
    assert all_summary["model"] is None
    assert all_summary["totals"]["prompt_tokens"] == 1500
    assert len(all_summary["by_model"]) == 2

    # Filtered to model-a
    filtered = store.summary(days=7, model="model-a")
    assert filtered["model"] == "model-a"
    assert filtered["totals"]["requests"] == 1
    assert filtered["totals"]["prompt_tokens"] == 1000
    assert filtered["totals"]["cached_tokens"] == 300
    assert filtered["totals"]["total_tokens"] == 1200
    # by_model stays complete so the UI can offer every filter option
    assert len(filtered["by_model"]) == 2
    # timeseries is filtered too
    assert len(filtered["timeseries"]) == 1
    assert filtered["timeseries"][0]["prompt_tokens"] == 1000

    # Unknown model -> zeroed totals, still available (window has data)
    unknown = store.summary(days=7, model="nope")
    assert unknown["available"] is True
    assert unknown["totals"]["requests"] == 0
    assert unknown["timeseries"] == []


def test_timeseries_buckets(temp_db):
    """Test timeseries buckets correctly."""
    store = UsageStore(temp_db)

    # Anchor to "now" so the 1-day window always contains the rows (the old
    # hardcoded 2026-09-21 stamps aged out of the window and broke the test).
    base = datetime.now(timezone.utc).replace(minute=0, second=0, microsecond=0)
    first_hour = base - timedelta(hours=2)
    second_hour = base - timedelta(hours=1)

    def _iso(dt: datetime) -> str:
        return dt.isoformat().replace("+00:00", "Z")

    ts1 = _iso(first_hour + timedelta(minutes=15))
    ts2 = _iso(first_hour + timedelta(minutes=45))  # Same hour as ts1
    ts3 = _iso(second_hour + timedelta(minutes=30))  # Next hour
    first_bucket = first_hour.strftime("%Y-%m-%dT%H:00:00Z")
    second_bucket = second_hour.strftime("%Y-%m-%dT%H:00:00Z")

    store.record(
        {"ts": ts1, "model": "model-a", "prompt_tokens": 100, "cached_tokens": 20, "completion_tokens": 50}
    )
    store.record(
        {"ts": ts2, "model": "model-a", "prompt_tokens": 200, "cached_tokens": 30, "completion_tokens": 50}
    )
    store.record(
        {"ts": ts3, "model": "model-a", "prompt_tokens": 150, "cached_tokens": 10, "completion_tokens": 50}
    )

    # 1 day window -> hourly buckets
    summary = store.summary(days=1)
    assert len(summary["timeseries"]) == 2

    # First bucket should have combined values from ts1 + ts2
    bucket1 = summary["timeseries"][0]
    assert bucket1["ts"] == first_bucket
    assert bucket1["prompt_tokens"] == 300
    assert bucket1["cached_tokens"] == 50
    assert bucket1["cache_hit_pct"] == round(100 * 50 / 300, 1)

    # Second bucket
    bucket2 = summary["timeseries"][1]
    assert bucket2["ts"] == second_bucket
    assert bucket2["prompt_tokens"] == 150


def test_empty_db_returns_available_false(temp_db):
    """Test empty DB returns available: false."""
    store = UsageStore(temp_db)
    summary = store.summary(days=7)

    assert summary["available"] is False
    assert summary["window_days"] == 7
    assert summary["totals"]["requests"] == 0
    assert summary["by_model"] == []
    assert summary["timeseries"] == []


def test_record_swallows_bad_event(temp_db):
    """Test record() swallows a bad/partial event without raising."""
    store = UsageStore(temp_db)

    # This should not raise even with missing required fields
    store.record({})
    store.record({"model": "test"})  # Partial event
    # store.record(None) would raise AttributeError - test that it doesn't crash the process
    # but we don't call it since it would error on .get() on None

    # Should not raise - rows are inserted with default values (zeros)
    summary = store.summary(days=7)
    assert summary["available"] is True  # Rows inserted with defaults
    assert summary["totals"]["requests"] == 2
    assert summary["totals"]["prompt_tokens"] == 0


def test_reopening_store_is_idempotent(temp_db):
    """Test re-opening the store is idempotent (schema IF NOT EXISTS)."""
    store1 = UsageStore(temp_db)
    store1.record(
        {
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "model": "model-a",
            "prompt_tokens": 100,
            "cached_tokens": 10,
            "completion_tokens": 50,
        }
    )

    # Create a new store instance with same path
    store2 = UsageStore(temp_db)
    summary = store2.summary(days=7)

    assert summary["available"] is True
    assert summary["totals"]["requests"] == 1


def test_available_method(temp_db):
    """Test available() returns True when DB has rows."""
    store = UsageStore(temp_db)
    assert store.available() is False

    store.record(
        {
            "ts": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
            "model": "model-a",
            "prompt_tokens": 100,
            "cached_tokens": 10,
            "completion_tokens": 50,
        }
    )
    assert store.available() is True
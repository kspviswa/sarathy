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
    # timeseries is filtered but still zero-fills the full window
    # (7-day daily window is inclusive of both end buckets -> 8 buckets)
    assert len(filtered["timeseries"]) == 8
    nonzero = [b for b in filtered["timeseries"] if b["prompt_tokens"] > 0]
    assert len(nonzero) == 1
    assert nonzero[0]["prompt_tokens"] == 1000

    # Unknown model -> zeroed totals, still available (window has data)
    unknown = store.summary(days=7, model="nope")
    assert unknown["available"] is True
    assert unknown["totals"]["requests"] == 0
    assert len(unknown["timeseries"]) == 8
    assert all(b["prompt_tokens"] == 0 for b in unknown["timeseries"])


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

    # 1 day window -> hourly buckets, zero-filled across the full window
    # (24h span, inclusive of both end buckets -> 25 buckets)
    summary = store.summary(days=1)
    assert len(summary["timeseries"]) >= 24
    assert len(summary["timeseries"]) <= 26

    by_ts = {b["ts"]: b for b in summary["timeseries"]}

    # First data bucket should have combined values from ts1 + ts2
    bucket1 = by_ts[first_bucket]
    assert bucket1["prompt_tokens"] == 300
    assert bucket1["cached_tokens"] == 50
    assert bucket1["cache_hit_pct"] == round(100 * 50 / 300, 1)

    # Second data bucket
    bucket2 = by_ts[second_bucket]
    assert bucket2["prompt_tokens"] == 150

    # Every other bucket in the window is zero-filled (no gaps -> no dots)
    data_buckets = {first_bucket, second_bucket}
    for bucket in summary["timeseries"]:
        if bucket["ts"] not in data_buckets:
            assert bucket["prompt_tokens"] == 0
            assert bucket["cached_tokens"] == 0
            assert bucket["cache_hit_pct"] == 0.0


def test_sparse_model_zero_filled_not_single_dot(temp_db):
    """A model active on one day must still get a full-window timeseries.

    Regression: the backend only returned buckets that had rows, so a model
    whose usage was concentrated on a single day produced a 1-point series,
    which the chart rendered as the '2 black dots' (one circle per series).
    """
    store = UsageStore(temp_db)

    # Model-a: only today. Model-b: yesterday too (so the window is non-empty
    # even if the model filter has no match).
    today = datetime.now(timezone.utc)
    yesterday = today - timedelta(days=1)

    def _iso(dt: datetime) -> str:
        return dt.isoformat().replace("+00:00", "Z")

    store.record(
        {"ts": _iso(today), "model": "model-a", "prompt_tokens": 800, "cached_tokens": 400, "completion_tokens": 50}
    )
    store.record(
        {"ts": _iso(yesterday), "model": "model-b", "prompt_tokens": 100, "cached_tokens": 0, "completion_tokens": 10}
    )

    summary = store.summary(days=7, model="model-a")

    # Full 7-day window, not a single point (inclusive ends -> 8 buckets)
    assert len(summary["timeseries"]) == 8
    assert summary["timeseries"][0]["ts"] < summary["timeseries"][-1]["ts"]
    assert summary["timeseries"][-1]["prompt_tokens"] == 800
    assert summary["timeseries"][-1]["cached_tokens"] == 400
    # Zero-filled days stay zero
    assert sum(1 for b in summary["timeseries"][:-1] if b["prompt_tokens"] == 0) == 7
    assert all(b["cache_hit_pct"] == 0.0 for b in summary["timeseries"][:-1])


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


def test_migration_v1_to_v2_idempotent(temp_db):
    """Test v1 -> v2 -> v3 migration is idempotent and lossless."""
    import sqlite3
    from datetime import datetime, timezone

    # Create a v1 database (no cost column, user_version = 1)
    conn = sqlite3.connect(temp_db)
    conn.execute("""
        CREATE TABLE usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            session_key TEXT,
            channel TEXT,
            model TEXT NOT NULL DEFAULT '',
            provider TEXT NOT NULL DEFAULT '',
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            cached_tokens INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens INTEGER,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            cache_discount REAL,
            duration_ms INTEGER,
            finish_reason TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(model, ts);")
    conn.execute("PRAGMA user_version = 1;")

    # Insert some v1 data with recent timestamps
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    conn.execute("""
        INSERT INTO usage_events (ts, session_key, model, provider, prompt_tokens, cached_tokens, completion_tokens, total_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (now, "test:1", "model-a", "openrouter", 1000, 300, 200, 1200))
    conn.execute("""
        INSERT INTO usage_events (ts, session_key, model, provider, prompt_tokens, cached_tokens, completion_tokens, total_tokens)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    """, (now, "test:2", "model-b", "local", 500, 100, 150, 650))
    conn.commit()
    conn.close()

    # Reset store to pick up the v1 DB
    reset_usage_store()
    store = UsageStore(temp_db)

    # Migration should have run: cost column exists, epoch column exists, user_version = 3
    conn = sqlite3.connect(temp_db)
    cols = conn.execute("PRAGMA table_info(usage_events);").fetchall()
    has_cost = any(col[1] == "cost" for col in cols)
    has_epoch = any(col[1] == "epoch" for col in cols)
    version = conn.execute("PRAGMA user_version;").fetchone()[0]
    conn.close()

    assert has_cost, "cost column should exist after migration"
    assert has_epoch, "epoch column should exist after migration"
    assert version == 3, "user_version should be 3 after migration"

    # Existing data should be intact
    summary = store.summary(days=7)
    assert summary["totals"]["requests"] == 2
    assert summary["totals"]["prompt_tokens"] == 1500

    # Re-running init should be idempotent (no error, no data loss)
    store2 = UsageStore(temp_db)
    summary2 = store2.summary(days=7)
    assert summary2["totals"]["requests"] == 2
    assert summary2["totals"]["prompt_tokens"] == 1500


def test_fresh_db_has_cost_column_and_version_2(temp_db):
    """Test fresh database gets cost column, epoch column, and user_version = 3 from schema."""
    store = UsageStore(temp_db)

    import sqlite3
    conn = sqlite3.connect(temp_db)
    cols = conn.execute("PRAGMA table_info(usage_events);").fetchall()
    has_cost = any(col[1] == "cost" for col in cols)
    has_epoch = any(col[1] == "epoch" for col in cols)
    version = conn.execute("PRAGMA user_version;").fetchone()[0]
    conn.close()

    assert has_cost, "fresh DB should have cost column"
    assert has_epoch, "fresh DB should have epoch column"
    assert version == 3, "fresh DB should have user_version = 3"


def test_session_cost_sums_real_costs(temp_db):
    """Test session_cost returns sum of costs for a session."""
    store = UsageStore(temp_db)
    session_key = "test:session_cost"

    # Record events with costs
    store.record({
        "ts": "2026-01-01T00:00:00Z",
        "session_key": session_key,
        "model": "model-a",
        "provider": "openrouter",
        "prompt_tokens": 1000,
        "completion_tokens": 500,
        "total_tokens": 1500,
        "cost": 0.01,
    })
    store.record({
        "ts": "2026-01-01T00:01:00Z",
        "session_key": session_key,
        "model": "model-a",
        "provider": "openrouter",
        "prompt_tokens": 2000,
        "completion_tokens": 1000,
        "total_tokens": 3000,
        "cost": 0.02,
    })
    # Event without cost (should be ignored in sum)
    store.record({
        "ts": "2026-01-01T00:02:00Z",
        "session_key": session_key,
        "model": "model-a",
        "provider": "local",
        "prompt_tokens": 500,
        "completion_tokens": 250,
        "total_tokens": 750,
    })

    cost = store.session_cost(session_key)
    assert cost is not None
    assert abs(cost - 0.03) < 0.0001  # 0.01 + 0.02


def test_session_cost_returns_none_when_no_cost_rows(temp_db):
    """Test session_cost returns None when no rows have cost."""
    store = UsageStore(temp_db)
    session_key = "test:no_cost"

    # Record events WITHOUT cost
    store.record({
        "ts": "2026-01-01T00:00:00Z",
        "session_key": session_key,
        "model": "model-a",
        "provider": "local",
        "prompt_tokens": 1000,
        "completion_tokens": 500,
        "total_tokens": 1500,
    })

    cost = store.session_cost(session_key)
    assert cost is None


def test_session_cost_returns_none_for_unknown_session(temp_db):
    """Test session_cost returns None for unknown session."""
    store = UsageStore(temp_db)
    cost = store.session_cost("nonexistent:session")
    assert cost is None


def test_session_cost_never_raises(temp_db, monkeypatch):
    """Test session_cost never raises even on DB error."""
    store = UsageStore(temp_db)

    original_get_conn = store._get_conn

    def failing_get_conn():
        conn = original_get_conn()
        original_execute = conn.execute

        def failing_execute(*args, **kwargs):
            raise Exception("DB error")

        conn.execute = failing_execute
        return conn

    monkeypatch.setattr(store, "_get_conn", failing_get_conn)

    cost = store.session_cost("test:session")
    assert cost is None


def test_session_cost_defaults_to_epoch_0(temp_db):
    """Test session_cost defaults to epoch 0 for backward compatibility."""
    store = UsageStore(temp_db)
    session_key = "test:epoch_default"

    # Record events at epoch 0 (default)
    store.record({
        "ts": "2026-01-01T00:00:00Z",
        "session_key": session_key,
        "model": "model-a",
        "provider": "openrouter",
        "prompt_tokens": 1000,
        "completion_tokens": 500,
        "total_tokens": 1500,
        "cost": 0.01,
    })

    # Call without epoch parameter (should default to 0)
    cost = store.session_cost(session_key)
    assert cost is not None
    assert abs(cost - 0.01) < 0.0001


def test_record_with_epoch_1_isolated(temp_db):
    """Test record with epoch 1 -> session_cost(key, 1) returns only those rows."""
    store = UsageStore(temp_db)
    session_key = "test:epoch_isolation"

    # Record at epoch 0
    store.record({
        "ts": "2026-01-01T00:00:00Z",
        "session_key": session_key,
        "model": "model-a",
        "provider": "openrouter",
        "prompt_tokens": 1000,
        "completion_tokens": 500,
        "total_tokens": 1500,
        "cost": 0.01,
        "epoch": 0,
    })

    # Record at epoch 1
    store.record({
        "ts": "2026-01-01T00:01:00Z",
        "session_key": session_key,
        "model": "model-a",
        "provider": "openrouter",
        "prompt_tokens": 2000,
        "completion_tokens": 1000,
        "total_tokens": 3000,
        "cost": 0.02,
        "epoch": 1,
    })

    # session_cost(key, 0) should only see epoch 0
    cost_0 = store.session_cost(session_key, 0)
    assert cost_0 is not None
    assert abs(cost_0 - 0.01) < 0.0001

    # session_cost(key, 1) should only see epoch 1
    cost_1 = store.session_cost(session_key, 1)
    assert cost_1 is not None
    assert abs(cost_1 - 0.02) < 0.0001

    # session_cost(key) without epoch defaults to 0
    cost_default = store.session_cost(session_key)
    assert cost_default is not None
    assert abs(cost_default - 0.01) < 0.0001


def test_reset_session_epoch_monotonic(temp_db):
    """Test reset_session_epoch returns 0 on empty key, then 1, 2... monotonically."""
    store = UsageStore(temp_db)
    session_key = "test:epoch_monotonic"

    # Empty key -> should return 0
    epoch0 = store.reset_session_epoch(session_key)
    assert epoch0 == 0

    # Record at epoch 0
    store.record({
        "ts": "2026-01-01T00:00:00Z",
        "session_key": session_key,
        "model": "model-a",
        "epoch": 0,
        "cost": 0.01,
    })

    # Reset -> should return 1
    epoch1 = store.reset_session_epoch(session_key)
    assert epoch1 == 1

    # Record at epoch 1
    store.record({
        "ts": "2026-01-01T00:01:00Z",
        "session_key": session_key,
        "model": "model-a",
        "epoch": 1,
        "cost": 0.02,
    })

    # Reset -> should return 2
    epoch2 = store.reset_session_epoch(session_key)
    assert epoch2 == 2


def test_get_session_epoch_non_advancing(temp_db):
    """Test get_session_epoch returns current epoch without advancing."""
    store = UsageStore(temp_db)
    session_key = "test:epoch_get"

    # Empty key -> should return 0
    epoch = store.get_session_epoch(session_key)
    assert epoch == 0

    # Record at epoch 0
    store.record({
        "ts": "2026-01-01T00:00:00Z",
        "session_key": session_key,
        "model": "model-a",
        "epoch": 0,
    })

    # get_session_epoch should return 0
    epoch = store.get_session_epoch(session_key)
    assert epoch == 0

    # Record at epoch 1
    store.record({
        "ts": "2026-01-01T00:01:00Z",
        "session_key": session_key,
        "model": "model-a",
        "epoch": 1,
    })

    # get_session_epoch should return 1 (latest)
    epoch = store.get_session_epoch(session_key)
    assert epoch == 1

    # Multiple calls should not advance
    epoch2 = store.get_session_epoch(session_key)
    assert epoch2 == 1


def test_new_style_flow_footer_shows_only_current_epoch(temp_db):
    """Test /new-style flow: record at epoch 0, reset -> record at epoch 1 -> footer shows only epoch-1 sum."""
    store = UsageStore(temp_db)
    from sarathy.usage.footer import format_usage_footer
    session_key = "test:new_flow"

    # Simulate first conversation (epoch 0)
    store.record({
        "ts": "2026-01-01T00:00:00Z",
        "session_key": session_key,
        "model": "model-a",
        "provider": "openrouter",
        "prompt_tokens": 1000,
        "completion_tokens": 500,
        "total_tokens": 1500,
        "cost": 0.05,
        "epoch": 0,
    })

    # /new -> reset epoch
    new_epoch = store.reset_session_epoch(session_key)
    assert new_epoch == 1

    # Simulate second conversation (epoch 1)
    store.record({
        "ts": "2026-01-01T00:01:00Z",
        "session_key": session_key,
        "model": "model-a",
        "provider": "openrouter",
        "prompt_tokens": 2000,
        "completion_tokens": 1000,
        "total_tokens": 3000,
        "cost": 0.03,
        "epoch": 1,
    })

    # Footer with epoch=1 should show only epoch 1 cost
    stats = {"total_tokens": 3000, "total_time": 10.0, "tokens_per_sec": 300.0}
    footer = format_usage_footer(stats, session_key, epoch=1)

    assert footer is not None
    assert "💵 $0.0300 session" in footer  # Only epoch 1 cost
    assert "💵 $0.0500 session" not in footer  # Not epoch 0 cost
    assert "💵 $0.0800 session" not in footer  # Not sum of both


def test_migration_v2_to_v3_preserves_rows_as_epoch_0(temp_db):
    """Test migration v2->v3: existing rows get epoch = 0, user_version becomes 3."""
    import sqlite3
    from datetime import datetime, timezone

    # Create a v2 database (with cost column, user_version = 2)
    conn = sqlite3.connect(temp_db)
    conn.execute("""
        CREATE TABLE usage_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            ts TEXT NOT NULL,
            session_key TEXT,
            channel TEXT,
            model TEXT NOT NULL DEFAULT '',
            provider TEXT NOT NULL DEFAULT '',
            prompt_tokens INTEGER NOT NULL DEFAULT 0,
            cached_tokens INTEGER NOT NULL DEFAULT 0,
            cache_write_tokens INTEGER,
            completion_tokens INTEGER NOT NULL DEFAULT 0,
            total_tokens INTEGER NOT NULL DEFAULT 0,
            cache_discount REAL,
            cost REAL,
            duration_ms INTEGER,
            finish_reason TEXT
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_events(ts);")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(model, ts);")
    conn.execute("PRAGMA user_version = 2;")

    # Insert some v2 data with recent timestamps
    now = datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
    conn.execute("""
        INSERT INTO usage_events (ts, session_key, model, provider, prompt_tokens, cached_tokens, completion_tokens, total_tokens, cost)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (now, "test:1", "model-a", "openrouter", 1000, 300, 200, 1200, 0.01))
    conn.execute("""
        INSERT INTO usage_events (ts, session_key, model, provider, prompt_tokens, cached_tokens, completion_tokens, total_tokens, cost)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, (now, "test:2", "model-b", "local", 500, 100, 150, 650, 0.02))
    conn.commit()
    conn.close()

    # Reset store to pick up the v2 DB
    from sarathy.usage.store import reset_usage_store
    reset_usage_store()
    store = UsageStore(temp_db)

    # Migration should have run: epoch column exists, user_version = 3
    conn = sqlite3.connect(temp_db)
    cols = conn.execute("PRAGMA table_info(usage_events);").fetchall()
    has_epoch = any(col[1] == "epoch" for col in cols)
    version = conn.execute("PRAGMA user_version;").fetchone()[0]
    conn.close()

    assert has_epoch, "epoch column should exist after migration"
    assert version == 3, "user_version should be 3 after migration"

    # Existing data should be intact and have epoch = 0
    summary = store.summary(days=7)
    assert summary["totals"]["requests"] == 2
    assert summary["totals"]["prompt_tokens"] == 1500

    # session_cost should work with default epoch=0
    cost1 = store.session_cost("test:1")
    cost2 = store.session_cost("test:2")
    assert cost1 is not None
    assert abs(cost1 - 0.01) < 0.0001
    assert cost2 is not None
    assert abs(cost2 - 0.02) < 0.0001

    # Re-running init should be idempotent (no error, no data loss)
    store2 = UsageStore(temp_db)
    summary2 = store2.summary(days=7)
    assert summary2["totals"]["requests"] == 2
    assert summary2["totals"]["prompt_tokens"] == 1500
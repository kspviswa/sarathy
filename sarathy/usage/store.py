"""Usage telemetry store — SQLite-backed, append-only event log with aggregates."""

from __future__ import annotations

import logging
import os
import sqlite3
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from sarathy.utils.helpers import get_data_path

logger = logging.getLogger(__name__)

_schema_sql = """
CREATE TABLE IF NOT EXISTS usage_events (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                 TEXT    NOT NULL,
  session_key        TEXT,
  channel            TEXT,
  model              TEXT    NOT NULL DEFAULT '',
  provider           TEXT    NOT NULL DEFAULT '',
  prompt_tokens      INTEGER NOT NULL DEFAULT 0,
  cached_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER,
  completion_tokens  INTEGER NOT NULL DEFAULT 0,
  total_tokens       INTEGER NOT NULL DEFAULT 0,
  cache_discount     REAL,
  cost               REAL,
  duration_ms        INTEGER,
  finish_reason      TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts    ON usage_events(ts);
CREATE INDEX IF NOT EXISTS idx_usage_model ON usage_events(model, ts);
PRAGMA user_version = 2;
"""

_usage_store_instance: "UsageStore | None" = None
_store_lock = threading.Lock()


def get_usage_store() -> "UsageStore":
    """Module-level lazy singleton for UsageStore."""
    global _usage_store_instance
    with _store_lock:
        if _usage_store_instance is None:
            _usage_store_instance = UsageStore()
        return _usage_store_instance


class UsageStore:
    """SQLite-backed append-only usage event store with aggregate queries."""

    def __init__(self, db_path: Path | None = None):
        self._db_path = db_path or self._default_db_path()
        self._local = threading.local()
        self._init_db()

    def _default_db_path(self) -> Path:
        env_path = os.environ.get("SARATHY_USAGE_DB")
        if env_path:
            return Path(env_path).expanduser()
        # Safety net: never touch the production DB from a test run, even if a
        # test forgets to set SARATHY_USAGE_DB. conftest isolates per-test; this
        # guards direct/standalone test invocations.
        if os.environ.get("PYTEST_CURRENT_TEST"):
            import tempfile

            return Path(tempfile.gettempdir()) / f"sarathy_usage_test_{os.getpid()}.db"
        return get_data_path() / "usage.db"

    def _get_conn(self) -> sqlite3.Connection:
        if not hasattr(self._local, "conn") or self._local.conn is None:
            self._local.conn = sqlite3.connect(
                self._db_path,
                check_same_thread=False,
                isolation_level=None,
            )
            self._local.conn.execute("PRAGMA journal_mode=WAL;")
            self._local.conn.execute("PRAGMA busy_timeout=5000;")
            self._local.conn.row_factory = sqlite3.Row
        return self._local.conn

    def _init_db(self) -> None:
        try:
            with self._get_conn() as conn:
                conn.executescript(_schema_sql)
                self._migrate_schema_if_needed(conn)
        except Exception as e:
            logger.debug("Usage store init failed: %s", e)

    def _migrate_schema_if_needed(self, conn: sqlite3.Connection) -> None:
        """Idempotent migration: add cost column and bump user_version to 2."""
        try:
            # Check current user_version
            row = conn.execute("PRAGMA user_version;").fetchone()
            current_version = row[0] if row else 0

            if current_version < 2:
                # Check if cost column already exists (fresh DB with new schema but old version)
                cols = conn.execute("PRAGMA table_info(usage_events);").fetchall()
                has_cost = any(col[1] == "cost" for col in cols)

                if not has_cost:
                    conn.execute("ALTER TABLE usage_events ADD COLUMN cost REAL;")

                conn.execute("PRAGMA user_version = 2;")
        except Exception as e:
            logger.debug("Usage store migration failed: %s", e)

    def record(self, event: dict[str, Any]) -> None:
        """Insert one usage event row. Never raises."""
        try:
            ts = event.get("ts") or datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")
            with self._get_conn() as conn:
                conn.execute(
                    """
                    INSERT INTO usage_events (
                        ts, session_key, channel, model, provider,
                        prompt_tokens, cached_tokens, cache_write_tokens,
                        completion_tokens, total_tokens, cache_discount, cost,
                        duration_ms, finish_reason
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        ts,
                        event.get("session_key"),
                        event.get("channel"),
                        event.get("model", ""),
                        event.get("provider", ""),
                        event.get("prompt_tokens", 0),
                        event.get("cached_tokens", 0),
                        event.get("cache_write_tokens"),
                        event.get("completion_tokens", 0),
                        event.get("total_tokens", 0),
                        event.get("cache_discount"),
                        event.get("cost"),
                        event.get("duration_ms"),
                        event.get("finish_reason"),
                    ),
                )
        except Exception as e:
            logger.debug("Usage store record failed: %s", e)

    def summary(self, days: int = 7, model: str | None = None) -> dict[str, Any]:
        """Aggregate usage over the given window.

        When ``model`` is given, totals and timeseries are restricted to that
        model (``by_model`` always lists every model, so the UI can offer the
        full set of filter options).
        """
        try:
            days = max(1, min(365, days))
            model_filter = model.strip() if isinstance(model, str) and model.strip() else None
            cutoff = datetime.now(timezone.utc).timestamp() - days * 86400
            cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat().replace("+00:00", "Z")

            # WHERE fragments shared by the filtered aggregates.
            where = "WHERE ts >= ?"
            where_args: list[Any] = [cutoff_iso]
            if model_filter is not None:
                where += " AND model = ?"
                where_args.append(model_filter)

            with self._get_conn() as conn:
                # Check if any data exists
                row = conn.execute(
                    "SELECT COUNT(*) as cnt FROM usage_events WHERE ts >= ?",
                    (cutoff_iso,),
                ).fetchone()
                if not row or row["cnt"] == 0:
                    return self._empty_summary(days)

                # Totals
                totals_row = conn.execute(
                    f"""
                    SELECT
                        COUNT(*) as requests,
                        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
                        COALESCE(SUM(cached_tokens), 0) as cached_tokens,
                        COALESCE(SUM(completion_tokens), 0) as completion_tokens,
                        COALESCE(SUM(total_tokens), 0) as total_tokens
                    FROM usage_events
                    {where}
                    """,
                    tuple(where_args),
                ).fetchone()

                prompt_total = totals_row["prompt_tokens"] or 0
                cached_total = totals_row["cached_tokens"] or 0
                cache_hit_pct = round(100.0 * cached_total / prompt_total, 1) if prompt_total > 0 else 0.0

                # By model
                by_model_rows = conn.execute(
                    """
                    SELECT
                        model,
                        provider,
                        COUNT(*) as requests,
                        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
                        COALESCE(SUM(cached_tokens), 0) as cached_tokens,
                        COALESCE(SUM(completion_tokens), 0) as completion_tokens
                    FROM usage_events
                    WHERE ts >= ?
                    GROUP BY model, provider
                    ORDER BY requests DESC
                    """,
                    (cutoff_iso,),
                ).fetchall()

                by_model = []
                for r in by_model_rows:
                    pm = r["prompt_tokens"] or 0
                    cm = r["cached_tokens"] or 0
                    hit_pct = round(100.0 * cm / pm, 1) if pm > 0 else 0.0
                    by_model.append(
                        {
                            "model": r["model"] or "",
                            "provider": r["provider"] or "",
                            "requests": r["requests"],
                            "prompt_tokens": pm,
                            "cached_tokens": cm,
                            "completion_tokens": r["completion_tokens"] or 0,
                            "cache_hit_pct": hit_pct,
                        }
                    )

                # Timeseries bucketing: hourly for <=2 days, daily otherwise.
                # The window is zero-filled so sparse models (e.g. one busy day)
                # still render a full timeline instead of 1-2 isolated points.
                bucket = "hour" if days <= 2 else "day"
                strftime_fmt = "%Y-%m-%dT%H:00:00Z" if bucket == "hour" else "%Y-%m-%dT00:00:00Z"

                ts_rows = conn.execute(
                    f"""
                    SELECT
                        strftime('{strftime_fmt}', ts) as bucket,
                        COALESCE(SUM(prompt_tokens), 0) as prompt_tokens,
                        COALESCE(SUM(cached_tokens), 0) as cached_tokens,
                        COALESCE(SUM(completion_tokens), 0) as completion_tokens
                    FROM usage_events
                    {where}
                    GROUP BY bucket
                    ORDER BY bucket
                    """,
                    tuple(where_args),
                ).fetchall()

                ts_map: dict[str, dict[str, Any]] = {}
                for r in ts_rows:
                    ts_map[r["bucket"]] = {
                        "prompt_tokens": r["prompt_tokens"] or 0,
                        "cached_tokens": r["cached_tokens"] or 0,
                        "completion_tokens": r["completion_tokens"] or 0,
                    }

                # Full window of buckets from cutoff to now (inclusive), zero-filled.
                now = datetime.now(timezone.utc)
                if bucket == "hour":
                    cur = datetime.fromtimestamp(cutoff, tz=timezone.utc).replace(
                        minute=0, second=0, microsecond=0
                    )
                    step = timedelta(hours=1)
                else:
                    cur = datetime.fromtimestamp(cutoff, tz=timezone.utc).replace(
                        hour=0, minute=0, second=0, microsecond=0
                    )
                    step = timedelta(days=1)

                timeseries = []
                while cur <= now:
                    label = cur.strftime("%Y-%m-%dT%H:00:00Z" if bucket == "hour" else "%Y-%m-%dT00:00:00Z")
                    row = ts_map.get(label, {"prompt_tokens": 0, "cached_tokens": 0, "completion_tokens": 0})
                    pt = row["prompt_tokens"]
                    ct = row["cached_tokens"]
                    hit_pct = round(100.0 * ct / pt, 1) if pt > 0 else 0.0
                    timeseries.append(
                        {
                            "ts": label,
                            "prompt_tokens": pt,
                            "cached_tokens": ct,
                            "completion_tokens": row["completion_tokens"],
                            "cache_hit_pct": hit_pct,
                        }
                    )
                    cur += step

                return {
                    "available": True,
                    "window_days": days,
                    "model": model_filter,
                    "totals": {
                        "requests": totals_row["requests"],
                        "prompt_tokens": prompt_total,
                        "cached_tokens": cached_total,
                        "completion_tokens": totals_row["completion_tokens"] or 0,
                        "total_tokens": totals_row["total_tokens"] or 0,
                        "cache_hit_pct": cache_hit_pct,
                    },
                    "by_model": by_model,
                    "timeseries": timeseries,
                }
        except Exception as e:
            logger.debug("Usage store summary failed: %s", e)
            return self._empty_summary(days, model_filter)

    def available(self) -> bool:
        """Check if DB exists and has at least one row."""
        try:
            with self._get_conn() as conn:
                row = conn.execute("SELECT 1 FROM usage_events LIMIT 1").fetchone()
                return row is not None
        except Exception:
            return False

    def session_cost(self, session_key: str) -> float | None:
        """Return cumulative cost for a session, or None if no cost data exists.

        Never raises; returns None on any error or when no rows have cost.
        """
        try:
            with self._get_conn() as conn:
                row = conn.execute(
                    "SELECT SUM(cost) as total FROM usage_events WHERE session_key = ? AND cost IS NOT NULL",
                    (session_key,),
                ).fetchone()
                if row and row["total"] is not None:
                    return float(row["total"])
                return None
        except Exception:
            return None

    def _empty_summary(self, days: int, model: str | None = None) -> dict[str, Any]:
        return {
            "available": False,
            "window_days": days,
            "model": model,
            "totals": {
                "requests": 0,
                "prompt_tokens": 0,
                "cached_tokens": 0,
                "completion_tokens": 0,
                "total_tokens": 0,
                "cache_hit_pct": 0.0,
            },
            "by_model": [],
            "timeseries": [],
        }


def reset_usage_store() -> None:
    """Reset the singleton (for testing)."""
    global _usage_store_instance
    with _store_lock:
        if _usage_store_instance is not None:
            try:
                if hasattr(_usage_store_instance._local, "conn") and _usage_store_instance._local.conn:
                    _usage_store_instance._local.conn.close()
            except Exception:
                pass
        _usage_store_instance = None

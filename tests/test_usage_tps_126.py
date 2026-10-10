"""Spec 126 §E — footer tokens/sec must match Telegram's derivation.

Telegram's footer (`sarathy/usage/footer.py`) renders AgentLoop's ``stats``,
whose ``tokens_per_sec`` is ``Σ completion_tokens / Σ elapsed`` over the calls in
a turn. The dashboard footer divided ``total_tokens`` (prompt + completion) by a
single call's wall time, which reported absurd rates — 70 130 tokens over 10.8 s
is 6 506 tps, and a 1.75 s row reported 38 116 tps.
"""

from __future__ import annotations

import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

import pytest

from sarathy.usage.store import UsageStore, reset_usage_store


@pytest.fixture
def temp_db():
    with tempfile.NamedTemporaryFile(suffix=".db", delete=False) as f:
        db_path = Path(f.name)
    os.environ["SARATHY_USAGE_DB"] = str(db_path)
    reset_usage_store()
    yield db_path
    reset_usage_store()
    os.environ.pop("SARATHY_USAGE_DB", None)
    if db_path.exists():
        db_path.unlink()


def _ts(offset_seconds: int = 0) -> str:
    from datetime import timedelta

    now = datetime.now(timezone.utc) + timedelta(seconds=offset_seconds)
    return now.isoformat().replace("+00:00", "Z")


def _row(store: UsageStore, **overrides):
    """Record one usage row with sane defaults for anything not overridden."""
    row = {
        "ts": _ts(),
        "session_key": "dashboard:console",
        "channel": "dashboard",
        "model": "model-a",
        "provider": "ollama",
        "prompt_tokens": 1000,
        "cached_tokens": 0,
        "completion_tokens": 200,
        "total_tokens": 1200,
        "duration_ms": 1000,
        "cost": 0.0,
        "finish_reason": "stop",
    }
    row.update(overrides)
    store.record(row)
    return row


# ---------------------------------------------------------------------------
# The derivation itself
# ---------------------------------------------------------------------------


class TestTokensPerSecDerivation:
    def test_completion_over_elapsed_is_the_documented_case(self, temp_db):
        """completion=2000, duration_ms=10000 → 200.0 tps (spec §E)."""
        store = UsageStore(temp_db)
        _row(store, completion_tokens=2000, duration_ms=10000)

        event = store.session_last_event("dashboard:console", 0)

        assert event["tokens_per_sec"] == pytest.approx(200.0)

    def test_a_prompt_heavy_row_does_not_inflate_tps(self, temp_db):
        """The reported bug in one row: 68k prompt, 200 completion, 1s.

        Old behavior: 68 200 tps. Correct: 200 tps — the prompt was *read*, not
        generated, so it has no bearing on a generation rate.
        """
        store = UsageStore(temp_db)
        _row(
            store,
            prompt_tokens=68000,
            cached_tokens=40000,
            completion_tokens=200,
            total_tokens=68200,
            duration_ms=1000,
        )

        event = store.session_last_event("dashboard:console", 0)

        assert event["tokens_per_sec"] == pytest.approx(200.0)

    def test_matches_agent_loop_accumulation_semantics(self, temp_db):
        """Telegram sums per-call completion/elapsed; a single row must match."""
        store = UsageStore(temp_db)
        _row(store, completion_tokens=2000, duration_ms=10000)

        event = store.session_last_event("dashboard:console", 0)

        agent_loop_total = 2000
        agent_loop_time = 10.0
        expected = agent_loop_total / agent_loop_time
        assert event["tokens_per_sec"] == pytest.approx(expected)

    def test_total_tokens_is_still_available_for_callers_that_want_it(self, temp_db):
        """The fix narrows the tps numerator; it must not erase the raw columns."""
        store = UsageStore(temp_db)
        _row(store, prompt_tokens=68000, completion_tokens=200, total_tokens=68200)

        event = store.session_last_event("dashboard:console", 0)

        assert event["total_tokens"] == 68200
        assert event["prompt_tokens"] == 68000
        assert event["completion_tokens"] == 200

    @pytest.mark.parametrize(
        "completion,duration_ms,expected",
        [
            (1, 1000, 1.0),
            (500, 1000, 500.0),
            (60, 20000, 3.0),
            (2000, 10000, 200.0),
        ],
    )
    def test_parameterized_cases(self, temp_db, completion, duration_ms, expected):
        store = UsageStore(temp_db)
        _row(store, completion_tokens=completion, duration_ms=duration_ms)
        event = store.session_last_event("dashboard:console", 0)
        assert event["tokens_per_sec"] == pytest.approx(expected)

    def test_zero_duration_yields_zero_not_a_division_error(self, temp_db):
        store = UsageStore(temp_db)
        _row(store, completion_tokens=2000, duration_ms=0)

        event = store.session_last_event("dashboard:console", 0)

        assert event["tokens_per_sec"] == 0.0

    def test_zero_completion_yields_zero(self, temp_db):
        store = UsageStore(temp_db)
        _row(store, completion_tokens=0, duration_ms=5000)

        event = store.session_last_event("dashboard:console", 0)

        assert event["tokens_per_sec"] == 0.0

    def test_latest_row_wins(self, temp_db):
        store = UsageStore(temp_db)
        _row(store, ts=_ts(-60), completion_tokens=1000, duration_ms=1000)
        _row(store, ts=_ts(0), completion_tokens=2000, duration_ms=10000)

        event = store.session_last_event("dashboard:console", 0)

        assert event["tokens_per_sec"] == pytest.approx(200.0)

    def test_missing_session_returns_none(self, temp_db):
        store = UsageStore(temp_db)
        assert store.session_last_event("nope", 0) is None


# ---------------------------------------------------------------------------
# The API that feeds the footer strip
# ---------------------------------------------------------------------------


class TestFooterApiTokens:
    @pytest.mark.asyncio
    async def test_footer_reports_completion_tokens_not_prompt_plus_completion(
        self, temp_db
    ):
        """`tokens` must match Telegram's semantics (spec §E)."""
        from unittest.mock import MagicMock, patch

        from sarathy.bus.queue import MessageBus
        from sarathy.channels.dashboard.server import DashboardChannel
        from sarathy.config.schema import DashboardConfig
        from sarathy.usage.store import get_usage_store, reset_usage_store

        reset_usage_store()
        store = get_usage_store()
        _row(store, prompt_tokens=68000, completion_tokens=200, total_tokens=68200)

        ch = DashboardChannel(DashboardConfig(), MessageBus())
        request = MagicMock()
        request.query = {"key": "dashboard:console"}

        with patch("sarathy.config.loader.load_config", side_effect=RuntimeError("no cfg")):
            resp = await ch._api_session_footer(request)

        import json

        body = json.loads(resp.body)
        assert body["tokens"] == 200
        assert body["tokensPerSec"] == pytest.approx(200.0)

        reset_usage_store()
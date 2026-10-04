"""Tests for the sessions SQLite index fast path (job 114)."""

from __future__ import annotations

import sqlite3

from sarathy.config.schema import Config
from sarathy.session.manager import SessionManager, channel_for_key


def _make_manager(tmp_path) -> SessionManager:
    return SessionManager(Config(), workspace=tmp_path / "sessions")


def test_channel_for_key():
    assert channel_for_key("telegram:5878545507") == "telegram"
    assert channel_for_key("backend:42") == "backend"
    assert channel_for_key("cron:nightly") == "cron"
    assert channel_for_key("no-colon") == "cli"


def test_save_upserts_index_and_list_fast_path(tmp_path):
    sm = _make_manager(tmp_path)
    s = sm.get_or_create("telegram:1")
    s.metadata["topic"] = "pi durable research"
    sm.save(s)
    s2 = sm.get_or_create("dashboard:console")
    s2.metadata["topic"] = "locked topic"
    s2.metadata["topic_user_set"] = True
    sm.save(s2)

    db_path = sm._index_db_path()
    assert db_path.exists()
    conn = sqlite3.connect(str(db_path))
    try:
        rows = dict(conn.execute("SELECT key, topic FROM sessions").fetchall())
    finally:
        conn.close()
    assert rows["telegram:1"] == "pi durable research"
    assert rows["dashboard:console"] == "locked topic"

    listed = {item["key"]: item for item in sm.list_sessions()}
    assert listed["telegram:1"]["topic"] == "pi durable research"
    assert listed["telegram:1"]["channel"] == "telegram"
    assert listed["dashboard:console"]["topic_user_set"] is True
    assert listed["dashboard:console"]["channel"] == "dashboard"
    assert all("path" in item for item in listed.values())


def test_fallback_scan_still_works_and_has_topic(tmp_path):
    sm = _make_manager(tmp_path)
    s = sm.get_or_create("telegram:9")
    s.metadata["topic"] = "fallback topic"
    sm.save(s)

    (sm._index_db_path()).unlink()

    listed = {item["key"]: item for item in sm.list_sessions()}
    assert listed["telegram:9"]["topic"] == "fallback topic"
    assert listed["telegram:9"]["channel"] == "telegram"


def test_rebuild_index_repopulates(tmp_path):
    sm = _make_manager(tmp_path)
    s = sm.get_or_create("telegram:5")
    s.metadata["topic"] = "rebuild me"
    sm.save(s)

    (sm._index_db_path()).unlink()
    count = sm.rebuild_index()
    assert count >= 1

    listed = {item["key"]: item for item in sm.list_sessions()}
    assert listed["telegram:5"]["topic"] == "rebuild me"
    assert listed["telegram:5"]["channel"] == "telegram"


def test_archive_marks_row_archived(tmp_path):
    sm = _make_manager(tmp_path)
    s = sm.get_or_create("telegram:7")
    s.add_message("user", "hello")
    sm.save(s)
    s.archive_session(learned=True)

    conn = sqlite3.connect(str(sm._index_db_path()))
    try:
        row = conn.execute(
            "SELECT archived FROM sessions WHERE key = ?", ("telegram:7",)
        ).fetchone()
    finally:
        conn.close()
    assert row is not None and row[0] == 1
    # Archived rows are hidden from the active list.
    assert "telegram:7" not in {item["key"] for item in sm.list_sessions()}


def test_key_without_colon_channel_cli(tmp_path):
    sm = _make_manager(tmp_path)
    s = sm.get_or_create("oddkey")
    sm.save(s)
    listed = {item["key"]: item for item in sm.list_sessions()}
    assert listed["oddkey"]["channel"] == "cli"

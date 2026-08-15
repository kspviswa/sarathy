"""utility helpers."""

from __future__ import annotations

from sarathy.utils.helpers import (
    ensure_dir,
    get_data_path,
    parse_session_key,
    safe_filename,
    timestamp,
    truncate_string,
)


def test_truncate_string():
    assert truncate_string("hello world", 5) == "he..."
    assert truncate_string("hi", 10) == "hi"


def test_safe_filename():
    assert safe_filename('a/b:c*d') == "a_b_c_d"
    assert safe_filename("plain").strip() == "plain"


def test_timestamp_is_iso():
    assert timestamp()


def test_ensure_dir(tmp_path):
    d = tmp_path / "a" / "b"
    assert ensure_dir(d) == d
    assert d.is_dir()


def test_parse_session_key():
    assert parse_session_key("telegram:123") == ("telegram", "123")
    try:
        parse_session_key("nope")
        raise AssertionError("expected ValueError")
    except ValueError:
        pass


def test_get_data_path_honors_env(tmp_path, monkeypatch):
    monkeypatch.setenv("SARATHY_HOME", str(tmp_path))
    assert get_data_path() == tmp_path

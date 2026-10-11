"""Graceful-shutdown durability.

A restart (SIGTERM) kills the gateway mid-turn, so the end-of-turn save never
runs. Without a flush, the exchange in flight is dropped from the transcript —
the 2026-10-11 hole: a redeploy launched from a tool call lost the whole turn
from the dashboard history.

Two guarantees under test:
  1. ``SessionManager.save_all`` lands every in-memory session on disk.
  2. ``stop_gateway`` waits for the process to actually exit, so that flush
     finishes (and the port is released) before a replacement starts.
"""

from __future__ import annotations

import subprocess
import sys
import time
from pathlib import Path

from sarathy.config.schema import Config
from sarathy.gateway import manager as gm
from sarathy.session.manager import SessionManager


def _make_manager(tmp_path: Path) -> SessionManager:
    config = Config()
    config.agents.defaults.workspace = str(tmp_path)
    config.agents.memory_archival.max_session_size = 50
    return SessionManager(config, workspace=tmp_path)


# --------------------------------------------------------------------- save_all


def test_save_all_persists_unsaved_in_memory_sessions(tmp_path):
    """The exact regression: messages added in memory but never saved survive a
    flush, so a reload/restart sees them."""
    mgr = _make_manager(tmp_path)
    session = mgr.get_or_create("dashboard:console")
    session.messages = [
        {"role": "user", "content": "port quote-and-ask to mobile"},
        {"role": "assistant", "content": "working on it…"},
    ]
    # Deliberately NOT saved — this is the mid-turn state at SIGTERM time.

    # A disk-backed read (what /api/session + reload use) sees nothing yet.
    assert mgr.read_session("dashboard:console") is None

    flushed = mgr.save_all()

    assert flushed == 1
    reloaded = mgr.read_session("dashboard:console")
    assert reloaded is not None
    assert [m["content"] for m in reloaded.messages] == [
        "port quote-and-ask to mobile",
        "working on it…",
    ]


def test_save_all_flushes_every_cached_session(tmp_path):
    mgr = _make_manager(tmp_path)
    for key in ("dashboard:console", "telegram:1", "telegram:2"):
        s = mgr.get_or_create(key)
        s.messages = [{"role": "user", "content": f"hi from {key}"}]

    assert mgr.save_all() == 3
    for key in ("dashboard:console", "telegram:1", "telegram:2"):
        got = mgr.read_session(key)
        assert got is not None and len(got.messages) == 1


def test_save_all_is_best_effort_when_one_session_fails(tmp_path, monkeypatch):
    mgr = _make_manager(tmp_path)
    mgr.get_or_create("dashboard:console").messages = [{"role": "user", "content": "a"}]
    mgr.get_or_create("telegram:1").messages = [{"role": "user", "content": "b"}]

    real_save = mgr.save

    def flaky(session):
        if session.key == "dashboard:console":
            raise OSError("disk full")
        return real_save(session)

    monkeypatch.setattr(mgr, "save", flaky)
    assert mgr.save_all() == 1  # the healthy one still landed
    assert mgr.read_session("telegram:1") is not None


# ------------------------------------------------------------------ stop_gateway


def test_stop_gateway_returns_false_without_a_pid(tmp_path, monkeypatch):
    monkeypatch.setattr(gm, "get_pid_file_path", lambda: tmp_path / "gateway.pid")
    assert gm.stop_gateway() is False


def test_stop_gateway_waits_for_the_process_to_exit(tmp_path, monkeypatch):
    """It must not return until the gateway has actually gone — otherwise a
    replacement could start before the session flush completes."""
    monkeypatch.setattr(gm, "get_pid_file_path", lambda: tmp_path / "gateway.pid")

    # A child that lingers ~0.4s after SIGTERM (simulating a graceful flush).
    child_code = (
        "import signal, sys, time\n"
        "def h(*a):\n"
        "    time.sleep(0.4)\n"
        "    sys.exit(0)\n"
        "signal.signal(signal.SIGTERM, h)\n"
        "print('ready', flush=True)\n"
        "time.sleep(30)\n"
    )
    child = subprocess.Popen(
        [sys.executable, "-c", child_code],
        stdout=subprocess.PIPE,
    )
    try:
        assert child.stdout is not None
        assert child.stdout.readline().strip() == b"ready"
        gm.write_pid(child.pid)

        started = time.monotonic()
        assert gm.stop_gateway(timeout=5.0) is True
        elapsed = time.monotonic() - started

        assert elapsed >= 0.3, "stop_gateway returned before the process exited"
        assert child.poll() is not None
    finally:
        if child.poll() is None:  # pragma: no cover — safety net
            child.kill()
        child.wait(timeout=5)


def test_process_alive_detects_a_running_and_a_finished_pid(tmp_path):
    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert gm._process_alive(child.pid) is True
        child.terminate()
        child.wait(timeout=5)
        assert gm._process_alive(child.pid) is False
    finally:
        if child.poll() is None:  # pragma: no cover — safety net
            child.kill()
            child.wait(timeout=5)

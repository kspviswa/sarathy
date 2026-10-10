"""Tests for the dashboard channel server and auth module."""

import json
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from sarathy.bus.events import OutboundMessage
from sarathy.bus.queue import MessageBus
from sarathy.channels.dashboard import auth
from sarathy.channels.dashboard.server import DashboardChannel
from sarathy.config.loader import save_config
from sarathy.config.schema import Config
from sarathy.core.notify import TG_LIVE_CHAT_ID
from sarathy.session.manager import SessionManager

# ---------------------------------------------------------------------------
# Auth helpers
# ---------------------------------------------------------------------------


def _write_config(config_path: Path, workspace: Path, keys: list[str]) -> None:
    cfg = Config()
    cfg.channels.dashboard.enabled = True
    cfg.channels.dashboard.pairing_keys = keys
    cfg.agents.defaults.workspace = str(workspace)
    save_config(cfg, config_path)


def _make_channel(config_path: Path, workspace: Path) -> DashboardChannel:
    cfg = Config()
    cfg.channels.dashboard.enabled = True
    cfg.channels.dashboard.pairing_keys = ["test-key"]
    cfg.agents.defaults.workspace = str(workspace)
    session_manager = SessionManager(cfg, workspace=workspace)
    session = session_manager.get_or_create("dashboard:console")
    session.add_message("user", "hello there")
    session.add_message("assistant", "hi!")
    session_manager.save(session)
    return DashboardChannel(
        cfg.channels.dashboard,
        MessageBus(),
        session_manager=session_manager,
        config_path=config_path,
        devices_path=config_path.parent / "devices.json",
    )


# ---------------------------------------------------------------------------
# Auth module
# ---------------------------------------------------------------------------


def test_is_valid_pairing_key_reads_on_disk_config(tmp_path) -> None:
    cfg_file = tmp_path / "config.json"
    _write_config(cfg_file, tmp_path / "ws", ["alpha", "beta"])

    assert auth.is_valid_pairing_key("alpha", cfg_file) is True
    assert auth.is_valid_pairing_key("beta", cfg_file) is True
    assert auth.is_valid_pairing_key("gamma", cfg_file) is False
    assert auth.is_valid_pairing_key("", cfg_file) is False


def test_redact_config_masks_secrets() -> None:
    data = {
        "agents": {"defaults": {"model": "llama3"}},
        "providers": {"ollama": {"apiKey": "sk-123", "apiBase": "http://localhost"}},
        "channels": {
            "telegram": {"token": "abc"},
            "dashboard": {"pairingKeys": ["k1"]},
        },
    }
    redacted = auth.redact_config(data)
    assert redacted["providers"]["ollama"]["apiKey"] == "<set>"
    assert redacted["providers"]["ollama"]["apiBase"] == "http://localhost"
    assert redacted["channels"]["telegram"]["token"] == "<set>"
    assert redacted["channels"]["dashboard"]["pairingKeys"] == ["<set>"]
    assert redacted["agents"]["defaults"]["model"] == "llama3"


def test_merge_config_preserves_set_placeholders_and_applies_changes() -> None:
    current = {"a": {"secret": "real", "keep": 1}, "b": 2}
    incoming = {"a": {"secret": "<set>", "keep": 5}, "b": 3, "c": "new"}
    merged = auth.merge_config(current, incoming)
    assert merged["a"]["secret"] == "real"
    assert merged["a"]["keep"] == 5
    assert merged["b"] == 3
    assert merged["c"] == "new"


def test_merge_config_empty_string_clears_secret() -> None:
    current = {"a": {"secret": "real"}}
    merged = auth.merge_config(current, {"a": {"secret": ""}})
    assert merged["a"]["secret"] == ""


def test_device_registry_register_validate_revoke(tmp_path) -> None:
    reg = auth.DeviceRegistry(tmp_path / "devices.json")
    token, device_id = reg.register("key1", "iphone")
    assert device_id
    assert reg.validate(token) == device_id
    assert reg.validate("bogus") is None

    # Revoking a different key keeps the device
    assert reg.revoke_by_key("key2") == 0
    assert reg.validate(token) == device_id

    # Revoking the paired key removes it
    assert reg.revoke_by_key("key1") == 1
    assert reg.validate(token) is None


def test_device_registry_remove_device(tmp_path) -> None:
    reg = auth.DeviceRegistry(tmp_path / "devices.json")
    _, device_id = reg.register("key1", "device")
    assert reg.remove_device(device_id) is True
    assert reg.remove_device(device_id) is False


# ---------------------------------------------------------------------------
# Server API
# ---------------------------------------------------------------------------


async def _pair(client: TestClient) -> str:
    resp = await client.post("/api/auth/pair", json={"key": "test-key", "deviceName": "iphone"})
    assert resp.status == 200
    return (await resp.json())["token"]


async def _authed_client(tmp_path) -> tuple[TestClient, DashboardChannel]:
    config_path = tmp_path / "config.json"
    workspace = tmp_path / "ws"
    _write_config(config_path, workspace, ["test-key"])
    channel = _make_channel(config_path, workspace)
    client = TestClient(TestServer(channel._build_app()))
    return client, channel


@pytest.mark.asyncio
async def test_pair_with_valid_and_invalid_key(tmp_path) -> None:
    client, _ = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        assert token

        resp = await client.post("/api/auth/pair", json={"key": "wrong"})
        assert resp.status == 401


@pytest.mark.asyncio
async def test_api_requires_token(tmp_path) -> None:
    client, _ = await _authed_client(tmp_path)
    async with client:
        resp = await client.get("/api/config")
        assert resp.status == 401

        resp = await client.post("/api/chat", json={"content": "hi"})
        assert resp.status == 401


@pytest.mark.asyncio
async def test_chat_publishes_to_bus(tmp_path) -> None:
    client, channel = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        resp = await client.post(
            "/api/chat", json={"content": "hello world"}, headers={"Authorization": f"Bearer {token}"}
        )
        assert resp.status == 200

        msg = await asyncio_wait(channel)
        assert msg.channel == "dashboard"
        assert msg.content == "hello world"
        assert msg.session_key == "dashboard:console"


async def asyncio_wait(channel):
    import asyncio

    return await asyncio.wait_for(channel.bus.consume_inbound(), timeout=5)


@pytest.mark.asyncio
async def test_config_get_is_redacted_and_put_preserves_secrets(tmp_path) -> None:
    client, _ = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        headers = {"Authorization": f"Bearer {token}"}

        # Seed a provider API key so redaction/merge can be verified
        cfg = Config()
        cfg.channels.dashboard.pairing_keys = ["test-key"]
        cfg.agents.defaults.workspace = str(tmp_path / "ws")
        cfg.providers["ollama"].api_key = "secret-value"
        save_config(cfg, tmp_path / "config.json")

        resp = await client.get("/api/config", headers=headers)
        assert resp.status == 200
        data = await resp.json()
        assert data["providers"]["ollama"]["apiKey"] == "<set>"
        assert data["channels"]["dashboard"]["pairingKeys"] == ["<set>"]

        # Change temperature and send back the full payload with <set> placeholders
        data["agents"]["defaults"]["temperature"] = 0.42
        resp = await client.put("/api/config", json=data, headers=headers)
        assert resp.status == 200

        from sarathy.config.loader import load_config

        reloaded = load_config(tmp_path / "config.json")
        assert reloaded.agents.defaults.temperature == 0.42
        assert reloaded.providers["ollama"].api_key == "secret-value"


@pytest.mark.asyncio
async def test_config_put_invalid_json_rejected(tmp_path) -> None:
    client, _ = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        headers = {"Authorization": f"Bearer {token}"}
        resp = await client.put("/api/config", json="not-a-dict", headers=headers)
        assert resp.status == 400


@pytest.mark.asyncio
async def test_sessions_endpoints(tmp_path) -> None:
    client, _ = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        headers = {"Authorization": f"Bearer {token}"}

        resp = await client.get("/api/sessions", headers=headers)
        assert resp.status == 200
        sessions = (await resp.json())["sessions"]
        assert any(s["key"] == "dashboard:console" for s in sessions)

        resp = await client.get(
            "/api/session", params={"key": "dashboard:console"}, headers=headers
        )
        assert resp.status == 200
        body = await resp.json()
        roles = [m["role"] for m in body["messages"]]
        assert "user" in roles and "assistant" in roles

        resp = await client.get("/api/session", params={"key": "nope"}, headers=headers)
        assert resp.status == 404


@pytest.mark.asyncio
async def test_session_history_strips_topic_marker(tmp_path) -> None:
    # KB #456: legacy transcripts persisted before save-time stripping still
    # carry the marker; the history endpoint must strip it on read so it never
    # reaches a client (it leaked into the mobile history view).
    client, channel = await _authed_client(tmp_path)
    sm = channel.session_manager
    session = sm.get_or_create("dashboard:console")
    session.add_message("assistant", 'Answer here.\n<topic>{"set": "leaked"}</topic>')
    sm.save(session)

    async with client:
        token = await _pair(client)
        headers = {"Authorization": f"Bearer {token}"}
        resp = await client.get(
            "/api/session", params={"key": "dashboard:console"}, headers=headers
        )
        assert resp.status == 200
        body = await resp.json()
        assistant = [m for m in body["messages"] if m["role"] == "assistant"]
        assert assistant
        assert all("<topic>" not in m["content"] for m in assistant)
        assert any(m["content"] == "Answer here." for m in assistant)


@pytest.mark.asyncio
async def test_workspace_file_read_write_and_traversal(tmp_path) -> None:
    client, _ = await _authed_client(tmp_path)
    workspace = tmp_path / "ws"
    (workspace / "notes.txt").write_text("hi from workspace")
    async with client:
        token = await _pair(client)
        headers = {"Authorization": f"Bearer {token}"}

        resp = await client.get("/api/workspace/file", params={"path": "notes.txt"}, headers=headers)
        assert resp.status == 200
        assert (await resp.json())["content"] == "hi from workspace"

        resp = await client.put(
            "/api/workspace/file", json={"path": "sub/nested.txt", "content": "new"}, headers=headers
        )
        assert resp.status == 200
        assert (workspace / "sub" / "nested.txt").read_text() == "new"

        resp = await client.get(
            "/api/workspace/file", params={"path": "../escape.txt"}, headers=headers
        )
        assert resp.status == 400

        resp = await client.get("/api/workspace/file", params={"path": "missing.txt"}, headers=headers)
        assert resp.status == 404


@pytest.mark.asyncio
async def test_workspace_tree(tmp_path) -> None:
    client, _ = await _authed_client(tmp_path)
    (tmp_path / "ws" / "a.txt").write_text("a")
    (tmp_path / "ws" / "dir").mkdir()
    (tmp_path / "ws" / "dir" / "b.txt").write_text("b")
    async with client:
        token = await _pair(client)
        resp = await client.get(
            "/api/workspace/tree", headers={"Authorization": f"Bearer {token}"}
        )
        assert resp.status == 200
        tree = (await resp.json())["tree"]
        names = {n["name"]: n for n in tree}
        assert "a.txt" in names and "dir" in names
        assert names["dir"]["children"][0]["name"] == "b.txt"


@pytest.mark.asyncio
async def test_restart_writes_flag(tmp_path, monkeypatch) -> None:
    """Spec 124 §C3: a dashboard restart pings the dashboard AND Telegram.

    The flag used to carry a single {channel, chat_id} pair, which meant a
    restart triggered here was silent on Telegram.
    """
    client, _ = await _authed_client(tmp_path)
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr("sarathy.utils.helpers.get_data_path", lambda: data_dir)
    monkeypatch.setattr("sarathy.channels.dashboard.server.subprocess.Popen", lambda *a, **k: None)

    async with client:
        token = await _pair(client)
        resp = await client.post(
            "/api/restart", headers={"Authorization": f"Bearer {token}"}
        )
        assert resp.status == 200
        flag = data_dir / "restart_pending.json"
        assert flag.exists()
        payload = json.loads(flag.read_text())
        pairs = [(t["channel"], t["chat_id"]) for t in payload["targets"]]
        assert ("dashboard", "console") in pairs
        assert ("telegram", TG_LIVE_CHAT_ID) in pairs
        # Legacy keys retained so an older gateway build still notifies.
        assert payload["channel"] == "dashboard"
        assert payload["chat_id"] == "console"


@pytest.mark.asyncio
async def test_ws_receives_outbound_broadcast(tmp_path) -> None:
    client, channel = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        ws = await client.ws_connect(f"/ws?token={token}")
        await channel.send(
            OutboundMessage(channel="dashboard", chat_id="console", content="streamed!")
        )
        msg = await asyncio_wait_ws(ws)
        payload = json.loads(msg.data)
        assert payload["type"] == "message"
        assert payload["content"] == "streamed!"
        assert payload["metadata"] == {}
        await ws.close()


async def asyncio_wait_ws(ws):
    import asyncio

    return await asyncio.wait_for(ws.receive(), timeout=5)


@pytest.mark.asyncio
async def test_ws_notification_frame_broadcast(tmp_path) -> None:
    client, channel = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        ws = await client.ws_connect(f"/ws?token={token}")
        await channel.send_notification("Job done", "Backup finished", tab="status")
        raw = await asyncio_wait_ws(ws)
        payload = json.loads(raw.data)
        assert payload["type"] == "notification"
        assert payload["payload"]["title"] == "Job done"
        assert payload["payload"]["body"] == "Backup finished"
        assert payload["payload"]["tab"] == "status"
        assert "timestamp" in payload["payload"]
        await ws.close()


@pytest.mark.asyncio
async def test_ws_unauthorized_without_token(tmp_path) -> None:
    client, _ = await _authed_client(tmp_path)
    async with client:
        resp = await client.get("/ws")
        assert resp.status == 401


# ---------------------------------------------------------------------------
# Device detection + /mobile routing
# ---------------------------------------------------------------------------


class _FakeDeviceRequest:
    def __init__(self, ua: str = "", query: dict | None = None, cookies: dict | None = None):
        self._ua = ua
        self.query = query or {}
        self.cookies = cookies or {}

    @property
    def headers(self):  # minimal aiohttp-like headers mapping
        if self._ua:
            return {"User-Agent": self._ua}
        return {}


def test_device_kind_phone_desktop_tablet(tmp_path) -> None:
    channel = _make_channel(tmp_path / "config.json", tmp_path / "ws")

    # Phone UAs -> mobile
    assert (
        channel._device_kind(
            _FakeDeviceRequest(
                "Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) "
                "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
            )
        )
        == "mobile"
    )
    assert channel._device_kind(_FakeDeviceRequest("Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile Safari/537.36")) == "mobile"
    assert channel._device_kind(_FakeDeviceRequest("Mozilla/5.0 (Windows Phone 10.0; Android) Firefox/58.0")) == "mobile"

    # Desktop UA -> desktop
    assert (
        channel._device_kind(
            _FakeDeviceRequest(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                "(KHTML, like Gecko) Chrome/120.0 Safari/537.36"
            )
        )
        == "desktop"
    )
    # Tablet (iPad) -> desktop per the product decision (only phones get mobile)
    assert (
        channel._device_kind(
            _FakeDeviceRequest(
                "Mozilla/5.0 (iPad; CPU OS 16_0 like Mac OS X) AppleWebKit/605.1.15 "
                "(KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1"
            )
        )
        == "desktop"
    )
    # No UA at all -> desktop
    assert channel._device_kind(_FakeDeviceRequest()) == "desktop"


def test_view_override_from_query_and_cookie(tmp_path) -> None:
    channel = _make_channel(tmp_path / "config.json", tmp_path / "ws")
    assert channel._view_override(_FakeDeviceRequest(query={"view": "mobile"})) == "mobile"
    assert channel._view_override(_FakeDeviceRequest(query={"view": "desktop"})) == "desktop"
    assert channel._view_override(_FakeDeviceRequest(cookies={"sarathy_view": "mobile"})) == "mobile"
    assert channel._view_override(_FakeDeviceRequest(cookies={"sarathy_view": "desktop"})) == "desktop"
    assert channel._view_override(_FakeDeviceRequest(query={"view": "weird"})) is None
    assert channel._view_override(_FakeDeviceRequest()) is None


# ---------------------------------------------------------------------------
# Jobs API
# ---------------------------------------------------------------------------


def _create_jobs_db(workspace: Path) -> None:
    """Create a test jobs database with sample data."""
    import sqlite3

    jobs_dir = workspace / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    db_path = jobs_dir / "jobs.db"

    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL DEFAULT 'sdd',
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            repo TEXT, model TEXT,
            spec_path TEXT, result_path TEXT,
            meta TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE job_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL,
            ts TEXT NOT NULL,
            event_type TEXT NOT NULL,
            level TEXT NOT NULL DEFAULT 'info',
            message TEXT NOT NULL,
            payload TEXT
        )
    """)
    conn.execute(
        """
        INSERT INTO jobs (id, kind, title, status, repo, model, spec_path, result_path, meta,
                          created_at, updated_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            1,
            "sdd",
            "Test Job 1",
            "completed",
            "repo1",
            "model1",
            "jobs/specs/1.md",
            "jobs/results/1.md",
            '{"key": "value"}',
            "2026-01-01T00:00:00Z",
            "2026-01-01T01:00:00Z",
            "2026-01-01T02:00:00Z",
        ),
    )
    conn.execute(
        """
        INSERT INTO jobs (id, kind, title, status, repo, model, spec_path, result_path, meta,
                          created_at, updated_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            2,
            "sdd",
            "Test Job 2",
            "running",
            "repo2",
            "model2",
            "jobs/specs/2.md",
            "jobs/results/2.md",
            '{"key": "value2"}',
            "2026-01-02T00:00:00Z",
            "2026-01-02T01:00:00Z",
            None,
        ),
    )
    conn.execute(
        """
        INSERT INTO job_events (job_id, ts, event_type, level, message, payload)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            1,
            "2026-01-01T00:00:00Z",
            "created",
            "info",
            "Job created",
            None,
        ),
    )
    conn.execute(
        """
        INSERT INTO job_events (job_id, ts, event_type, level, message, payload)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            1,
            "2026-01-01T01:00:00Z",
            "completed",
            "info",
            "Job completed",
            '{"detail": "done"}',
        ),
    )
    conn.execute(
        """
        INSERT INTO job_events (job_id, ts, event_type, level, message, payload)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            2,
            "2026-01-02T00:00:00Z",
            "created",
            "info",
            "Job created",
            None,
        ),
    )
    conn.execute(
        """
        INSERT INTO job_events (job_id, ts, event_type, level, message, payload)
        VALUES (?, ?, ?, ?, ?, ?)
        """,
        (
            2,
            "2026-01-02T00:30:00Z",
            "launched",
            "info",
            "Job launched",
            None,
        ),
    )
    conn.commit()
    conn.close()

    # Create spec and result files
    (workspace / "jobs" / "specs").mkdir(parents=True, exist_ok=True)
    (workspace / "jobs" / "results").mkdir(parents=True, exist_ok=True)
    (workspace / "jobs" / "specs" / "1.md").write_text("# Spec 1\n\nContent of spec 1")
    (workspace / "jobs" / "results" / "1.md").write_text("# Result 1\n\nContent of result 1")
    (workspace / "jobs" / "specs" / "2.md").write_text("# Spec 2\n\nContent of spec 2")


async def _authed_client_with_jobs(tmp_path) -> tuple[TestClient, DashboardChannel]:
    config_path = tmp_path / "config.json"
    workspace = tmp_path / "ws"
    _write_config(config_path, workspace, ["test-key"])
    _create_jobs_db(workspace)
    channel = _make_channel(config_path, workspace)
    client = TestClient(TestServer(channel._build_app()))
    return client, channel


@pytest.mark.asyncio
async def test_jobs_list_endpoint(tmp_path) -> None:
    client, _ = await _authed_client_with_jobs(tmp_path)
    async with client:
        token = await _pair(client)
        headers = {"Authorization": f"Bearer {token}"}

        resp = await client.get("/api/jobs", headers=headers)
        assert resp.status == 200
        data = await resp.json()
        assert "jobs" in data
        jobs = data["jobs"]
        assert len(jobs) == 2
        # Sorted by id DESC
        assert jobs[0]["id"] == 2
        assert jobs[1]["id"] == 1

        # Check job 1 has last_event and event_count
        job1 = jobs[1]
        assert job1["title"] == "Test Job 1"
        assert job1["status"] == "completed"
        assert job1["event_count"] == 2
        assert job1["last_event"] is not None
        assert job1["last_event"]["event_type"] == "completed"
        assert job1["last_event"]["level"] == "info"
        assert job1["last_event"]["message"] == "Job completed"

        # Check job 2
        job2 = jobs[0]
        assert job2["title"] == "Test Job 2"
        assert job2["status"] == "running"
        assert job2["event_count"] == 2
        assert job2["last_event"]["event_type"] == "launched"


@pytest.mark.asyncio
async def test_jobs_list_empty_when_db_missing(tmp_path) -> None:
    client, _ = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        headers = {"Authorization": f"Bearer {token}"}

        resp = await client.get("/api/jobs", headers=headers)
        assert resp.status == 200
        data = await resp.json()
        assert data["jobs"] == []


@pytest.mark.asyncio
async def test_jobs_detail_endpoint(tmp_path) -> None:
    client, _ = await _authed_client_with_jobs(tmp_path)
    async with client:
        token = await _pair(client)
        headers = {"Authorization": f"Bearer {token}"}

        resp = await client.get("/api/jobs/1", headers=headers)
        assert resp.status == 200
        data = await resp.json()
        assert "job" in data
        assert "events" in data
        assert "spec_text" in data
        assert "result_text" in data

        job = data["job"]
        assert job["id"] == 1
        assert job["title"] == "Test Job 1"

        events = data["events"]
        assert len(events) == 2
        # Newest first
        assert events[0]["event_type"] == "completed"
        assert events[1]["event_type"] == "created"
        assert events[0]["payload"] == {"detail": "done"}
        assert events[1]["payload"] is None

        assert data["spec_text"] == "# Spec 1\n\nContent of spec 1"
        assert data["result_text"] == "# Result 1\n\nContent of result 1"


@pytest.mark.asyncio
async def test_jobs_detail_404_for_unknown_id(tmp_path) -> None:
    client, _ = await _authed_client_with_jobs(tmp_path)
    async with client:
        token = await _pair(client)
        headers = {"Authorization": f"Bearer {token}"}

        resp = await client.get("/api/jobs/999", headers=headers)
        assert resp.status == 404
        data = await resp.json()
        assert data["error"] == "job not found"


@pytest.mark.asyncio
async def test_jobs_detail_404_for_invalid_id(tmp_path) -> None:
    client, _ = await _authed_client_with_jobs(tmp_path)
    async with client:
        token = await _pair(client)
        headers = {"Authorization": f"Bearer {token}"}

        resp = await client.get("/api/jobs/abc", headers=headers)
        assert resp.status == 404
        data = await resp.json()
        assert data["error"] == "job not found"


@pytest.mark.asyncio
async def test_jobs_detail_handles_missing_spec_result_files(tmp_path) -> None:
    # Create jobs DB but don't create spec/result files
    config_path = tmp_path / "config.json"
    workspace = tmp_path / "ws"
    _write_config(config_path, workspace, ["test-key"])
    jobs_dir = workspace / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    import sqlite3
    db_path = jobs_dir / "jobs.db"
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE jobs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            kind TEXT NOT NULL DEFAULT 'sdd',
            title TEXT NOT NULL,
            status TEXT NOT NULL,
            repo TEXT, model TEXT,
            spec_path TEXT, result_path TEXT,
            meta TEXT,
            created_at TEXT NOT NULL, updated_at TEXT NOT NULL, closed_at TEXT
        )
    """)
    conn.execute("""
        CREATE TABLE job_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            job_id INTEGER NOT NULL,
            ts TEXT NOT NULL,
            event_type TEXT NOT NULL,
            level TEXT NOT NULL DEFAULT 'info',
            message TEXT NOT NULL,
            payload TEXT
        )
    """)
    conn.execute(
        """
        INSERT INTO jobs (id, kind, title, status, repo, model, spec_path, result_path, meta,
                          created_at, updated_at, closed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """,
        (
            3,
            "sdd",
            "Test Job 3",
            "completed",
            "repo3",
            "model3",
            "jobs/specs/3.md",  # doesn't exist
            "jobs/results/3.md",  # doesn't exist
            '{"key": "value3"}',
            "2026-01-03T00:00:00Z",
            "2026-01-03T01:00:00Z",
            "2026-01-03T02:00:00Z",
        ),
    )
    conn.commit()
    conn.close()

    channel = _make_channel(config_path, workspace)
    client = TestClient(TestServer(channel._build_app()))
    async with client:
        token = await _pair(client)
        headers = {"Authorization": f"Bearer {token}"}

        resp = await client.get("/api/jobs/3", headers=headers)
        assert resp.status == 200
        data = await resp.json()
        assert data["spec_text"] is None
        assert data["result_text"] is None


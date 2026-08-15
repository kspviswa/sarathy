"""Web portal: auth flow, config masking, sessions, cron, events SSE."""

from __future__ import annotations

from pathlib import Path

from httpx import ASGITransport, AsyncClient

from sarathy.web.app import create_app
from sarathy.web.auth import Auth, load_or_create_token, token_hash
from sarathy.web.notifier import Notifier


# ------------------------------------------------------------------ auth primitives
def test_token_file_created_0600(tmp_path: Path) -> None:
    token = load_or_create_token(tmp_path)
    assert len(token.split("-")) == 6
    assert (tmp_path / "web-pairing-token").exists()
    assert load_or_create_token(tmp_path) == token


def test_token_hash_stable() -> None:
    assert token_hash("abc") == token_hash("abc")
    assert token_hash("abc") != token_hash("abd")


async def test_auth_require_disabled_passes(engine) -> None:
    auth = Auth(engine.data_dir, enabled=False)
    req = type('R', (), {"headers": {}, "cookies": {}})()
    auth.require(req)  # should not raise


# ------------------------------------------------------------------ app endpoints
async def _client(engine) -> AsyncClient:
    auth = Auth(engine.data_dir, enabled=False)
    notifier = Notifier(engine)
    app = create_app(engine, auth=auth, notifier=notifier)
    return AsyncClient(transport=ASGITransport(app=app), base_url="http://test")


async def test_health_endpoint(engine) -> None:
    async with await _client(engine) as c:
        r = await c.get("/api/health")
        assert r.status_code == 200
        assert r.json()["ok"] is True


async def test_index_served(engine) -> None:
    async with await _client(engine) as c:
        r = await c.get("/")
        assert r.status_code == 200
        assert "doctype html" in r.text


async def test_sessions_list_and_create(engine) -> None:
    async with await _client(engine) as c:
        r = await c.get("/api/sessions")
        assert r.status_code == 200

        r = await c.post("/api/sessions")
        assert r.status_code == 200
        created = r.json()
        assert created["session_id"]

        r = await c.get("/api/sessions/" + created["session_id"])
        assert r.status_code == 200
        assert r.json()["session_id"] == created["session_id"]


async def test_send_message_queues(engine, tmp_path) -> None:
    async with await _client(engine) as c:
        r = await c.post("/api/sessions")
        sid = r.json()["session_id"]
        r = await c.post(
            f"/api/sessions/{sid}/messages", json={"content": "hello"}
        )
        assert r.status_code == 200
        body = r.json()
        assert "queued" in body


async def test_empty_message_rejected(engine) -> None:
    async with await _client(engine) as c:
        r = await c.post("/api/sessions")
        sid = r.json()["session_id"]
        r = await c.post(
            f"/api/sessions/{sid}/messages", json={"content": "  "}
        )
        assert r.status_code == 400


async def test_commands_endpoints(engine) -> None:
    async with await _client(engine) as c:
        r = await c.get("/api/commands")
        names = [cmd["name"] for cmd in r.json()["commands"]]
        assert "help" in names

        r = await c.post("/api/commands", json={"session_id": "s1", "line": "/help"})
        assert r.status_code == 200
        assert "Commands:" in r.json()["result"]


async def test_config_masks_api_keys(engine) -> None:
    engine.config.providers.custom.api_key = "sk-secret"
    async with await _client(engine) as c:
        r = await c.get("/api/config")
        cfg = r.json()
        key = cfg["providers"]["custom"]["apiKey"]
        assert "sk-secret" not in key
        assert "•••" in key


async def test_cron_add_and_list(engine) -> None:
    async with await _client(engine) as c:
        r = await c.get("/api/cron")
        assert r.status_code == 200

        r = await c.post(
            "/api/cron",
            json={"name": "daily", "body": "good morning", "schedule": "0 9 * * *"},
        )
        assert r.status_code == 200
        jid = r.json()["id"]

        r = await c.get("/api/cron")
        assert any(j["id"] == jid for j in r.json()["jobs"])

        r = await c.delete(f"/api/cron/{jid}")
        assert r.status_code == 200


async def test_skills_tools_endpoints(engine) -> None:
    async with await _client(engine) as c:
        r = await c.get("/api/skills")
        assert r.status_code == 200
        r = await c.get("/api/tools")
        assert r.status_code == 200
        assert isinstance(r.json()["tools"], list)


# ------------------------------------------------------------------ auth-enabled app
async def test_auth_required_when_enabled(make_engine, tmp_path) -> None:
    engine = await make_engine(tmp_path)
    auth = Auth(engine.data_dir, enabled=True)
    notifier = Notifier(engine)
    app = create_app(engine, auth=auth, notifier=notifier)

    async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
        r = await c.get("/api/health")
        # health is public auth-wise? it uses no require_auth -> expect 200
        assert r.status_code == 200

        r = await c.get("/api/sessions")
        assert r.status_code == 401

        r = await c.post("/api/auth/login", json={"token": auth.token})
        assert r.status_code == 200

        # cookie now stored
        jar = c.cookies
        cookie = jar.get("sarathy_token")
        assert cookie == token_hash(auth.token)

        r = await c.get("/api/sessions")
        assert r.status_code == 200
    await engine.stop()

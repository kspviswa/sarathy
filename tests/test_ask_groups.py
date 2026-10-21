"""Tests for the Ask thread GROUPS (job 151 §A).

The Ask history job 150 delivered is a FLAT list. The groups are the named
buckets the history is sorted into — Uttaram calls them projects, and this
store follows the same rules:

* a group holds threads, and a thread may be moved between groups;
* a thread that belongs to no group is UNCATEGORIZED;
* deleting a group does NOT delete its threads — it clears their group and
  they fall back to uncategorized, turns and all.

The migration matters as much as the endpoints: the live database already
holds real threads, so the `group_id` column is added only when it is
missing, and every thread that is already there lands in NULL.
"""

from __future__ import annotations

import sqlite3
from pathlib import Path

import pytest
from aiohttp.test_utils import TestClient, TestServer

from sarathy.bus.queue import MessageBus
from sarathy.channels.dashboard.ask_store import AskStore
from sarathy.channels.dashboard.server import DashboardChannel
from sarathy.config.loader import save_config
from sarathy.config.schema import Config

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _write_config(config_path: Path, workspace: Path, backend_url: str) -> None:
    cfg = Config()
    cfg.channels.dashboard.enabled = True
    cfg.channels.dashboard.pairing_keys = ["test-key"]
    cfg.agents.defaults.workspace = str(workspace)
    cfg.ask.backend_url = backend_url
    save_config(cfg, config_path)


def _make_channel(config_path: Path, workspace: Path) -> DashboardChannel:
    cfg = Config()
    cfg.channels.dashboard.enabled = True
    cfg.channels.dashboard.pairing_keys = ["test-key"]
    cfg.agents.defaults.workspace = str(workspace)
    return DashboardChannel(
        cfg.channels.dashboard,
        MessageBus(),
        config_path=config_path,
        devices_path=config_path.parent / "devices.json",
    )


async def _pair(client: TestClient) -> str:
    resp = await client.post(
        "/api/auth/pair", json={"key": "test-key", "deviceName": "iphone"}
    )
    assert resp.status == 200
    return (await resp.json())["token"]


async def _authed_client(tmp_path, backend_url: str = "http://127.0.0.1:7777") -> TestClient:
    config_path = tmp_path / "config.json"
    workspace = tmp_path / "ws"
    _write_config(config_path, workspace, backend_url)
    channel = _make_channel(config_path, workspace)
    return TestClient(TestServer(channel._build_app()))


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _turn(thread_id: str = "turn-1", query: str = "capital of France?") -> dict:
    return {
        "id": thread_id,
        "query": query,
        "answer": "Paris is the capital of France",
        "mode": "speed",
        "sources": ["web"],
        "sourcesList": [{"idx": 1, "title": "One", "url": "https://x.test/1", "domain": "x.test"}],
        "steps": [{"kind": "searching", "queries": ["capital of France"]}],
        "createdAt": 1_700_000_000_000,
    }


# ---------------------------------------------------------------------------
# The store
# ---------------------------------------------------------------------------


class TestAskGroupStore:
    def test_a_new_store_has_no_groups(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        assert store.list_groups() == []

    def test_a_group_is_created_with_its_name(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        group = store.create_group("Work", "the work ones")
        assert group["name"] == "Work"
        assert group["description"] == "the work ones"
        assert group["threadCount"] == 0
        assert group["id"]

    def test_the_group_list_is_newest_first(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        first = store.create_group("first")
        second = store.create_group("second")
        third = store.create_group("third")

        groups = store.list_groups()
        assert [group["id"] for group in groups] == [third["id"], second["id"], first["id"]]

    def test_a_group_is_renamed(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        group = store.create_group("Work")

        renamed = store.update_group(group["id"], name="Play")
        assert renamed is not None
        assert renamed["name"] == "Play"
        assert renamed["description"] == ""

    def test_a_blank_name_keeps_the_name_the_group_has(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        group = store.create_group("Work")

        renamed = store.update_group(group["id"], name="   ")
        assert renamed is not None
        assert renamed["name"] == "Work"

    def test_an_unknown_group_reads_as_none(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        assert store.get_group("nope") is None
        assert store.update_group("nope", name="x") is None
        assert store.delete_group("nope") is False

    def test_a_group_counts_the_threads_it_holds(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        group = store.create_group("Work")
        store.create_thread(title="one", thread_id="t1", group_id=group["id"])
        store.create_thread(title="two", thread_id="t2", group_id=group["id"])
        store.create_thread(title="three", thread_id="t3")

        groups = store.list_groups()
        assert groups[0]["threadCount"] == 2

    def test_a_thread_is_born_inside_a_group(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        group = store.create_group("Work")

        thread = store.create_thread(title="Capital of France?", thread_id="t1", group_id=group["id"])
        assert thread["groupId"] == group["id"]
        assert store.list_threads()[0]["groupId"] == group["id"]

    def test_a_thread_is_moved_between_groups(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        work = store.create_group("Work")
        play = store.create_group("Play")
        store.create_thread(title="Capital of France?", thread_id="t1")

        moved = store.move_thread("t1", work["id"])
        assert moved is not None
        assert moved["groupId"] == work["id"]

        moved = store.move_thread("t1", play["id"])
        assert moved is not None
        assert moved["groupId"] == play["id"]

        moved = store.move_thread("t1", None)
        assert moved is not None
        assert moved["groupId"] is None

    def test_moving_an_unknown_thread_reads_as_none(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        assert store.move_thread("nope", None) is None

    def test_deleting_a_group_leaves_its_threads_and_turns(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        group = store.create_group("Work")
        store.create_thread(title="Capital of France?", thread_id="t1", turns=[_turn()], group_id=group["id"])

        assert store.delete_group(group["id"]) is True

        # The group is gone...
        assert store.get_group(group["id"]) is None
        # ...the thread survives, uncategorized...
        stored = store.get_thread("t1")
        assert stored is not None
        assert stored["thread"]["groupId"] is None
        # ...and so do its turns.
        assert len(stored["turns"]) == 1
        assert stored["turns"][0]["answer"] == "Paris is the capital of France"

    def test_the_list_can_be_narrowed_to_one_group(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        work = store.create_group("Work")
        store.create_thread(title="one", thread_id="t1", group_id=work["id"])
        store.create_thread(title="two", thread_id="t2")

        assert [thread["id"] for thread in store.list_threads(group_id=work["id"])] == ["t1"]
        assert [thread["id"] for thread in store.list_threads(uncategorized=True)] == ["t2"]
        assert len(store.list_threads()) == 2

    def test_a_thread_saved_again_keeps_the_group_it_is_in(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        group = store.create_group("Work")
        store.create_thread(title="one", thread_id="t1", group_id=group["id"])

        # The one-time migration of the browser's history re-saves the thread
        # WITHOUT a group — it must not unfile it.
        store.create_thread(title="one", thread_id="t1")
        assert store.list_threads()[0]["groupId"] == group["id"]


# ---------------------------------------------------------------------------
# The migration — the live database already holds real threads
# ---------------------------------------------------------------------------


class TestAskGroupMigration:
    def _old_database(self, path: Path) -> None:
        """A database written by the build BEFORE groups existed."""
        conn = sqlite3.connect(str(path))
        try:
            conn.executescript(
                """
                CREATE TABLE ask_threads (
                  id         TEXT PRIMARY KEY,
                  title      TEXT NOT NULL DEFAULT '',
                  created_at TEXT NOT NULL,
                  updated_at TEXT NOT NULL
                );
                CREATE TABLE ask_turns (
                  id           TEXT PRIMARY KEY,
                  thread_id    TEXT NOT NULL,
                  seq          INTEGER NOT NULL,
                  query        TEXT NOT NULL,
                  answer       TEXT NOT NULL DEFAULT '',
                  steps_json   TEXT NOT NULL DEFAULT '[]',
                  sources_json TEXT NOT NULL DEFAULT '[]',
                  media_json   TEXT NOT NULL DEFAULT '[]',
                  created_at   TEXT NOT NULL,
                  meta_json    TEXT NOT NULL DEFAULT '{}',
                  FOREIGN KEY (thread_id) REFERENCES ask_threads (id) ON DELETE CASCADE
                );
                """
            )
            conn.execute(
                "INSERT INTO ask_threads (id, title, created_at, updated_at)"
                " VALUES ('t1', 'Capital of France?', '2026-01-01T00:00:00+00:00',"
                " '2026-01-01T00:00:00+00:00')"
            )
            conn.execute(
                "INSERT INTO ask_turns (id, thread_id, seq, query, answer, created_at)"
                " VALUES ('turn-1', 't1', 0, 'capital of France?', 'Paris', '2026-01-01T00:00:00+00:00')"
            )
            conn.commit()
        finally:
            conn.close()

    def test_the_column_is_added_to_a_database_that_already_has_threads(self, tmp_path) -> None:
        path = tmp_path / "ask" / "threads.db"
        path.parent.mkdir(parents=True, exist_ok=True)
        self._old_database(path)

        AskStore(path)

        conn = sqlite3.connect(str(path))
        try:
            columns = {row[1] for row in conn.execute("PRAGMA table_info(ask_threads);")}
        finally:
            conn.close()
        assert "group_id" in columns

    def test_the_threads_that_were_already_there_are_uncategorized(self, tmp_path) -> None:
        path = tmp_path / "ask" / "threads.db"
        path.parent.mkdir(parents=True, exist_ok=True)
        self._old_database(path)

        store = AskStore(path)

        threads = store.list_threads()
        assert [thread["id"] for thread in threads] == ["t1"]
        assert threads[0]["groupId"] is None
        assert threads[0]["title"] == "Capital of France?"
        # The turn came through the migration untouched.
        stored = store.get_thread("t1")
        assert stored is not None
        assert len(stored["turns"]) == 1
        assert stored["turns"][0]["answer"] == "Paris"

    def test_the_migration_is_idempotent(self, tmp_path) -> None:
        path = tmp_path / "ask" / "threads.db"
        path.parent.mkdir(parents=True, exist_ok=True)
        self._old_database(path)

        AskStore(path)
        store = AskStore(path)

        assert [thread["id"] for thread in store.list_threads()] == ["t1"]
        assert store.list_groups() == []

    def test_the_schema_version_is_bumped(self, tmp_path) -> None:
        path = tmp_path / "ask" / "threads.db"
        path.parent.mkdir(parents=True, exist_ok=True)
        self._old_database(path)

        AskStore(path)

        conn = sqlite3.connect(str(path))
        try:
            version = conn.execute("PRAGMA user_version;").fetchone()[0]
        finally:
            conn.close()
        assert version >= 2


# ---------------------------------------------------------------------------
# The endpoints
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_the_group_list_starts_empty(tmp_path) -> None:
    client = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        resp = await client.get("/api/ask/groups", headers=_auth(token))
        assert resp.status == 200
        assert await resp.json() == {"groups": []}


@pytest.mark.asyncio
async def test_a_group_is_created_and_listed(tmp_path) -> None:
    client = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        resp = await client.post(
            "/api/ask/groups", json={"name": "Work", "description": "the work ones"}, headers=_auth(token)
        )
        assert resp.status == 201
        body = await resp.json()
        assert body["group"]["name"] == "Work"
        assert body["group"]["description"] == "the work ones"
        assert body["group"]["threadCount"] == 0
        group_id = body["group"]["id"]

        resp = await client.get("/api/ask/groups", headers=_auth(token))
        groups = (await resp.json())["groups"]
        assert len(groups) == 1
        assert groups[0]["id"] == group_id


@pytest.mark.asyncio
async def test_a_group_with_no_name_is_a_400(tmp_path) -> None:
    client = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        resp = await client.post("/api/ask/groups", json={"name": "   "}, headers=_auth(token))
        assert resp.status == 400
        body = await resp.json()
        assert body["error"]
        assert body["code"]

        # No group was created.
        resp = await client.get("/api/ask/groups", headers=_auth(token))
        assert (await resp.json())["groups"] == []


@pytest.mark.asyncio
async def test_a_group_is_renamed(tmp_path) -> None:
    client = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        resp = await client.post("/api/ask/groups", json={"name": "Work"}, headers=_auth(token))
        group_id = (await resp.json())["group"]["id"]

        resp = await client.patch(
            f"/api/ask/groups/{group_id}", json={"name": "Play"}, headers=_auth(token)
        )
        assert resp.status == 200
        assert (await resp.json())["group"]["name"] == "Play"


@pytest.mark.asyncio
async def test_one_group_is_read_back(tmp_path) -> None:
    client = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        resp = await client.post("/api/ask/groups", json={"name": "Work"}, headers=_auth(token))
        group_id = (await resp.json())["group"]["id"]

        resp = await client.get(f"/api/ask/groups/{group_id}", headers=_auth(token))
        assert resp.status == 200
        assert (await resp.json())["group"]["name"] == "Work"

        # A group that is not there is a 404.
        resp = await client.get("/api/ask/groups/nope", headers=_auth(token))
        assert resp.status == 404


@pytest.mark.asyncio
async def test_an_unknown_group_is_a_404(tmp_path) -> None:
    client = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        resp = await client.patch(
            "/api/ask/groups/nope", json={"name": "Play"}, headers=_auth(token)
        )
        assert resp.status == 404
        body = await resp.json()
        assert body["error"]
        assert body["code"]

        resp = await client.delete("/api/ask/groups/nope", headers=_auth(token))
        assert resp.status == 404


@pytest.mark.asyncio
async def test_a_group_is_deleted_and_its_threads_survive(tmp_path) -> None:
    client = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        resp = await client.post("/api/ask/groups", json={"name": "Work"}, headers=_auth(token))
        group_id = (await resp.json())["group"]["id"]
        await client.post(
            "/api/ask/threads",
            json={"id": "t1", "turns": [_turn()], "groupId": group_id},
            headers=_auth(token),
        )

        resp = await client.delete(f"/api/ask/groups/{group_id}", headers=_auth(token))
        assert resp.status == 200

        # The group is gone...
        resp = await client.get("/api/ask/groups", headers=_auth(token))
        assert (await resp.json())["groups"] == []
        # ...the thread is not: it fell back to uncategorized, turns and all.
        resp = await client.get("/api/ask/threads/t1", headers=_auth(token))
        assert resp.status == 200
        detail = await resp.json()
        assert detail["thread"]["groupId"] is None
        assert len(detail["turns"]) == 1
        assert detail["turns"][0]["answer"] == "Paris is the capital of France"


@pytest.mark.asyncio
async def test_a_thread_is_born_inside_a_group(tmp_path) -> None:
    client = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        resp = await client.post("/api/ask/groups", json={"name": "Work"}, headers=_auth(token))
        group_id = (await resp.json())["group"]["id"]

        resp = await client.post(
            "/api/ask/threads",
            json={"id": "t1", "turns": [_turn()], "groupId": group_id},
            headers=_auth(token),
        )
        assert resp.status == 201
        assert (await resp.json())["thread"]["groupId"] == group_id

        # The list carries the group of every row.
        resp = await client.get("/api/ask/threads", headers=_auth(token))
        threads = (await resp.json())["threads"]
        assert threads[0]["groupId"] == group_id

        # The group counts it.
        resp = await client.get("/api/ask/groups", headers=_auth(token))
        assert (await resp.json())["groups"][0]["threadCount"] == 1


@pytest.mark.asyncio
async def test_a_thread_in_no_group_reads_as_null(tmp_path) -> None:
    client = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        await client.post(
            "/api/ask/threads", json={"id": "t1", "turns": [_turn()]}, headers=_auth(token)
        )

        resp = await client.get("/api/ask/threads", headers=_auth(token))
        threads = (await resp.json())["threads"]
        assert threads[0]["groupId"] is None


@pytest.mark.asyncio
async def test_a_thread_is_moved_into_a_group_and_back(tmp_path) -> None:
    client = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        resp = await client.post("/api/ask/groups", json={"name": "Work"}, headers=_auth(token))
        group_id = (await resp.json())["group"]["id"]
        await client.post(
            "/api/ask/threads", json={"id": "t1", "turns": [_turn()]}, headers=_auth(token)
        )

        resp = await client.patch(
            "/api/ask/threads/t1", json={"groupId": group_id}, headers=_auth(token)
        )
        assert resp.status == 200
        assert (await resp.json())["thread"]["groupId"] == group_id

        resp = await client.get("/api/ask/threads", headers=_auth(token))
        assert (await resp.json())["threads"][0]["groupId"] == group_id

        # Back to uncategorized.
        resp = await client.patch(
            "/api/ask/threads/t1", json={"groupId": None}, headers=_auth(token)
        )
        assert resp.status == 200
        assert (await resp.json())["thread"]["groupId"] is None


@pytest.mark.asyncio
async def test_a_thread_moved_to_an_unknown_group_is_a_400(tmp_path) -> None:
    client = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        await client.post(
            "/api/ask/threads", json={"id": "t1", "turns": [_turn()]}, headers=_auth(token)
        )

        resp = await client.patch(
            "/api/ask/threads/t1", json={"groupId": "nope"}, headers=_auth(token)
        )
        assert resp.status == 400
        body = await resp.json()
        assert body["error"]
        assert body["code"]

        # The thread did not move.
        resp = await client.get("/api/ask/threads/t1", headers=_auth(token))
        assert (await resp.json())["thread"]["groupId"] is None


@pytest.mark.asyncio
async def test_an_unknown_thread_moved_is_a_404(tmp_path) -> None:
    client = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        resp = await client.patch(
            "/api/ask/threads/nope", json={"groupId": None}, headers=_auth(token)
        )
        assert resp.status == 404
        body = await resp.json()
        assert body["error"]
        assert body["code"]


@pytest.mark.asyncio
async def test_the_thread_list_can_be_filtered_by_group(tmp_path) -> None:
    client = await _authed_client(tmp_path)
    async with client:
        token = await _pair(client)
        resp = await client.post("/api/ask/groups", json={"name": "Work"}, headers=_auth(token))
        group_id = (await resp.json())["group"]["id"]
        await client.post(
            "/api/ask/threads",
            json={"id": "t1", "turns": [_turn()], "groupId": group_id},
            headers=_auth(token),
        )
        await client.post(
            "/api/ask/threads", json={"id": "t2", "turns": [_turn("turn-2")]}, headers=_auth(token)
        )

        resp = await client.get(f"/api/ask/threads?groupId={group_id}", headers=_auth(token))
        threads = (await resp.json())["threads"]
        assert [thread["id"] for thread in threads] == ["t1"]

        # The threads of no group are the uncategorized ones.
        resp = await client.get("/api/ask/threads?groupId=", headers=_auth(token))
        threads = (await resp.json())["threads"]
        assert [thread["id"] for thread in threads] == ["t2"]

        # No filter at all: every thread.
        resp = await client.get("/api/ask/threads", headers=_auth(token))
        assert len((await resp.json())["threads"]) == 2


@pytest.mark.asyncio
async def test_the_group_endpoints_need_auth(tmp_path) -> None:
    client = await _authed_client(tmp_path)
    async with client:
        assert (await client.get("/api/ask/groups")).status == 401
        assert (await client.post("/api/ask/groups", json={"name": "Work"})).status == 401
        assert (await client.get("/api/ask/groups/g1")).status == 401
        assert (await client.patch("/api/ask/groups/g1", json={"name": "Work"})).status == 401
        assert (await client.delete("/api/ask/groups/g1")).status == 401


@pytest.mark.asyncio
async def test_the_group_endpoints_404_when_ask_is_disabled(tmp_path) -> None:
    config_path = tmp_path / "config.json"
    workspace = tmp_path / "ws"
    cfg = Config()
    cfg.channels.dashboard.enabled = True
    cfg.channels.dashboard.pairing_keys = ["test-key"]
    cfg.agents.defaults.workspace = str(workspace)
    cfg.ask.backend_url = "http://127.0.0.1:7777"
    cfg.ask.enabled = False
    save_config(cfg, config_path)
    channel = _make_channel(config_path, workspace)
    client = TestClient(TestServer(channel._build_app()))
    async with client:
        token = await _pair(client)
        assert (await client.get("/api/ask/groups", headers=_auth(token))).status == 404
        assert (
            await client.post("/api/ask/groups", json={"name": "Work"}, headers=_auth(token))
        ).status == 404
        assert (
            await client.get("/api/ask/groups/g1", headers=_auth(token))
        ).status == 404
        assert (
            await client.patch("/api/ask/groups/g1", json={"name": "Work"}, headers=_auth(token))
        ).status == 404
        assert (await client.delete("/api/ask/groups/g1", headers=_auth(token))).status == 404
        # The thread move is gone too.
        assert (
            await client.patch("/api/ask/threads/t1", json={"groupId": None}, headers=_auth(token))
        ).status == 404

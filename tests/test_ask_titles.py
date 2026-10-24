"""Tests for the LLM-authored Ask thread title (spec 162).

The title of a thread used to be its first question, clipped. It is now the
name the ANSWERING LLM gives it, delivered as a `title` frame while the answer
is still streaming. These tests pin both halves of that contract:

- the gateway folds the frame into the accumulator and names the thread with
  it (never overwriting a title that already exists);
- the PATCH endpoint can rename a thread, move it, or do both at once;
- a stream that carries the frame stores the LLM title, not the question.
"""

from __future__ import annotations

import pytest
from aiohttp.test_utils import TestClient

from sarathy.channels.dashboard.ask_store import AskStore, AskTurnAccumulator

from tests.test_ask_threads import (  # noqa: F401 — the shared fixtures
    DONE_FRAMES,
    FakeUpstream,
    _auth,
    _authed_client,
    _pair,
    _turn,
)

TITLE_FRAME = '{"type":"title","data":{"title":"Capital of France"}}\n'


# ---------------------------------------------------------------------------
# The accumulator folds the frame
# ---------------------------------------------------------------------------


class TestTitleFrame:
    def test_the_title_frame_is_remembered(self) -> None:
        acc = AskTurnAccumulator()
        acc.feed({"type": "title", "data": {"title": "Capital of France"}})
        assert acc.title == "Capital of France"

    def test_the_title_is_whitespace_collapsed(self) -> None:
        acc = AskTurnAccumulator()
        acc.feed({"type": "title", "data": {"title": "  Capital   of \n France "}})
        assert acc.title == "Capital of France"

    def test_a_second_title_frame_does_not_override_the_first(self) -> None:
        acc = AskTurnAccumulator()
        acc.feed({"type": "title", "data": {"title": "First"}})
        acc.feed({"type": "title", "data": {"title": "Second"}})
        assert acc.title == "First"

    def test_an_empty_title_is_ignored(self) -> None:
        acc = AskTurnAccumulator()
        acc.feed({"type": "title", "data": {"title": "   "}})
        assert acc.title == ""

    def test_a_non_string_title_is_ignored(self) -> None:
        acc = AskTurnAccumulator()
        acc.feed({"type": "title", "data": {"title": 42}})
        assert acc.title == ""

    def test_a_long_title_is_clipped(self) -> None:
        acc = AskTurnAccumulator()
        acc.feed({"type": "title", "data": {"title": "x" * 200}})
        assert len(acc.title) <= 80

    def test_the_title_never_enters_the_answer(self) -> None:
        acc = AskTurnAccumulator()
        acc.feed({"type": "title", "data": {"title": "Capital of France"}})
        acc.feed({"type": "response", "data": "Paris."})
        assert acc.answer == "Paris."


# ---------------------------------------------------------------------------
# The store names the thread from the title
# ---------------------------------------------------------------------------


class TestTitlePersistence:
    def test_a_new_thread_takes_the_llm_title(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        store.add_turn("t1", _turn(), title="Capital of France")

        stored = store.get_thread("t1")
        assert stored is not None
        assert stored["thread"]["title"] == "Capital of France"

    def test_an_empty_title_falls_back_to_the_query(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        store.add_turn("t1", _turn(), title="")

        stored = store.get_thread("t1")
        assert stored is not None
        assert stored["thread"]["title"] == "capital of France?"

    def test_an_existing_title_is_never_overwritten(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        store.add_turn("t1", _turn(), title="Capital of France")
        store.add_turn("t1", _turn("turn-2", "and its population?"), title="Something Else")

        stored = store.get_thread("t1")
        assert stored is not None
        assert stored["thread"]["title"] == "Capital of France"

    def test_a_group_born_empty_thread_takes_the_llm_title(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        store.create_thread(title="", thread_id="t1", group_id=None)
        store.add_turn("t1", _turn(), title="Capital of France")

        stored = store.get_thread("t1")
        assert stored is not None
        assert stored["thread"]["title"] == "Capital of France"

    def test_rename_thread_applies_the_given_title(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        store.add_turn("t1", _turn())
        renamed = store.rename_thread("t1", "  Capital   of France ")

        assert renamed is not None
        assert renamed["title"] == "Capital of France"

    def test_rename_of_an_unknown_thread_is_none(self, tmp_path) -> None:
        store = AskStore(tmp_path / "ask" / "threads.db")
        assert store.rename_thread("nope", "Whatever") is None


# ---------------------------------------------------------------------------
# The PATCH endpoint — rename, move, or both
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_patch_renames_a_thread(tmp_path) -> None:
    client: TestClient = await _authed_client(tmp_path, "http://127.0.0.1:7777")
    async with client:
        token = await _pair(client)
        await client.post(
            "/api/ask/threads", json={"id": "t1", "turns": [_turn()]}, headers=_auth(token)
        )

        resp = await client.patch(
            "/api/ask/threads/t1",
            json={"title": "Capital of France"},
            headers=_auth(token),
        )
        assert resp.status == 200
        assert (await resp.json())["thread"]["title"] == "Capital of France"

        # It is what history shows.
        resp = await client.get("/api/ask/threads/t1", headers=_auth(token))
        assert (await resp.json())["thread"]["title"] == "Capital of France"


@pytest.mark.asyncio
async def test_patch_still_moves_a_thread(tmp_path) -> None:
    client: TestClient = await _authed_client(tmp_path, "http://127.0.0.1:7777")
    async with client:
        token = await _pair(client)
        resp = await client.post(
            "/api/ask/groups", json={"name": "Work"}, headers=_auth(token)
        )
        group_id = (await resp.json())["group"]["id"]
        await client.post(
            "/api/ask/threads", json={"id": "t1", "turns": [_turn()]}, headers=_auth(token)
        )

        resp = await client.patch(
            "/api/ask/threads/t1", json={"groupId": group_id}, headers=_auth(token)
        )
        assert resp.status == 200
        assert (await resp.json())["thread"]["groupId"] == group_id


@pytest.mark.asyncio
async def test_patch_renames_and_moves_in_one_body(tmp_path) -> None:
    client: TestClient = await _authed_client(tmp_path, "http://127.0.0.1:7777")
    async with client:
        token = await _pair(client)
        resp = await client.post(
            "/api/ask/groups", json={"name": "Work"}, headers=_auth(token)
        )
        group_id = (await resp.json())["group"]["id"]
        await client.post(
            "/api/ask/threads", json={"id": "t1", "turns": [_turn()]}, headers=_auth(token)
        )

        resp = await client.patch(
            "/api/ask/threads/t1",
            json={"title": "Capital of France", "groupId": group_id},
            headers=_auth(token),
        )
        assert resp.status == 200
        thread = (await resp.json())["thread"]
        assert thread["title"] == "Capital of France"
        assert thread["groupId"] == group_id


@pytest.mark.asyncio
async def test_patch_of_an_unknown_thread_is_a_404(tmp_path) -> None:
    client: TestClient = await _authed_client(tmp_path, "http://127.0.0.1:7777")
    async with client:
        token = await _pair(client)
        resp = await client.patch(
            "/api/ask/threads/nope", json={"title": "Whatever"}, headers=_auth(token)
        )
        assert resp.status == 404


# ---------------------------------------------------------------------------
# The whole path: a stream that carries the title frame
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_a_stream_with_a_title_frame_names_the_thread(tmp_path) -> None:
    frames = [TITLE_FRAME] + DONE_FRAMES
    upstream = FakeUpstream(frames)
    backend_url = await upstream.start()
    try:
        client = await _authed_client(tmp_path, backend_url)
        async with client:
            token = await _pair(client)
            resp = await client.post(
                "/api/ask",
                json={
                    "query": "what is the capital of France?",
                    "mode": "speed",
                    "sources": ["web"],
                    "thread_id": "t1",
                    "turn_id": "turn-1",
                },
                headers=_auth(token),
            )
            assert resp.status == 200
            await resp.text()

            resp = await client.get("/api/ask/threads/t1", headers=_auth(token))
            detail = await resp.json()
            # The LLM title, NOT the question.
            assert detail["thread"]["title"] == "Capital of France"
            # The title never leaks into the answer.
            assert detail["turns"][0]["answer"] == "Paris is the capital of France"
    finally:
        await upstream.stop()


@pytest.mark.asyncio
async def test_a_follow_up_turn_keeps_the_title(tmp_path) -> None:
    upstream = FakeUpstream([TITLE_FRAME] + DONE_FRAMES)
    backend_url = await upstream.start()
    try:
        client = await _authed_client(tmp_path, backend_url)
        async with client:
            token = await _pair(client)
            resp = await client.post(
                "/api/ask",
                json={
                    "query": "what is the capital of France?",
                    "thread_id": "t1",
                    "turn_id": "turn-1",
                },
                headers=_auth(token),
            )
            await resp.text()

            # The follow-up carries no title frame — the title must not change.
            upstream.frames = DONE_FRAMES
            resp = await client.post(
                "/api/ask",
                json={
                    "query": "and its population?",
                    "thread_id": "t1",
                    "turn_id": "turn-2",
                },
                headers=_auth(token),
            )
            await resp.text()

            resp = await client.get("/api/ask/threads/t1", headers=_auth(token))
            detail = await resp.json()
            assert detail["thread"]["title"] == "Capital of France"
            assert detail["thread"]["turnCount"] == 2
    finally:
        await upstream.stop()

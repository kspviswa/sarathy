"""Spec 128 — dashboard device management + per-device notification outbox.

Two concerns:
  * §A — the paired-device API (`GET /api/devices`, `DELETE /api/devices/{id}`)
    and the registry helpers backing the CLI prune.
  * §C — the per-device notification outbox (park / replay / ack) that replaces
    the single global backlog with a durable, cursor-tracked inbox per device.

The legacy cold-start backlog and the notification frame contract are pinned by
``test_restart_notify_126.py``; these tests only add the new per-device behavior.
"""

from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest
from aiohttp.test_utils import TestClient, TestServer

from sarathy.bus.queue import MessageBus
from sarathy.channels.dashboard.auth import DeviceRegistry
from sarathy.channels.dashboard.server import DashboardChannel
from sarathy.config.loader import save_config
from sarathy.config.schema import Config


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
    return DashboardChannel(
        cfg.channels.dashboard,
        MessageBus(),
        config_path=config_path,
        devices_path=config_path.parent / "devices.json",
    )


def _channel_with_device(tmp_path) -> tuple[DashboardChannel, str, str]:
    """A channel with one paired device; returns (channel, token, device_id)."""
    config_path = tmp_path / "config.json"
    _write_config(config_path, tmp_path / "ws", ["test-key"])
    ch = _make_channel(config_path, tmp_path / "ws")
    token, device_id = ch._registry.register("test-key", "phone")
    return ch, token, device_id


def _fake_ws() -> MagicMock:
    ws = MagicMock()
    ws.send_str = AsyncMock()
    return ws


def _sent(ws: MagicMock) -> list[dict]:
    return [json.loads(c[0][0]) for c in ws.send_str.await_args_list]


# ---------------------------------------------------------------------------
# §A.3 — registry helpers (secrets stripped, prune is explicit + non-integrated)
# ---------------------------------------------------------------------------


class TestDeviceRegistrySurface:
    def test_list_devices_strips_secrets(self, tmp_path) -> None:
        reg = DeviceRegistry(tmp_path / "devices.json")
        token, device_id = reg.register("key1", "phone")
        assert token  # registered, so a secret exists on disk

        devices = reg.list_devices()
        assert len(devices) == 1
        entry = devices[0]
        assert entry["id"] == device_id
        assert entry["name"] == "phone"
        for secret in ("token_hash", "key_fingerprint", "token"):
            assert secret not in entry
        # Bare hashing is one-way, but prove the raw store still holds it.
        raw = json.loads((tmp_path / "devices.json").read_text())
        assert raw[device_id]["token_hash"]

    def test_stale_devices_is_a_dry_run_and_prune_removes_only_stale(self, tmp_path) -> None:
        reg = DeviceRegistry(tmp_path / "devices.json")
        _, old = reg.register("key1", "old")
        fresh_token, fresh = reg.register("key1", "fresh")
        reg._devices[old]["last_seen"] = 1
        reg._devices[fresh]["last_seen"] = 2**31
        reg.save()

        stale = reg.stale_devices(older_than_seconds=3600)
        assert [d["id"] for d in stale] == [old]
        assert len(reg.list_devices()) == 2  # dry run

        assert reg.prune_stale(older_than_seconds=3600) == 1
        assert {d["id"] for d in reg.list_devices()} == {fresh}
        assert reg.validate(fresh_token) == fresh

    def test_prune_honours_keep_ids(self, tmp_path) -> None:
        reg = DeviceRegistry(tmp_path / "devices.json")
        _, keep = reg.register("key1", "keep")
        _, drop = reg.register("key1", "drop")
        reg._devices[keep]["last_seen"] = 1
        reg._devices[drop]["last_seen"] = 1
        reg.save()

        assert reg.prune_stale(older_than_seconds=3600, keep_ids=[keep]) == 1
        assert {d["id"] for d in reg.list_devices()} == {keep}


# ---------------------------------------------------------------------------
# §A.1/§A.2 — the device API
# ---------------------------------------------------------------------------


class TestDevicesApi:
    async def test_list_marks_current_and_strips_secrets(self, tmp_path) -> None:
        ch, token, device_id = _channel_with_device(tmp_path)
        ch._registry.register("test-key", "laptop")

        client = TestClient(TestServer(ch._build_app()))
        async with client:
            resp = await client.get(
                "/api/devices", headers={"Authorization": f"Bearer {token}"}
            )
            assert resp.status == 200
            devices = (await resp.json())["devices"]
            assert len(devices) == 2
            current = [d for d in devices if d["current"]]
            assert [d["id"] for d in current] == [device_id]
            for d in devices:
                assert "token_hash" not in d
                assert "key_fingerprint" not in d
                assert set(d) == {
                    "id",
                    "name",
                    "shortId",
                    "createdAt",
                    "lastSeen",
                    "notificationsEnabled",
                    "current",
                }

    async def test_delete_unknown_device_is_404(self, tmp_path) -> None:
        ch, token, _ = _channel_with_device(tmp_path)
        client = TestClient(TestServer(ch._build_app()))
        async with client:
            resp = await client.delete(
                "/api/devices/does-not-exist",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status == 404

    async def test_revokes_another_device(self, tmp_path) -> None:
        ch, token, _ = _channel_with_device(tmp_path)
        _, other_id = ch._registry.register("test-key", "laptop")
        client = TestClient(TestServer(ch._build_app()))
        async with client:
            resp = await client.delete(
                f"/api/devices/{other_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status == 200
        assert other_id not in {d["id"] for d in ch._registry.list_devices()}

    async def test_current_device_needs_force(self, tmp_path) -> None:
        ch, token, device_id = _channel_with_device(tmp_path)
        client = TestClient(TestServer(ch._build_app()))
        async with client:
            headers = {"Authorization": f"Bearer {token}"}
            resp = await client.delete(f"/api/devices/{device_id}", headers=headers)
            assert resp.status == 409
            assert ch._registry.validate(token) == device_id  # untouched

            resp = await client.delete(f"/api/devices/{device_id}?force=1", headers=headers)
            assert resp.status == 200
        assert ch._registry.validate(token) is None

    async def test_revoking_clears_the_device_outbox(self, tmp_path) -> None:
        ch, token, _ = _channel_with_device(tmp_path)
        _, phone_id = ch._registry.register("test-key", "laptop")
        ch._notify_cursor[phone_id] = 0
        await ch.send_notification("hi", "there")
        assert ch._notify_inbox.get(phone_id)

        client = TestClient(TestServer(ch._build_app()))
        async with client:
            resp = await client.delete(
                f"/api/devices/{phone_id}",
                headers={"Authorization": f"Bearer {token}"},
            )
            assert resp.status == 200
        assert phone_id not in ch._notify_inbox
        assert phone_id not in ch._notify_cursor


# ---------------------------------------------------------------------------
# §C — per-device outbox
# ---------------------------------------------------------------------------


class TestPerDeviceOutbox:
    async def test_offline_known_device_parks_and_replays(self, tmp_path) -> None:
        ch, _, device_id = _channel_with_device(tmp_path)
        ch._notify_cursor[device_id] = 0  # device is "known"

        await ch.send_notification("Title", "Body", tab="jobs")
        assert list(ch._notify_inbox[device_id])  # parked

        ws = _fake_ws()
        await ch._replay_device_inbox(ws, device_id)
        frames = _sent(ws)
        assert len(frames) == 1
        assert frames[0]["type"] == "notification"
        assert frames[0]["seq"] == 1
        assert ch._notify_cursor[device_id] == 1
        assert not ch._notify_inbox.get(device_id)

    async def test_replay_since_respects_cursor(self, tmp_path) -> None:
        ch, _, device_id = _channel_with_device(tmp_path)
        ch._notify_cursor[device_id] = 0
        for i in range(3):
            await ch.send_notification(f"n{i}", "b")

        assert len(await ch.replay_since(device_id, 0)) == 3
        assert len(await ch.replay_since(device_id, 2)) == 1
        assert await ch.replay_since(device_id, 3) == []

    async def test_ack_advances_and_drops_delivered(self, tmp_path) -> None:
        ch, _, device_id = _channel_with_device(tmp_path)
        ch._notify_cursor[device_id] = 0
        for i in range(3):
            await ch.send_notification(f"n{i}", "b")

        await ch.ack(device_id, 2)
        assert ch._notify_cursor[device_id] == 2
        remaining = [json.loads(f)["seq"] for f in ch._notify_inbox.get(device_id, [])]
        assert remaining == [3]
        await ch.ack(device_id, 1)  # never moves backwards
        assert ch._notify_cursor[device_id] == 2

    async def test_live_socket_gets_frame_directly_without_parking(self, tmp_path) -> None:
        ch, _, device_id = _channel_with_device(tmp_path)
        ch._notify_cursor[device_id] = 0
        ws = _fake_ws()
        ch._ws_clients.add(ws)
        ch._ws_devices[ws] = device_id

        await ch.send_notification("Live", "ok")

        frames = _sent(ws)
        assert len(frames) == 1
        assert frames[0]["type"] == "notification"
        assert "seq" not in frames[0]  # live frames keep the 126 contract
        assert not ch._notify_inbox.get(device_id)

    async def test_outbox_survives_a_restart(self, tmp_path) -> None:
        outbox = tmp_path / "dashboard_outbox.json"
        ch1 = DashboardChannel(MagicMock(), MessageBus(), devices_path=tmp_path / "devices.json", outbox_path=outbox)
        _, device_id = ch1._registry.register("test-key", "phone")
        ch1._notify_cursor[device_id] = 0
        await ch1.send_notification("Boot", "ok")

        ch2 = DashboardChannel(MagicMock(), MessageBus(), devices_path=tmp_path / "devices.json", outbox_path=outbox)
        replayed = await ch2.replay_since(device_id, 0)
        assert len(replayed) == 1
        assert json.loads(replayed[0])["payload"]["title"] == "Boot"


# ---------------------------------------------------------------------------
# §C.4 — the real socket resolves its device and replays only its inbox
# ---------------------------------------------------------------------------


class TestOutboxOverRealSocket:
    async def test_parked_frame_replays_to_the_right_device_once(self, tmp_path) -> None:
        ch, token, device_id = _channel_with_device(tmp_path)
        # A second device exists but never connects.
        other_token, other_id = ch._registry.register("test-key", "laptop")
        ch._notify_cursor[device_id] = 0
        ch._notify_cursor[other_id] = 0

        # Notification raised while our device is offline → parked.
        await ch.send_notification("Boot", "restarted", tab="status")
        assert len(ch._notify_inbox[device_id]) == 1
        assert len(ch._notify_inbox[other_id]) == 1

        client = TestClient(TestServer(ch._build_app()))
        async with client:
            ws = await client.ws_connect(f"/ws?token={token}")
            snap = json.loads(await asyncio.wait_for(ws.receive_str(), timeout=5))
            assert snap["type"] == "snapshot"
            frame = json.loads(await asyncio.wait_for(ws.receive_str(), timeout=5))
            assert frame["type"] == "notification"
            assert frame["seq"] == 1
            assert frame["payload"]["title"] == "Boot"

            # The other device's inbox is untouched by our replay.
            assert len(ch._notify_inbox[other_id]) == 1

            # Reconnecting must NOT re-deliver our own frame.
            await ws.close()
            ws2 = await client.ws_connect(f"/ws?token={token}")
            assert (
                json.loads(await asyncio.wait_for(ws2.receive_str(), timeout=5))["type"]
                == "snapshot"
            )
            with pytest.raises(asyncio.TimeoutError):
                await asyncio.wait_for(ws2.receive_str(), timeout=1.0)
            await ws2.close()

    async def test_bad_token_is_rejected_without_reaching_the_handler(self, tmp_path) -> None:
        import aiohttp

        ch, _, _ = _channel_with_device(tmp_path)
        client = TestClient(TestServer(ch._build_app()))
        async with client:
            # The auth middleware 401s a missing/invalid token before the socket
            # upgrades — a bad client can never key itself to a device.
            with pytest.raises(aiohttp.WSServerHandshakeError):
                await client.ws_connect("/ws")
            with pytest.raises(aiohttp.WSServerHandshakeError):
                await client.ws_connect("/ws?token=bogus")

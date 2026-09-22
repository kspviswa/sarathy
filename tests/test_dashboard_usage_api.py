"""Tests for dashboard usage API endpoint."""

import asyncio
import json
import os
import tempfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from aiohttp import web
from aiohttp.test_utils import AioHTTPTestCase, unittest_run_loop

from sarathy.channels.dashboard.server import DashboardChannel
from sarathy.channels.dashboard.auth import DeviceRegistry
from sarathy.bus.queue import MessageBus


class TestUsageSummaryAPI(AioHTTPTestCase):
    """Test /api/usage/summary endpoint."""

    async def get_application(self):
        # Create a temporary config
        config = MagicMock()
        config.host = "127.0.0.1"
        config.port = 8080
        config.streaming = False
        config.pairing_keys = ["test-key-123"]
        config.allow_from = None

        # Create temporary paths
        self.temp_dir = tempfile.mkdtemp()
        config_path = Path(self.temp_dir) / "config.json"
        devices_path = Path(self.temp_dir) / "devices.json"

        # Mock config loader
        with patch("sarathy.channels.dashboard.server.DashboardChannel._load_full_config") as mock_load:
            mock_config = MagicMock()
            mock_config.get_provider_name.return_value = "test-provider"
            mock_config.agents.defaults.model = "test-model"
            mock_config.workspace_path = "/tmp/workspace"
            mock_config.channels.telegram = MagicMock(enabled=False)
            mock_config.channels.discord = MagicMock(enabled=False)
            mock_config.channels.email = MagicMock(enabled=False)
            mock_config.channels.dashboard = MagicMock(enabled=True, host="127.0.0.1", port=8080, streaming=False)
            mock_load.return_value = mock_config

            # Create a real device registry for testing auth
            self.registry = DeviceRegistry(devices_path)
            self.test_token, device_id = self.registry.register("test-key-123", "Test Device")

            # Create channel with mocked bus
            bus = MagicMock(spec=MessageBus)
            self.channel = DashboardChannel(
                config=config,
                bus=bus,
                session_manager=None,
                config_path=config_path,
                devices_path=devices_path,
                runtime=None,
            )

            # Don't actually start the server
            self.channel._running = False

            # Build the app
            app = self.channel._build_app()
            return app

    def setUp(self):
        super().setUp()
        # Set up test database
        self.db_fd, self.db_path = tempfile.mkstemp(suffix=".db")
        os.environ["SARATHY_USAGE_DB"] = self.db_path
        from sarathy.usage.store import reset_usage_store

        reset_usage_store()

    def tearDown(self):
        super().tearDown()
        os.close(self.db_fd)
        os.unlink(self.db_path)
        os.environ.pop("SARATHY_USAGE_DB", None)
        from sarathy.usage.store import reset_usage_store

        reset_usage_store()

    def _auth_headers(self):
        return {"Authorization": f"Bearer {self.test_token}"}

    @unittest_run_loop
    async def test_usage_summary_returns_shape(self):
        """Test /api/usage/summary returns the documented shape."""
        # First add some test data
        from sarathy.usage.store import get_usage_store

        store = get_usage_store()
        store.record(
            {
                "ts": "2026-09-21T03:41:00Z",
                "session_key": "test:1",
                "channel": "telegram",
                "model": "model-a",
                "provider": "openrouter",
                "prompt_tokens": 1000,
                "cached_tokens": 300,
                "completion_tokens": 200,
                "total_tokens": 1200,
                "duration_ms": 500,
                "finish_reason": "stop",
            }
        )

        resp = await self.client.request("GET", "/api/usage/summary", headers=self._auth_headers())
        assert resp.status == 200
        data = await resp.json()

        # Check shape
        assert "available" in data
        assert "window_days" in data
        assert "totals" in data
        assert "by_model" in data
        assert "timeseries" in data

        assert data["available"] is True
        assert data["window_days"] == 7
        assert data["totals"]["requests"] == 1
        assert data["totals"]["prompt_tokens"] == 1000
        assert data["totals"]["cached_tokens"] == 300
        assert data["totals"]["completion_tokens"] == 200
        assert data["totals"]["total_tokens"] == 1200
        assert data["totals"]["cache_hit_pct"] == 30.0

        assert len(data["by_model"]) == 1
        assert data["by_model"][0]["model"] == "model-a"
        assert data["by_model"][0]["cache_hit_pct"] == 30.0

        assert len(data["timeseries"]) == 1

    @unittest_run_loop
    async def test_usage_summary_days_clamp(self):
        """Test days parameter clamping (1..365)."""
        resp = await self.client.request("GET", "/api/usage/summary?days=0", headers=self._auth_headers())
        assert resp.status == 200
        data = await resp.json()
        assert data["window_days"] == 1

        resp = await self.client.request("GET", "/api/usage/summary?days=500", headers=self._auth_headers())
        assert resp.status == 200
        data = await resp.json()
        assert data["window_days"] == 365

        resp = await self.client.request("GET", "/api/usage/summary?days=abc", headers=self._auth_headers())
        assert resp.status == 200
        data = await resp.json()
        assert data["window_days"] == 7  # Default on bad value

    @unittest_run_loop
    async def test_usage_summary_empty_store(self):
        """Test empty store returns available: false with HTTP 200."""
        resp = await self.client.request("GET", "/api/usage/summary", headers=self._auth_headers())
        assert resp.status == 200
        data = await resp.json()

        assert data["available"] is False
        assert data["window_days"] == 7
        assert data["totals"]["requests"] == 0
        assert data["by_model"] == []
        assert data["timeseries"] == []

    @unittest_run_loop
    async def test_usage_summary_model_filter(self):
        """Test ?model= restricts totals/timeseries while by_model stays complete."""
        from sarathy.usage.store import get_usage_store

        store = get_usage_store()
        store.record(
            {"ts": "2026-09-21T03:41:00Z", "model": "model-a", "provider": "openrouter",
             "prompt_tokens": 1000, "cached_tokens": 300, "completion_tokens": 200, "total_tokens": 1200}
        )
        store.record(
            {"ts": "2026-09-21T03:42:00Z", "model": "model-b", "provider": "local",
             "prompt_tokens": 500, "cached_tokens": 100, "completion_tokens": 100, "total_tokens": 600}
        )

        resp = await self.client.request(
            "GET", "/api/usage/summary?model=model-a", headers=self._auth_headers()
        )
        assert resp.status == 200
        data = await resp.json()
        assert data["model"] == "model-a"
        assert data["totals"]["prompt_tokens"] == 1000
        assert data["totals"]["requests"] == 1
        # by_model lists both models so the filter dropdown stays populated
        assert len(data["by_model"]) == 2

    @unittest_run_loop
    async def test_usage_summary_auth_enforced(self):
        """Test auth is enforced like /api/status."""
        # Request without auth
        resp = await self.client.request("GET", "/api/usage/summary")
        assert resp.status == 401

        # Request with invalid token
        resp = await self.client.request("GET", "/api/usage/summary", headers={"Authorization": "Bearer invalid"})
        assert resp.status == 401


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
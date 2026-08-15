"""Shared fixtures for the sarathy v2 test suite."""

from __future__ import annotations

from pathlib import Path

import pytest
from tau_agent.messages import AssistantMessage, TextContent
from tau_agent.provider_events import AssistantDoneEvent

from sarathy.config.schema import Config


def make_config(workspace: Path, *, model: str = "test-model") -> Config:
    """Build a Config pointed at a temp workspace + local OpenAI-compatible provider."""
    config = Config()
    config.agents.defaults.workspace = str(workspace)
    config.agents.defaults.model = model
    config.agents.defaults.provider = "custom"
    config.providers.custom.api_key = "sk-test"
    config.providers.custom.api_base = "http://localhost:18000/v1"
    config.web.auth.enabled = False
    return config


def make_fake_streams(provider, *texts: str) -> None:
    """Arm a FakeProvider with one assistant stream per reply text."""
    provider._streams = [  # noqa: SLF001
        [
            AssistantDoneEvent(
                reason="stop",
                message=AssistantMessage(
                    role="assistant", content=[TextContent(text=t)]
                ),
            )
        ]
        for t in texts
    ]


@pytest.fixture
def make_engine():
    """Factory: build + start a SarathyEngine on a temp workspace.

    The provider is a FakeProvider (no network). Pass ``reply=`` to preload
    assistant streams for the next N turns.
    """

    async def _make(tmp_path, *, provider=None, reply: list[str] | None = None):
        from tau_ai.fake import FakeProvider

        from sarathy.engine.engine import SarathyEngine

        config = make_config(tmp_path / "ws")
        engine = SarathyEngine(config)
        fake = provider or FakeProvider(streams=[])
        if reply:
            make_fake_streams(fake, *reply)
        engine.provider = fake
        engine.provider_name = "fake"
        engine.archivist.provider = fake
        await engine.start()
        return engine

    return _make


@pytest.fixture
async def engine(make_engine, tmp_path):
    """A started (then stopped) SarathyEngine with a silent FakeProvider."""
    eng = await make_engine(tmp_path)
    yield eng
    await eng.stop()

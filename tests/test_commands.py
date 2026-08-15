"""Command registry builtins."""

from __future__ import annotations

import pytest

from sarathy.engine.commands import parse_command_line


def test_parse_command_line() -> None:
    assert parse_command_line("/help") == ("help", [])
    assert parse_command_line("  /status arg1 arg2 ") == ("status", ["arg1", "arg2"])
    assert parse_command_line("/model \"two words\"") == ("model", ["two words"])
    assert parse_command_line("plain message") is None


@pytest.mark.asyncio
async def test_handle_help(engine) -> None:
    result = await engine.commands.handle("s1", "/help")
    assert "Commands:" in result
    assert "help" in result


@pytest.mark.asyncio
async def test_handle_status(engine) -> None:
    result = await engine.commands.handle("s1", "/status")
    assert "model=" in result
    assert "provider=" in result


@pytest.mark.asyncio
async def test_handle_model(engine) -> None:
    result = await engine.commands.handle("s1", "/model")
    assert "test-model" in result


@pytest.mark.asyncio
async def test_handle_unknown(engine) -> None:
    result = await engine.commands.handle("s1", "/nope")
    assert "Unknown command /nope" in result


@pytest.mark.asyncio
async def test_not_a_command_returns_none(engine) -> None:
    assert await engine.commands.handle("s1", "hi there") is None


async def test_commands_registered(engine) -> None:
    names = engine.commands.names()
    for expected in ("help", "status", "sessions", "model", "config"):
        assert expected in names

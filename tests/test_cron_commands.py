"""CLI cron add/list/remove commands via Typer's CliRunner."""

from __future__ import annotations

from pathlib import Path

from typer.testing import CliRunner

from sarathy.cli.commands import app

runner = CliRunner()


def test_cron_add_rejects_invalid_timezone(tmp_path: Path) -> None:
    result = runner.invoke(
        app,
        [
            "cron",
            "add",
            "--name",
            "demo",
            "--message",
            "hello",
            "--cron",
            "0 9 * * *",
            "--tz",
            "America/Vancovuer",
        ],
    )

    assert result.exit_code == 1
    assert "unknown timezone 'America/Vancovuer'" in result.stdout


def test_cron_add_list(monkeypatch, tmp_path: Path) -> None:
    import sarathy.config.loader as loader
    from sarathy.utils.helpers import get_data_path

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    monkeypatch.setattr(get_data_path, "__call__", lambda: data_dir)
    monkeypatch.setattr(loader, "get_data_dir", lambda: data_dir)

    result = runner.invoke(
        app,
        [
            "cron", "add",
            "--name", "daily", "--message", "hello",
            "--cron", "0 9 * * *",
        ],
    )
    assert result.exit_code == 0
    assert "Added job" in result.stdout

    store = data_dir / "cron" / "jobs.json"
    assert store.exists()

    result = runner.invoke(app, ["cron", "list"])
    assert result.exit_code == 0
    assert "daily" in result.stdout

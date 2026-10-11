"""CLI commands for the dashboard channel.

Pairing keys are stored in config.json under ``channels.dashboard.pairingKeys``
(so they behave like any other setting and can be revoked/edited manually).
These commands are quick wrappers over load_config/save_config. Key changes are
honored immediately by a running gateway because the server validates keys
against the on-disk config; host/port/streaming/enabled changes require a
gateway restart.
"""

from __future__ import annotations

import secrets

import typer
from rich.console import Console
from rich.table import Table

from sarathy.config.loader import load_config, save_config
from sarathy.utils.helpers import ensure_dir

console = Console()

dashboard_app = typer.Typer(help="Manage the sarathy dashboard channel")


def _generate_key() -> str:
    """Generate a human-readable pairing key, e.g. 'sara-a1b2-3c4d-e5f6-7890'."""
    return "sara-" + "-".join(secrets.token_hex(2) for _ in range(4))


def _restart_hint() -> None:
    from sarathy.gateway.manager import is_gateway_running

    if is_gateway_running():
        console.print("[yellow]Gateway is running - run 'sarathy gateway restart' to apply.[/yellow]")
    else:
        console.print("[dim]Gateway not running - start it with 'sarathy gateway start'.[/dim]")


@dashboard_app.command("start")
def dashboard_start(
    restart: bool = typer.Option(
        False, "--restart", "-r", help="Restart the gateway automatically after enabling"
    ),
):
    """Enable the dashboard, create a pairing key, and save it to the workspace."""
    config = load_config()
    dc = config.channels.dashboard
    if not dc.pairing_keys:
        dc.pairing_keys.append(_generate_key())
    dc.enabled = True
    save_config(config)

    key = dc.pairing_keys[-1]
    workspace = ensure_dir(config.workspace_path)
    key_file = workspace / "dashboard_pairing.key"
    key_file.write_text(key + "\n", encoding="utf-8")

    console.print("[green]✓[/green] Dashboard enabled")
    console.print(f"  Pairing key saved to: [cyan]{key_file}[/cyan]")
    console.print(f"  Pairing key: [bold cyan]{key}[/bold cyan]")
    console.print(f"  URL: http://{dc.host or '0.0.0.0'}:{dc.port}/")

    from sarathy.gateway.manager import is_gateway_running

    if is_gateway_running():
        if restart:
            _do_gateway_restart()
        else:
            _restart_hint()
    else:
        console.print("[dim]Gateway not running - start it with 'sarathy gateway start'.[/dim]")


@dashboard_app.command("stop")
def dashboard_stop():
    """Disable the dashboard channel."""
    config = load_config()
    config.channels.dashboard.enabled = False
    save_config(config)
    console.print("[yellow]Dashboard disabled.[/yellow]")
    _restart_hint()


@dashboard_app.command("status")
def dashboard_status():
    """Show dashboard channel status."""
    config = load_config()
    dc = config.channels.dashboard

    from sarathy.gateway.manager import is_gateway_running, read_pid

    running = is_gateway_running()
    pid = read_pid()

    console.print("[bold]Dashboard Channel[/bold]")
    console.print(f"  Enabled: {'[green]✓[/green]' if dc.enabled else '[red]✗[/red]'}")
    console.print(f"  Bind: {dc.host}:{dc.port}")
    console.print(f"  Streaming: {'on' if dc.streaming else 'off'}")
    console.print(f"  Gateway running: {'yes (PID ' + str(pid) + ')' if running else 'no'}")

    if dc.pairing_keys:
        console.print("  Pairing keys:")
        for k in dc.pairing_keys:
            console.print(f"    [cyan]{k}[/cyan]")
    else:
        console.print("  Pairing keys: [dim]none - run 'sarathy dashboard start'[/dim]")


key_app = typer.Typer(help="Manage dashboard pairing keys")
dashboard_app.add_typer(key_app, name="key")


@key_app.command("add")
def dashboard_key_add():
    """Create a new pairing key (active immediately, no restart needed)."""
    config = load_config()
    key = _generate_key()
    config.channels.dashboard.pairing_keys.append(key)
    save_config(config)
    console.print(f"[green]✓[/green] Created key: [bold cyan]{key}[/bold cyan]")
    console.print("[dim]Active immediately - enter it in the dashboard to pair a device.[/dim]")


@key_app.command("list")
def dashboard_key_list():
    """List all dashboard pairing keys."""
    config = load_config()
    keys = config.channels.dashboard.pairing_keys

    if not keys:
        console.print("[dim]No pairing keys. Run 'sarathy dashboard key add'.[/dim]")
        return

    table = Table(title="Dashboard Pairing Keys")
    table.add_column("#", style="dim")
    table.add_column("Key", style="cyan")
    for i, k in enumerate(keys, 1):
        table.add_row(str(i), k)
    console.print(table)


@key_app.command("revoke")
def dashboard_key_revoke(
    key: str = typer.Argument(..., help="Pairing key to revoke"),
):
    """Revoke a pairing key (removes it and all devices paired with it)."""
    config = load_config()
    keys = config.channels.dashboard.pairing_keys

    if key not in keys:
        console.print(f"[red]Key not found: {key}[/red]")
        raise typer.Exit(1)

    config.channels.dashboard.pairing_keys = [k for k in keys if k != key]
    save_config(config)

    from sarathy.channels.dashboard.auth import DeviceRegistry

    removed = DeviceRegistry().revoke_by_key(key)
    console.print(f"[green]✓[/green] Revoked key: {key}")
    if removed:
        console.print(f"  Removed {removed} paired device(s).")
    console.print("[dim]Active immediately - devices using this key are logged out.[/dim]")


@key_app.command("delete")
def dashboard_key_delete(
    key: str = typer.Argument(..., help="Pairing key to delete"),
):
    """Alias for 'key revoke' - delete a pairing key."""
    dashboard_key_revoke(key)


devices_app = typer.Typer(help="Manage paired dashboard devices")
dashboard_app.add_typer(devices_app, name="devices")


_DURATION_UNITS = {"s": 1, "m": 60, "h": 60 * 60, "d": 60 * 60 * 24, "w": 60 * 60 * 24 * 7}


def _parse_duration(text: str) -> int:
    """Parse ``30d`` / ``12h`` / ``90m`` / ``3600`` into seconds."""
    text = (text or "").strip().lower()
    if not text:
        raise ValueError("empty duration")
    if text[-1] in _DURATION_UNITS:
        value, unit = text[:-1], text[-1]
        if not value.isdigit():
            raise ValueError(f"invalid duration: {text!r}")
        return int(value) * _DURATION_UNITS[unit]
    if text.isdigit():
        return int(text)
    raise ValueError(f"invalid duration: {text!r}")


def _format_age(seconds: float) -> str:
    seconds = max(0, int(seconds))
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    if seconds < 86400:
        return f"{seconds // 3600}h"
    return f"{seconds // 86400}d"


@devices_app.command("list")
def dashboard_devices_list():
    """List paired devices (secrets never shown)."""
    from sarathy.channels.dashboard.auth import DeviceRegistry

    import time as _time

    devices = DeviceRegistry().list_devices()
    if not devices:
        console.print("[dim]No paired devices.[/dim]")
        return

    devices.sort(key=lambda d: d.get("last_seen") or 0, reverse=True)
    now = int(_time.time())
    table = Table(title="Dashboard Devices")
    table.add_column("Device ID", style="cyan")
    table.add_column("Name")
    table.add_column("Created")
    table.add_column("Last seen")
    table.add_column("Notifs")
    for d in devices:
        last = d.get("last_seen") or d.get("created_at") or 0
        table.add_row(
            str(d.get("id", "")),
            str(d.get("name", "")),
            str(d.get("created_at", "")),
            f"{last} ({_format_age(now - last)} ago)",
            "on" if d.get("notifications_enabled") else "—",
        )
    console.print(table)
    console.print(f"  Total: [bold]{len(devices)}[/bold] device(s)")


@devices_app.command("prune")
def dashboard_devices_prune(
    older_than: str = typer.Option(
        "30d", "--older-than", help="Remove devices not seen within this window (e.g. 30d, 12h)"
    ),
    dry_run: bool = typer.Option(
        True, "--dry-run/--apply", help="Report only (default) or actually prune"
    ),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation prompt on --apply"),
):
    """Prune devices that have not been seen for a while.

    Deletes nothing by default: prints a report of what WOULD be removed. Pass
    ``--apply`` (and ``--yes`` for non-interactive use) to delete.
    """
    from sarathy.channels.dashboard.auth import DeviceRegistry

    import time as _time

    try:
        seconds = _parse_duration(older_than)
    except ValueError as e:
        console.print(f"[red]{e}[/red]")
        raise typer.Exit(1)

    registry = DeviceRegistry()
    total = len(registry.list_devices())
    stale = registry.stale_devices(seconds)
    kept = total - len(stale)

    now = int(_time.time())
    console.print(
        f"[bold]Prune preview[/bold] — devices not seen within [cyan]{older_than}[/cyan] "
        f"({seconds}s). Total paired: {total}, stale: [yellow]{len(stale)}[/yellow]."
    )

    if stale:
        table = Table(title="Would prune")
        table.add_column("Device ID", style="cyan")
        table.add_column("Name")
        table.add_column("Last seen")
        table.add_column("Age")
        stale.sort(key=lambda d: d.get("last_seen") or 0)
        for d in stale:
            last = d.get("last_seen") or d.get("created_at") or 0
            table.add_row(str(d.get("id", "")), str(d.get("name", "")), str(last), _format_age(now - last))
        console.print(table)
    else:
        console.print("[green]Nothing to prune.[/green]")

    if dry_run:
        console.print("[dim]Dry run — nothing deleted. Re-run with --apply to prune.[/dim]")
        return

    if not yes and not typer.confirm(f"Delete {len(stale)} device(s)?"):
        console.print("[yellow]Aborted.[/yellow]")
        raise typer.Exit(1)

    removed = registry.prune_stale(seconds)
    console.print(f"[green]✓[/green] Pruned {removed} device(s); {kept} kept.")


def _do_gateway_restart() -> None:
    """Restart the gateway via the CLI restart command."""
    import subprocess
    import sys

    try:
        subprocess.Popen(
            [sys.executable, "-m", "sarathy.cli.commands", "gateway", "restart"],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            start_new_session=True,
        )
        console.print("[dim]Gateway restarting...[/dim]")
    except Exception as e:
        console.print(f"[red]Failed to restart gateway: {e}[/red]")


if __name__ == "__main__":
    dashboard_app()

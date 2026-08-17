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

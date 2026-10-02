"""``sarathy sc ...`` — the gateway's SC fleet commands.

Follows the conventions of the rest of the CLI (job spec section C):

* a module-level ``typer.Typer`` attached with ``app.add_typer(...)``;
* ``from __future__ import annotations``;
* ``rich`` ``Console`` for all output, including errors;
* errors print in red and exit 1;
* success prints a green ``✓``.

Commands (job spec section C asks for ``node list|add|revoke`` and ``status``;
the rest make the module usable):

.. code-block:: text

    sarathy sc node list [--json]
    sarathy sc node add <id> [--name N] [--no-key]
    sarathy sc node revoke <id>
    sarathy sc status
    sarathy sc listen [--host H] [--port P] [--grace S] [--auto-approve]
    sarathy sc jobs
    sarathy sc approvals
    sarathy sc approve <approval-id> [--mode M] [--deny]
    sarathy sc tools

The registry lives at ``~/.sarathy/sc/nodes.db`` by default, overridable with
``--db`` or ``SC_REGISTRY_DB``.
"""

from __future__ import annotations

import asyncio
import contextlib
from pathlib import Path
from typing import Any

import typer
from rich.console import Console
from rich.table import Table

from sarathy.sc.approvals import (
    DEFAULT_TELEGRAM_CHAT_ID,
    GRANT_MODES,
    ApprovalRouter,
    MemoryApprovalTransport,
    RouterConfig,
    TelegramApprovalTransport,
)
from sarathy.sc.ledger import JobLedger
from sarathy.sc.mcp_bridge import catalogue
from sarathy.sc.registry import (
    DEFAULT_WATCHDOG_GRACE_S,
    NodeRegistry,
    default_registry_path,
    key_proof,
)
from sarathy.sc.ws import SCListener, mint_pairing_key

console = Console()

sc_app = typer.Typer(help="Manage the Sarathy Clients (SC) fleet")
node_app = typer.Typer(help="Node lifecycle: list, add, revoke")
sc_app.add_typer(node_app, name="node")


def _open_registry(db: Path | None = None) -> NodeRegistry:
    return NodeRegistry(db or default_registry_path())


def _dump(value: Any) -> None:
    import json

    console.print_json(json.dumps(value, ensure_ascii=False))


def _isatty() -> bool:
    """True when stdout is a terminal, so piping ``sarathy sc node list`` is clean."""
    import sys

    return sys.stdout.isatty()


# ------------------------------------------------------------------------- nodes


@node_app.command("list")
def node_list(
    json_out: bool = typer.Option(False, "--json", help="Emit JSON"),
    include_offline: bool = typer.Option(True, "--include-offline/--online-only"),
    grace: float = typer.Option(DEFAULT_WATCHDOG_GRACE_S, "--grace", help="Watchdog grace, seconds"),
) -> None:
    """List every node with its health badge."""
    registry = _open_registry()
    try:
        registry.sweep(grace)
        nodes = [n.document(grace) for n in registry.list_nodes(include_offline=include_offline)]
        summary = registry.fleet_summary(grace)
        if json_out:
            _dump({"nodes": nodes, "summary": summary})
            return
        if not nodes:
            console.print("[dim]No nodes registered. Add one with 'sarathy sc node add <id>'.[/dim]")
            return
        table = Table(title="SC fleet")
        table.add_column("NODE", style="cyan")
        table.add_column("NAME")
        table.add_column("STATE")
        table.add_column("HEALTH")
        table.add_column("LAST SEEN", style="dim")
        table.add_column("CAPS", justify="right")
        table.add_column("PLATFORM", style="dim")
        for node in nodes:
            tone = {"online": "green", "stale": "yellow", "offline": "red"}.get(node["health"], "white")
            age = node.get("last_seen_age_s")
            seen = "never" if age is None else f"{age}s ago"
            table.add_row(
                node["id"],
                node["name"] if node["name"] != node["id"] else "",
                node["state"],
                f"[{tone}]{node['health']}[/{tone}]",
                seen,
                str(len(node.get("capabilities", []))),
                f"{node['platform']}/{node['arch']}".strip("/") or "-",
            )
        console.print(table)
        console.print(
            f"[dim]{summary['online']} online · {summary['stale']} stale · "
            f"{summary['offline']} offline · grace {grace:.0f}s[/dim]"
        )
    finally:
        registry.close()


@node_app.command("add")
def node_add(
    node_id: str = typer.Argument(..., help="Node id, must match the SC's config node.id"),
    name: str = typer.Option("", "--name", help="Human-readable name"),
    pairing_key: str = typer.Option("", "--key", help="Use this key instead of generating one"),
    no_key: bool = typer.Option(False, "--no-key", help="Register without a key; adopt the first pairing"),
    note: str = typer.Option("", "--note", help="Free-text note"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """Register a node and show its pairing key once."""
    registry = _open_registry()
    try:
        key = pairing_key.strip() or (None if no_key else mint_pairing_key())
        node = registry.add(node_id, name=name, pairing_key=key, note=note)
        payload = {"node": node.document()}
        if key and not pairing_key:
            payload["pairing_key"] = key
            payload["hint"] = f"sc pair --gateway <url> --code {key}"
        if json_out:
            _dump(payload)
            return
        console.print(f"[green]✓[/green] registered node [cyan]{node.id}[/cyan]")
        if node.pairing_hash:
            console.print(f"  key proof stored: [dim]{key_proof(key or '')}[:12]…[/dim] (the key itself is not stored)")
        if key and not pairing_key:
            console.print(f"  pairing key (shown once): [bold cyan]{key}[/bold cyan]")
            console.print(f"  on the node: [cyan]sc pair --gateway <url> --code {key}[/cyan]")
        else:
            console.print("  [dim]waiting for a pair.request from this node id[/dim]")
    finally:
        registry.close()


@node_app.command("revoke")
def node_revoke(
    node_id: str = typer.Argument(..., help="Node id to revoke"),
    yes: bool = typer.Option(False, "--yes", "-y", help="Skip the confirmation"),
) -> None:
    """Revoke a node: clear its pairing hash and mark it offline."""
    registry = _open_registry()
    try:
        node = registry.get(node_id)
        if node is None:
            console.print(f"[red]Error: no node with id {node_id}[/red]")
            raise typer.Exit(1)
        if not yes and _isatty():
            confirmed = typer.confirm(f"Revoke {node_id}? It will have to be re-paired.")
            if not confirmed:
                console.print("[dim]aborted[/dim]")
                raise typer.Exit(1)
        revoked = registry.revoke(node_id)
        console.print(f"[green]✓[/green] revoked [cyan]{revoked.id}[/cyan]")
        console.print("  [dim]the pairing hash is cleared; the node must be re-paired to return[/dim]")
    finally:
        registry.close()


@node_app.command("show")
def node_show(
    node_id: str = typer.Argument(...),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """Show one node's full record."""
    registry = _open_registry()
    try:
        node = registry.get(node_id)
        if node is None:
            console.print(f"[red]Error: no node with id {node_id}[/red]")
            raise typer.Exit(1)
        if json_out:
            _dump(node.document())
            return
        doc = node.document()
        table = Table(show_header=False, title=f"SC node {node_id}")
        table.add_column("field", style="dim")
        table.add_column("value")
        for key in (
            "name", "state", "health", "platform", "arch", "version",
            "capabilities_hash", "last_seen", "paired_at", "revoked_at", "note",
        ):
            table.add_row(key, str(doc.get(key) or "-"))
        console.print(table)
        if doc.get("capabilities"):
            console.print("\n[bold]capabilities[/bold]")
            caps = Table(show_header=False)
            caps.add_column("name", style="cyan")
            caps.add_column("risk")
            caps.add_column("state")
            caps.add_column("scopes", style="dim")
            for cap in doc["capabilities"]:
                caps.add_row(
                    str(cap.get("name")),
                    str(cap.get("risk")),
                    str(cap.get("state")),
                    ", ".join(cap.get("scopes") or []) or "-",
                )
            console.print(caps)
    finally:
        registry.close()


# ------------------------------------------------------------------------ status


@sc_app.command("status")
def sc_status(
    json_out: bool = typer.Option(False, "--json"),
    grace: float = typer.Option(DEFAULT_WATCHDOG_GRACE_S, "--grace"),
) -> None:
    """Fleet health summary, jobs and pending approvals."""
    registry = _open_registry()
    try:
        registry.sweep(grace)
        ledger = JobLedger(registry)
        router = ApprovalRouter(config=RouterConfig(transport=MemoryApprovalTransport()))
        registry._sc_ledger = ledger  # noqa: SLF001 - shared single view
        registry._sc_approvals_router = router  # noqa: SLF001

        payload = {
            "fleet": registry.fleet_summary(grace),
            "jobs": ledger.counts(),
            "approvals_pending": len(ledger.list_approvals(status="pending")),
            "database": str(registry.path),
        }
        if json_out:
            _dump(payload)
            return
        fleet = payload["fleet"]
        console.print("[bold]SC fleet[/bold]")
        console.print(f"  database   {payload['database']}")
        console.print(
            f"  nodes      {fleet['total']} total · [green]{fleet['online']} online[/green] · "
            f"[yellow]{fleet['stale']} stale[/yellow] · [red]{fleet['offline']} offline[/red]"
        )
        console.print(f"  watchdog   grace {fleet['watchdog_grace_s']:.0f}s")
        if fleet["capabilities"]:
            console.print(f"  surface    {', '.join(fleet['capabilities'])}")
        jobs = {k: v for k, v in payload["jobs"].items() if v}
        console.print(f"  jobs       {jobs or 'none'}")
        console.print(f"  approvals  {payload['approvals_pending']} pending")
    finally:
        registry.close()


# ------------------------------------------------------------------------ listen


@sc_app.command("listen")
def sc_listen(
    host: str = typer.Option("127.0.0.1", "--host", help="Bind address for the node listener"),
    port: int = typer.Option(18790, "--port", help="Bind port"),
    grace: float = typer.Option(DEFAULT_WATCHDOG_GRACE_S, "--grace", help="Heartbeat watchdog grace"),
    telegram: bool = typer.Option(False, "--telegram", help="Route approvals to Telegram"),
    auto_approve: bool = typer.Option(
        False, "--auto-approve", help="Approve every request immediately (E2E only)"
    ),
) -> None:
    """Run the SC WebSocket listener nodes dial out to."""
    console.print(f"[bold]SC listener[/bold] on ws://{host}:{port}/sc")
    if auto_approve:
        console.print("[yellow]--auto-approve is on: approvals will be granted without a human.[/yellow]")
    if telegram:
        console.print(f"  approvals → Telegram chat {DEFAULT_TELEGRAM_CHAT_ID}")

    try:
        asyncio.run(_run_listener(host, port, grace, telegram, auto_approve))
    except KeyboardInterrupt:
        console.print("\n[dim]listener stopped[/dim]")


async def _run_listener(
    host: str, port: int, grace: float, telegram: bool, auto_approve: bool
) -> None:
    registry = _open_registry()
    ledger = JobLedger(registry)
    registry._sc_ledger = ledger  # noqa: SLF001
    transport = (
        TelegramApprovalTransport() if telegram else MemoryApprovalTransport()
    )
    router = ApprovalRouter(config=RouterConfig(transport=transport))
    registry._sc_approvals_router = router  # noqa: SLF001

    listener = SCListener(registry, ledger=ledger, approvals=router, watchdog_grace_s=grace)
    if auto_approve:
        listener.set_auto_approve(lambda _approval_id: True)

    from sarathy.sc import dashboard_api

    dashboard_api.attach_listener(listener)
    dashboard_api.attach_ledger(registry, ledger)
    dashboard_api.attach_approvals(registry, router)

    address = await listener.start(host, port)
    console.print(f"[green]✓[/green] listening on [cyan]ws://{address}/sc[/cyan]")
    console.print(f"  REST fleet API: [cyan]http://{address}/api/sc/nodes[/cyan]")
    console.print("  [dim]Ctrl-C to stop[/dim]")
    try:
        await asyncio.Event().wait()
    finally:
        await listener.stop()
        registry.close()


# ------------------------------------------------------------------------- jobs


@sc_app.command("jobs")
def sc_jobs(
    node: str = typer.Option("", "--node", help="Filter by node"),
    state: str = typer.Option("", "--state", help="Filter by state"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """Show the job ledger."""
    registry = _open_registry()
    try:
        ledger = JobLedger(registry)
        jobs = [j.document() for j in ledger.list_jobs(node=node or None, state=state or None)]
        if json_out:
            _dump({"jobs": jobs, "counts": ledger.counts()})
            return
        if not jobs:
            console.print("[dim]No jobs in the ledger.[/dim]")
            console.print("[dim]Job types registered: " + ", ".join(sorted(ledger.types())) + "[/dim]")
            return
        table = Table(title="SC jobs")
        table.add_column("JOB", style="cyan")
        table.add_column("NODE")
        table.add_column("TYPE")
        table.add_column("STATE")
        table.add_column("%", justify="right")
        table.add_column("MESSAGE", style="dim")
        for job in jobs:
            table.add_row(
                job["id"],
                job["node"],
                job["type"],
                job["state"],
                str(job["progress"]),
                job["message"][:60],
            )
        console.print(table)
    finally:
        registry.close()


# --------------------------------------------------------------------- approvals


@sc_app.command("approvals")
def sc_approvals(
    status: str = typer.Option("pending", "--status", help="pending|approved|denied|auto_approved"),
    json_out: bool = typer.Option(False, "--json"),
) -> None:
    """List approval requests routed to Viswa."""
    registry = _open_registry()
    try:
        ledger = JobLedger(registry)
        rows = ledger.list_approvals(status=status or None)
        if json_out:
            _dump({"approvals": rows})
            return
        if not rows:
            console.print(f"[dim]No {status} approvals.[/dim]")
            return
        table = Table(title=f"SC approvals ({status})")
        table.add_column("ID", style="cyan")
        table.add_column("NODE")
        table.add_column("CAPABILITY")
        table.add_column("SCOPE", style="dim")
        table.add_column("REASON", style="dim")
        table.add_column("RAISED", style="dim")
        for row in rows:
            table.add_row(
                row["id"],
                row["node"],
                row["capability"],
                row["scope"] or "(any)",
                (row["reason"] or "")[:40],
                row["created_at"] or "",
            )
        console.print(table)
    finally:
        registry.close()


@sc_app.command("approve")
def sc_approve(
    approval_id: str = typer.Argument(...),
    mode: str = typer.Option("one", "--mode", help=f"grant mode: {', '.join(GRANT_MODES)}"),
    deny: bool = typer.Option(False, "--deny", help="Deny instead of approving"),
    by: str = typer.Option("cli", "--by", help="Recorded as the decider"),
    note: str = typer.Option("", "--note"),
) -> None:
    """Record a decision on a pending approval.

    This records the human's answer in the ledger. Relaying it to a *live* node
    requires the listener process (which owns the WebSocket); when nothing is
    connected the decision is stored and applied on the node's next approval.
    """
    if mode not in GRANT_MODES:
        console.print(f"[red]Error: mode must be one of {', '.join(GRANT_MODES)}[/red]")
        raise typer.Exit(1)
    registry = _open_registry()
    try:
        ledger = JobLedger(registry)
        record = ledger.get_approval(approval_id)
        if record is None:
            console.print(f"[red]Error: no approval with id {approval_id}[/red]")
            raise typer.Exit(1)
        if deny:
            ledger.update_approval(approval_id, status="denied", decided_by=by, note=note)
            console.print(f"[green]✓[/green] denied [cyan]{approval_id}[/cyan]")
            console.print("  [dim]the node's parked call will be answered 'denied' when it reconnects[/dim]")
            return
        from sarathy.sc.approvals import ApprovalRequest

        grant = ApprovalRequest(
            id=approval_id,
            node=record["node"],
            capability=record["capability"],
            scope=record["scope"],
        ).suggested_grant(mode)
        ledger.update_approval(
            approval_id, status="approved", decided_by=by, note=note or f"mode={mode}"
        )
        console.print(f"[green]✓[/green] approved [cyan]{approval_id}[/cyan] (mode={mode})")
        console.print(f"  grant: [dim]{grant}[/dim]")
        console.print(
            "  [dim]the node is the only party that writes this grant; "
            "the gateway only carries the decision[/dim]"
        )
    finally:
        registry.close()


# ------------------------------------------------------------------------- tools


@sc_app.command("tools")
def sc_tools(json_out: bool = typer.Option(False, "--json")) -> None:
    """Show node-registered services as MCP-shaped tool descriptors."""
    registry = _open_registry()
    try:
        tools = catalogue(registry.list_nodes())
        if json_out:
            _dump({"tools": tools})
            return
        if not tools:
            console.print("[dim]No node has registered a service yet.[/dim]")
            console.print("[dim]Nodes declare services under 'services:' in their config.yaml.[/dim]")
            return
        table = Table(title="Node services as tools")
        table.add_column("TOOL", style="cyan")
        table.add_column("NODE")
        table.add_column("TYPE")
        table.add_column("PORT", justify="right")
        table.add_column("TRANSPORT", style="dim")
        for tool in tools:
            table.add_row(
                tool["name"], tool["node"], tool["type"], str(tool["port"]), tool["transport"]
            )
        console.print(table)
        console.print("[dim]service proxying binds in Phase 3; these are descriptors only[/dim]")
    finally:
        registry.close()


def build() -> None:
    """Hook for tests / embedders that want the typer app without the CLI."""
    with contextlib.suppress(SystemExit):
        sc_app(["--help"])

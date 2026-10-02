"""``/api/sc/*`` REST endpoints for the dashboard fleet view (spec section 9).

Job spec section H asks for three routes, following the conventions the existing
dashboard API already uses (``aiohttp.web``, ``web.json_response``, errors shaped
as ``{"error": "..."}`` with a status code, no framework validation):

* ``GET  /api/sc/nodes``            — the fleet, with health badges
* ``POST /api/sc/nodes``            — add a node / create a pairing intent
* ``POST /api/sc/nodes/{id}/revoke`` — revoke a node

plus the two read-only extras the view needs to render a complete screen
(``/api/sc/status`` and ``/api/sc/jobs``).

Authentication is inherited: the dashboard server's auth middleware already gates
everything under ``/api/`` with a device token, so nothing here needs its own.
These routes live *inside* the gateway process, so they read the same
:class:`NodeRegistry` the WS listener writes — no second database, no cache to
invalidate.
"""

from __future__ import annotations

from typing import Any, Awaitable, Callable

from aiohttp import web
from loguru import logger

from sarathy.sc import schemas
from sarathy.sc.approvals import ApprovalRouter
from sarathy.sc.ledger import JobLedger
from sarathy.sc.mcp_bridge import catalogue
from sarathy.sc.registry import DEFAULT_WATCHDOG_GRACE_S, NodeRegistry

#: Listener attached to the app, when one is running. Set by
#: :func:`attach_listener` so ``/api/sc/status`` can report live sessions without
#: the API layer owning the listener's lifecycle.
_listener: Any | None = None


def attach_listener(listener: Any | None) -> None:
    """Register the live listener for status reporting."""
    global _listener
    _listener = listener


def get_listener() -> Any | None:
    return _listener


def routes(app: web.Application, registry: NodeRegistry, *, prefix: str = "/api/sc") -> None:
    """Register the fleet routes on a dashboard app."""
    app.router.add_get(f"{prefix}/status", _make(registry, api_status))
    app.router.add_get(f"{prefix}/nodes", _make(registry, api_list_nodes))
    app.router.add_post(f"{prefix}/nodes", _make(registry, api_add_node))
    app.router.add_get(f"{prefix}/nodes/{{node_id}}", _make(registry, api_get_node))
    app.router.add_post(f"{prefix}/nodes/{{node_id}}/revoke", _make(registry, api_revoke_node))
    app.router.add_get(f"{prefix}/jobs", _make(registry, api_jobs))
    app.router.add_get(f"{prefix}/approvals", _make(registry, api_approvals))
    app.router.add_get(f"{prefix}/tools", _make(registry, api_tools))


# ------------------------------------------------------------------------ helpers


def _json(status: int, body: Any) -> web.Response:
    return web.json_response(body, status=status, dumps=lambda o: _dumps(o))


def _dumps(obj: Any) -> str:
    import json

    return json.dumps(obj, ensure_ascii=False)


def _error(status: int, message: str) -> web.Response:
    # Same shape as every other error in the dashboard server.
    return _json(status, {"error": message})


async def _body(request: web.Request) -> dict[str, Any]:
    """Parse a JSON body, raising ``ValueError`` with a useful message."""
    import json

    try:
        raw = await request.text()
    except Exception as exc:  # pragma: no cover - transport level
        raise ValueError(f"could not read request body: {exc}") from exc
    if not raw.strip():
        return {}
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON body: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("request body must be a JSON object")
    return data


def _make(registry: NodeRegistry, handler: Callable[..., Awaitable[web.Response]]):
    """Bind the registry into a handler, keeping each one registry-free."""

    async def wrapper(request: web.Request) -> web.Response:
        try:
            return await handler(request, registry)
        except ValueError as exc:
            return _error(400, str(exc))
        except KeyError as exc:
            return _error(404, f"not found: {exc.args[0]}")
        except PermissionError as exc:
            return _error(409, str(exc))
        except web.HTTPException:
            raise
        except Exception as exc:  # pragma: no cover - defensive
            logger.error("SC API {} failed: {}", request.path, exc)
            return _error(500, f"internal error: {exc}")

    wrapper.__name__ = getattr(handler, "__name__", "sc_handler")
    return wrapper


def _ledger_for(registry: NodeRegistry) -> JobLedger | None:
    return getattr(registry, "_sc_ledger", None)


def _approvals_for(registry: NodeRegistry) -> ApprovalRouter | None:
    return getattr(registry, "_sc_approvals_router", None)


def _grace(registry: NodeRegistry, request: web.Request) -> float:
    raw = request.query.get("grace")
    if raw:
        try:
            return max(1.0, float(raw))
        except ValueError as exc:
            raise ValueError(f"grace {raw!r} must be a number of seconds") from exc
    return DEFAULT_WATCHDOG_GRACE_S


# ------------------------------------------------------------------------ handlers


async def api_status(request: web.Request, registry: NodeRegistry) -> web.Response:
    """Fleet summary plus live-session detail for the view header."""
    grace = _grace(registry, request)
    registry.sweep(grace)
    body: dict[str, Any] = {
        "registry_version": schemas.cached_registry().version,
        "fleet": registry.fleet_summary(grace),
    }
    listener = get_listener()
    if listener is not None:
        body["sessions"] = [s.document() for s in listener.sessions.values()]
        body["watchdog_grace_s"] = listener.watchdog_grace_s
    ledger = _ledger_for(registry)
    if ledger is not None:
        body["jobs"] = ledger.counts()
    approvals = _approvals_for(registry)
    if approvals is not None:
        body["approvals_pending"] = len(approvals.pending(registry))
    return _json(200, body)


async def api_list_nodes(request: web.Request, registry: NodeRegistry) -> web.Response:
    """``GET /api/sc/nodes`` — the fleet.

    The watchdog is swept on read so the health badge reflects reality at the
    moment it is displayed. Sweeping on a timer instead would show a node as
    online for up to one sweep interval after it died.
    """
    grace = _grace(registry, request)
    include_offline = request.query.get("include_offline", "true").lower() != "false"
    registry.sweep(grace)
    nodes = registry.list_nodes(include_offline=include_offline)
    return _json(
        200,
        {
            "nodes": [n.document(grace) for n in nodes],
            "summary": registry.fleet_summary(grace),
            "watchdog_grace_s": grace,
        },
    )


async def api_get_node(request: web.Request, registry: NodeRegistry) -> web.Response:
    grace = _grace(registry, request)
    node = registry.get(request.match_info["node_id"])
    if node is None:
        raise KeyError(request.match_info["node_id"])
    return _json(200, {"node": node.document(grace)})


async def api_add_node(request: web.Request, registry: NodeRegistry) -> web.Response:
    """``POST /api/sc/nodes`` — add a node / create a pairing intent.

    Accepts either a ``node_id`` alone (the gateway waits for a ``pair.request``
    with a matching id and adopts it) or a ``node_id`` plus ``pairing_key``, which
    pre-authorises the proof. The generated key is returned **once** and never
    stored: only its sha256 goes in the DB (spec section 5.1).
    """
    data = await _body(request)
    node_id = str(data.get("node_id") or data.get("id") or "").strip()
    if not node_id:
        raise ValueError("node_id is required")
    pairing_key = str(data.get("pairing_key") or "").strip() or None
    generated = False
    if pairing_key is None and data.get("generate_key", True):
        from sarathy.sc.ws import mint_pairing_key

        pairing_key = mint_pairing_key()
        generated = True

    node = registry.add(
        node_id,
        name=str(data.get("name") or "").strip(),
        pairing_key=pairing_key,
        note=str(data.get("note") or "").strip(),
    )
    logger.info("SC node {} added via the dashboard API", node_id)
    return _json(
        200,
        {
            "node": node.document(),
            # Shown once in the UI so Viswa can paste it into `sc pair`. It is not
            # recoverable afterwards, by design.
            "pairing_key": pairing_key if generated else None,
            "pairing_key_generated": generated,
            "hint": (
                f"run:  sc pair --gateway <url> --code {pairing_key}"
                if generated
                else "pass this node's pairing key to `sc pair --code ...`"
            ),
        },
    )


async def api_revoke_node(request: web.Request, registry: NodeRegistry) -> web.Response:
    """``POST /api/sc/nodes/{id}/revoke``.

    Revocation clears the pairing hash, so the node can no longer authenticate.
    A live session is closed where a listener is running: leaving a revoked node
    connected would mean "revoked" in the UI and "still executing" on the host.
    """
    node_id = request.match_info["node_id"]
    node = registry.revoke(node_id)
    listener = get_listener()
    closed = False
    if listener is not None:
        session = listener.sessions.get(node_id)
        if session is not None:
            await listener._close(session, code=4003, message="node revoked")  # noqa: SLF001
            closed = True
    logger.info("SC node {} revoked from the dashboard API", node_id)
    return _json(
        200,
        {
            "ok": True,
            "node": node.document(),
            "session_closed": closed,
            "note": "the pairing hash is cleared; the node must be re-paired to return",
        },
    )


async def api_jobs(request: web.Request, registry: NodeRegistry) -> web.Response:
    ledger = _ledger_for(registry)
    if ledger is None:
        return _json(200, {"jobs": [], "counts": {}, "types": {}})
    jobs = ledger.list_jobs(
        node=request.query.get("node") or None,
        state=request.query.get("state") or None,
        limit=int(request.query.get("limit", 200) or 200),
    )
    return _json(
        200,
        {
            "jobs": [j.document() for j in jobs],
            "counts": ledger.counts(),
            "types": ledger.types(),
        },
    )


async def api_approvals(request: web.Request, registry: NodeRegistry) -> web.Response:
    ledger = _ledger_for(registry)
    if ledger is None:
        return _json(200, {"approvals": []})
    return _json(
        200,
        {"approvals": ledger.list_approvals(status=request.query.get("status") or None)},
    )


async def api_tools(request: web.Request, registry: NodeRegistry) -> web.Response:
    """Node-registered services as MCP-shaped tool descriptors."""
    return _json(
        200,
        {
            "tools": catalogue(registry.list_nodes()),
            "note": "descriptors only; the service proxy binds in Phase 3",
        },
    )


def attach_ledger(registry: NodeRegistry, ledger: JobLedger) -> None:
    """Attach a ledger so the API and the listener share one job view."""
    registry._sc_ledger = ledger  # noqa: SLF001 - deliberate single-ownership link


def attach_approvals(registry: NodeRegistry, router: ApprovalRouter) -> None:
    registry._sc_approvals_router = router  # noqa: SLF001

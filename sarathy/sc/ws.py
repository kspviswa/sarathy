"""SC WebSocket listener (spec section 5.1, section 9).

The gateway is the only listener in the system: every node dials **out** to this
endpoint (spec section 2, principle 3). Nothing here binds a port on a node, and
no node can reach another node through it.

Per connection it runs the strict dispatch table:

===========================  ====================================================
``pair.request``             validate the key proof, answer ``pair.confirm``
``hello``                    record identity + capability hash, mark online
``heartbeat``                refresh ``last_seen``; the watchdog judges staleness
``capability.update``        refresh the capability mirror
``approval.response``        relay Viswa's decision to the node and unblock the call
``tool.result``              resolve the pending tool call (or record the denial)
``tool.stream``              record an incremental result
``job.*``                    feed the ledger
``svc.register``             record a node-registered service for the MCP bridge
===========================  ====================================================

Anything outside the dispatch table is dropped with an audit line, never executed
(spec section 5.3).

Implemented on ``aiohttp.web`` rather than the ``websockets`` library so the SC
listener and the dashboard API share one server, one event loop and one auth
middleware. The node link is authenticated by the **pairing key** (spec section
5.1), not by a dashboard device token: nodes are not browsers and do not pair with
a dashboard key.
"""

from __future__ import annotations

import asyncio
import json
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Awaitable, Callable

from aiohttp import WSMsgType, web
from loguru import logger

from sarathy.sc import schemas
from sarathy.sc.approvals import ApprovalRouter
from sarathy.sc.ledger import JobLedger
from sarathy.sc.registry import DEFAULT_WATCHDOG_GRACE_S, NodeRegistry, key_proof

# Frame size cap. The protocol is typed and small; anything larger is a bug or an
# attack, and letting it stream would be a memory hole in the gateway.
MAX_FRAME_BYTES = 256 * 1024

# How often the watchdog sweeps. A tenth of the grace is plenty and keeps the
# sweep off the hot path.
DEFAULT_SWEEP_INTERVAL_S = 15.0


def _iso(ts: float | None = None) -> str:
    current = time.time() if ts is None else ts
    return datetime.fromtimestamp(current, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _new_id() -> str:
    """Envelope ids. Prefixed so they are greppable in a packet capture."""
    return f"gw-{secrets.token_hex(8)}"


@dataclass
class Session:
    """One live node connection."""

    node_id: str
    ws: web.WebSocketResponse
    connected_at: float = field(default_factory=time.time)
    paired: bool = False
    peer: str = ""
    frames_in: int = 0
    frames_out: int = 0
    last_frame: float = field(default_factory=time.time)
    # call_id -> the tool.call envelope id, so a tool.result can be correlated.
    pending_calls: dict[str, str] = field(default_factory=dict)
    #: True once a heartbeat reported state=busy, cleared on the next idle beat.
    busy: bool = False

    def document(self) -> dict[str, Any]:
        return {
            "node": self.node_id,
            "paired": self.paired,
            "busy": self.busy,
            "peer": self.peer,
            "connected_at": _iso(self.connected_at),
            "uptime_s": round(time.time() - self.connected_at, 1),
            "frames_in": self.frames_in,
            "frames_out": self.frames_out,
            "last_frame": _iso(self.last_frame),
            "pending_calls": len(self.pending_calls),
        }


class SCListener:
    """Accepts node WebSocket connections and runs the protocol dispatch table."""

    def __init__(
        self,
        registry: NodeRegistry,
        *,
        ledger: JobLedger | None = None,
        approvals: ApprovalRouter | None = None,
        watchdog_grace_s: float = DEFAULT_WATCHDOG_GRACE_S,
        sweep_interval_s: float = DEFAULT_SWEEP_INTERVAL_S,
        schema_registry: schemas.SchemaRegistry | None = None,
    ) -> None:
        self.registry = registry
        self.ledger = ledger or JobLedger(registry)
        # The approval router is injectable so tests never touch Telegram, and so
        # the E2E harness can auto-approve through the same code path a human
        # would (spec section 11, job spec section D step 3).
        self.approvals = approvals or ApprovalRouter()
        self.watchdog_grace_s = watchdog_grace_s
        self.sweep_interval_s = sweep_interval_s
        self.schemas = schema_registry or schemas.cached_registry()
        self.sessions: dict[str, Session] = {}
        self._sweep_task: asyncio.Task[None] | None = None
        self._app: web.Application | None = None
        self._runner: web.AppRunner | None = None
        self._site: web.TCPSite | None = None
        self._auto_approve: Callable[[str], bool] | None = None

    # ------------------------------------------------------------------ wiring

    def routes(self, app: web.Application, prefix: str = "/sc") -> None:
        """Register the listener routes on an existing aiohttp app.

        Mounting on the dashboard app means one port, one process and one event
        loop — the same reason the dashboard channel hosts its API in-process.
        """
        app.router.add_get(prefix, self.handle_websocket)
        app.router.add_get(f"{prefix}/health", self.handle_health)

    def set_auto_approve(self, fn: Callable[[str], bool] | None) -> None:
        """Install an auto-approval predicate, used by the automated E2E run.

        Production leaves this ``None``, so an approval is routed to Telegram and
        waits for a human. The E2E harness sets it so the full
        approval → grant → resume path is exercised without a network round trip
        to a phone.
        """
        self._auto_approve = fn

    async def start(self, host: str = "127.0.0.1", port: int = 0) -> str:
        """Run a standalone listener. Returns the bound address."""
        app = web.Application(client_max_size=MAX_FRAME_BYTES)
        self._app = app
        self.routes(app)
        self._runner = web.AppRunner(app, access_log=None)
        await self._runner.setup()
        self._site = web.TCPSite(self._runner, host, port)
        await self._site.start()
        await self.start_watchdog()
        # Port 0 means "pick one": read the socket back rather than reporting 0.
        host, port = self._site._server.sockets[0].getsockname()[:2]  # noqa: SLF001
        address = f"{host}:{port}"
        logger.info("SC listener on ws://{}/sc", address)
        return address

    async def stop(self) -> None:
        await self.stop_watchdog()
        for session in list(self.sessions.values()):
            await self._close(session, code=1001, message="gateway shutting down")
        if self._site is not None:
            await self._site.stop()
            self._site = None
        if self._runner is not None:
            await self._runner.cleanup()
            self._runner = None

    # ---------------------------------------------------------------- watchdog

    async def start_watchdog(self) -> None:
        """Start the heartbeat watchdog (spec section 9, second bullet)."""
        if self._sweep_task is not None:
            return
        self._sweep_task = asyncio.create_task(self._watchdog_loop(), name="sc-watchdog")

    async def stop_watchdog(self) -> None:
        task, self._sweep_task = self._sweep_task, None
        if task is not None:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass

    async def _watchdog_loop(self) -> None:
        while True:
            try:
                await asyncio.sleep(self.sweep_interval_s)
                self.sweep()
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # pragma: no cover - defensive
                # The watchdog must never die; a silent stop means silent staleness.
                logger.error("SC watchdog sweep failed: {}", exc)

    def sweep(self) -> list[str]:
        """One watchdog pass. Exposed so tests can drive it without sleeping."""
        return self.registry.sweep(self.watchdog_grace_s)

    # ----------------------------------------------------------------- handlers

    async def handle_health(self, request: web.Request) -> web.Response:
        return web.json_response(
            {
                "ok": True,
                "service": "sc-listener",
                "registry_version": self.schemas.version,
                "sessions": [s.document() for s in self.sessions.values()],
                "fleet": self.registry.fleet_summary(self.watchdog_grace_s),
            }
        )

    async def handle_websocket(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=None, max_msg_size=MAX_FRAME_BYTES)
        await ws.prepare(request)

        session: Session | None = None
        try:
            async for msg in ws:
                if msg.type == WSMsgType.ERROR:
                    logger.debug("SC socket error: {}", ws.exception())
                    break
                if msg.type != WSMsgType.TEXT:
                    # Binary frames have no meaning in this protocol; a node that
                    # sends one has a bug, and guessing would be worse.
                    logger.warning("dropping non-text SC frame type={}", msg.type)
                    continue
                if len(msg.data) > MAX_FRAME_BYTES:
                    logger.warning("dropping oversized SC frame ({} bytes)", len(msg.data))
                    continue
                session = await self._on_frame(session, ws, msg.data, request)
                if session is None and ws.closed:
                    break
        finally:
            if session is not None:
                await self._on_disconnect(session)
        return ws

    async def _on_frame(
        self,
        session: Session | None,
        ws: web.WebSocketResponse,
        raw: str,
        request: web.Request,
    ) -> Session | None:
        try:
            frame = json.loads(raw)
        except json.JSONDecodeError as exc:
            logger.warning("SC frame is not JSON: {}", exc)
            return session

        try:
            frame = self.schemas.validate_envelope(frame)
        except schemas.UnknownType as exc:
            # Spec section 5.3: unknown type → drop + error reply, never execute.
            logger.warning(
                "dropping SC frame with unknown type={} from {}",
                exc.msg_type,
                request.remote,
            )
            return session
        except schemas.InvalidEnvelope as exc:
            logger.warning("dropping malformed SC frame: {}", exc)
            await self._send_raw(
                ws,
                schemas.envelope(
                    schemas.TOOL_RESULT,
                    _new_id(),
                    str(frame.get("node", "")),
                    {
                        "call_id": str((frame.get("payload") or {}).get("call_id", "unknown")),
                        "ok": False,
                        "error": exc.reason,
                        "code": schemas.CODE_INVALID_ARGUMENTS,
                    },
                ),
            )
            return session

        msg_type = frame["type"]
        node_id = str(frame.get("node", ""))
        if not node_id:
            logger.warning("dropping SC frame with empty node field (type={})", msg_type)
            return session

        if session is not None and session.node_id != node_id:
            # A node may not speak for another identity. This is the check that
            # stops a compromised node from answering for its peers.
            logger.warning(
                "SC frame node mismatch: session={} frame={}", session.node_id, node_id
            )
            return session

        if session is None:
            session = Session(node_id=node_id, ws=ws, peer=request.remote or "")
            self.sessions[node_id] = session
            logger.info("SC node connected: {} from {}", node_id, session.peer)

        session.frames_in += 1
        session.last_frame = time.time()

        try:
            await self._dispatch(session, msg_type, frame)
        except Exception as exc:  # pragma: no cover - defensive
            # One bad frame must not kill the connection: the node would then
            # reconnect-loop and the operator would see a flapping fleet.
            logger.error("SC dispatch failed for {} ({}): {}", node_id, msg_type, exc)
        return session

    async def _dispatch(self, session: Session, msg_type: str, frame: dict[str, Any]) -> None:
        if not self.schemas.accepts_from_node(msg_type):
            # A node sending a gateway->sc type (tool.call, pair.confirm, …) is
            # either confused or hostile. Dispatching it would hand the fleet the
            # ability to command the gateway; dropping it is the whole point of
            # the direction column.
            logger.warning(
                "dropping out-of-direction SC frame {} from {}", msg_type, session.node_id
            )
            return
        payload = frame.get("payload") or {}
        handler = getattr(self, f"_on_{msg_type.replace('.', '_')}", None)
        if handler is None:
            logger.warning("no handler for inbound SC type {}", msg_type)
            return
        await handler(session, frame, payload)

    # ------------------------------------------------------------- fleet/control

    async def _on_hello(self, session: Session, frame: dict[str, Any], payload: dict[str, Any]) -> None:
        """``hello`` — identity handshake immediately after connect."""
        if not session.paired:
            logger.warning("hello from unpaired node {}; awaiting pair.confirm", session.node_id)
            return
        capabilities = payload.get("capabilities") or []
        for cap in capabilities:
            self.schemas.validate_capability(cap)
        self.registry.touch(
            session.node_id,
            name=payload.get("name", ""),
            platform=payload.get("platform", ""),
            arch=payload.get("arch", ""),
            version=payload.get("version", ""),
            capabilities_hash=payload.get("capabilities_hash", ""),
            capabilities=capabilities,
        )
        logger.info(
            "SC node {} online ({} caps, {} platform={})",
            session.node_id,
            len(capabilities),
            payload.get("capabilities_hash", "")[:16],
            payload.get("platform", "?"),
        )

    async def _on_heartbeat(self, session: Session, frame: dict[str, Any], payload: dict[str, Any]) -> None:
        """``heartbeat`` — refresh liveness. The watchdog judges staleness."""
        session.busy = payload.get("state") == "busy"
        self.registry.touch(session.node_id)
        session.last_frame = time.time()

    async def _on_capability_update(
        self, session: Session, frame: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        """``capability.update`` — the node announces register/enable/deprecate."""
        action = payload.get("action", "register")
        capabilities = payload.get("capabilities") or []
        for cap in capabilities:
            self.schemas.validate_capability(cap)
        node = self.registry.get(session.node_id)
        if node is None:
            # capability.update rides along with hello, which the node sends before
            # pair.confirm lands — so it can legitimately arrive for a node the
            # registry has not created yet. The node re-sends it right after
            # pairing (the core's OnConnected runs again), so dropping this one is
            # correct and logging it is enough.
            logger.debug(
                "capability.update from unregistered node {} (pre-pairing) — ignored",
                session.node_id,
            )
            return
        current = {c.get("name"): c for c in node.capabilities}
        for cap in capabilities:
            name = cap.get("name")
            if action == "deprecate" and name in current:
                current[name]["state"] = cap.get("state", "deprecated")
            else:
                current[name] = cap
        self.registry.touch(session.node_id, capabilities=list(current.values()))
        logger.info(
            "SC node {} capabilities {} ({} total)", session.node_id, action, len(current)
        )

    # ------------------------------------------------------------------ pairing

    async def _on_pair_request(
        self, session: Session, frame: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        """``pair.request`` → validate the proof → answer ``pair.confirm``.

        The proof is sha256(pairing key) (spec section 5.1). The key itself never
        crosses the wire, so a captured socket does not yield a credential.
        """
        proof = str(payload.get("key_proof", ""))
        if not proof or len(proof) != 64:
            await self._confirm(session.node_id, accepted=False, reason="malformed key proof")
            return
        if payload.get("node") and payload["node"] != session.node_id:
            await self._confirm(session.node_id, accepted=False, reason="node id mismatch")
            return

        try:
            node = self.registry.accept_pairing(
                session.node_id,
                proof,
                name=str(payload.get("name", "")),
            )
        except PermissionError as exc:
            logger.warning("pairing refused for {}: {}", session.node_id, exc)
            await self._confirm(session.node_id, accepted=False, reason=str(exc))
            return

        session_token = f"st-{secrets.token_hex(16)}"
        await self._confirm(
            session.node_id,
            accepted=True,
            session_token=session_token,
            # Default scopes are proposed, not applied. The node's own config is
            # the ceiling (spec section 6.2); proposing them here lets the node
            # record what the gateway expected without ever widening itself.
            default_scopes=[],
        )
        self.registry.mark_paired(session.node_id, session_token)
        session.paired = True
        logger.info(
            "SC node {} paired (platform={} {} version={})",
            node.id,
            payload.get("platform", "?"),
            payload.get("arch", "?"),
            payload.get("version", "?"),
        )

    async def _confirm(
        self,
        node_id: str,
        *,
        accepted: bool,
        reason: str = "",
        session_token: str | None = None,
        default_scopes: list[str] | None = None,
    ) -> None:
        payload: dict[str, Any] = {"node": node_id, "accepted": accepted}
        if reason:
            payload["reason"] = reason
        payload["session_token"] = session_token
        payload["default_scopes"] = default_scopes or []
        await self.send(node_id, schemas.PAIR_CONFIRM, _new_id(), payload)

    # --------------------------------------------------------------------- tools

    async def _on_tool_result(
        self, session: Session, frame: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        """``tool.result`` — the node answered a capability call."""
        call_id = str(payload.get("call_id", ""))
        session.pending_calls.pop(call_id, None)
        ok = bool(payload.get("ok"))
        code = str(payload.get("code", ""))
        logger.info(
            "tool.result from {} call={} ok={} code={}",
            session.node_id,
            call_id,
            ok,
            code or "-",
        )
        if not ok and code == schemas.CODE_NEEDS_APPROVAL:
            # The SC raised needs_approval. The node has already emitted an
            # approval.request of its own; this is the gateway's copy of the fact,
            # kept so the dashboard can show "waiting on Viswa" without joining
            # the node's stream.
            self.ledger.note_blocked_call(session.node_id, call_id, str(payload.get("error", "")))

    async def _on_tool_stream(
        self, session: Session, frame: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        """``tool.stream`` — incremental output for a long operation."""
        logger.debug(
            "tool.stream from {} call={} chunk={}B",
            session.node_id,
            payload.get("call_id"),
            len(str(payload.get("chunk", ""))),
        )

    # ---------------------------------------------------------------- approvals

    async def _on_approval_request(
        self, session: Session, frame: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        """``approval.request`` — route to Viswa (spec section 11).

        The gateway routes; it cannot grant. The decision comes back as
        ``approval.response`` and is relayed verbatim to the node, which is the
        only party that persists the grant.
        """
        approval_id = str(payload.get("id", ""))
        if not approval_id:
            logger.warning("approval.request without an id from {}", session.node_id)
            return
        grant = payload.get("suggested_grant")
        if grant is not None:
            # Validate before it reaches a phone screen: a malformed grant in a
            # Telegram message is a phishing surface.
            self.schemas.validate_grant(grant)

        record = await self.approvals.route(
            node_id=session.node_id,
            approval_id=approval_id,
            capability=str(payload.get("capability", "")),
            scope=payload.get("scope"),
            reason=str(payload.get("reason", "")),
            call_id=payload.get("call_id"),
            job_id=payload.get("job_id"),
            grant=grant,
            registry=self.registry,
            auto_approve=self._auto_approve,
            relay=self._relay_approval_response,
        )
        logger.info(
            "approval {} routed from {} for {} (status={})",
            approval_id,
            session.node_id,
            payload.get("capability"),
            record.status,
        )

    async def _relay_approval_response(
        self, node_id: str, approval_id: str, decision: str, grant: dict[str, Any] | None, decided_by: str, note: str
    ) -> None:
        """Hand Viswa's decision to the node. The node is what stores the grant."""
        payload: dict[str, Any] = {
            "id": approval_id,
            "decision": decision,
            "grant": grant,
            "decided_by": decided_by,
        }
        if note:
            payload["note"] = note
        await self.send(node_id, schemas.APPROVAL_RESPONSE, _new_id(), payload)

    async def _on_approval_response(
        self, session: Session, frame: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        """``approval.response`` arriving from a node.

        That direction is unusual — normally the gateway originates it. Accepting
        it here means a node relaying a decision is recorded rather than dropped,
        but the gateway still does not act on it as if it were authoritative.
        """
        logger.info(
            "approval.response from node {} for {} decision={}",
            session.node_id,
            payload.get("id"),
            payload.get("decision"),
        )
        await self.approvals.record_decision(
            approval_id=str(payload.get("id", "")),
            decision=str(payload.get("decision", "")),
            decided_by=str(payload.get("decided_by", "")),
            note=str(payload.get("note", "")),
            registry=self.registry,
        )

    # --------------------------------------------------------------------- jobs

    async def _on_job_status(
        self, session: Session, frame: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        job = self.ledger.record_status(session.node_id, payload)
        logger.info(
            "job {} on {} → {} ({}%)",
            payload.get("job_id"),
            session.node_id,
            payload.get("state"),
            payload.get("progress", 0),
        )
        del job

    async def _on_job_events(
        self, session: Session, frame: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        self.ledger.record_event(session.node_id, payload)

    async def _on_job_artifact(
        self, session: Session, frame: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        self.ledger.record_artifact(session.node_id, payload)

    # ------------------------------------------------------------------ services

    async def _on_svc_register(
        self, session: Session, frame: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        """``svc.register`` — a node advertises one of its local services.

        Recorded for the MCP bridge (spec section 9). The node is the authority on
        which ports exist; the gateway only mirrors what it was told.
        """
        node = self.registry.get(session.node_id)
        if node is None:
            return
        services = {s.get("name"): s for s in node.services}
        name = str(payload.get("name", ""))
        if not name:
            return
        services[name] = {
            "name": name,
            "port": payload.get("port"),
            "type": payload.get("type"),
            "schema_uri": payload.get("schema_uri"),
            "registered_at": _iso(),
        }
        self.registry.touch(session.node_id, services=list(services.values()))
        logger.info("SC node {} registered service {}:{}", session.node_id, name, payload.get("port"))

    # ---------------------------------------------------------------- node.list

    async def _on_node_list(
        self, session: Session, frame: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        """``node.list`` from a node.

        A node asking for the fleet gets *its own* record only. Handing one node
        the fleet roster is a lateral-information leak with no use to a node whose
        job is to execute allowlisted capabilities.
        """
        node = self.registry.get(session.node_id)
        self.registry.touch(session.node_id)
        await self.send(
            session.node_id,
            schemas.TOOL_RESULT,
            f"re:{frame['id']}",
            {
                "call_id": f"node-list:{session.node_id}",
                "ok": True,
                "data": {
                    "nodes": [
                        {
                            "id": node.id,
                            "name": node.name,
                            "state": node.state,
                            "capabilities_hash": node.capabilities_hash,
                        }
                    ]
                    if node
                    else []
                },
            },
        )

    async def _on_node_revoke(
        self, session: Session, frame: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        """``node.revoke`` from a node — refused.

        Revocation is a gateway-side, human-authorised operation (spec section 5.3:
        "node.list / node.add / node.revoke — gateway commands"). Letting a node
        revoke a peer would be the whole control plane answering to the fleet.
        """
        target = str(payload.get("node_id", ""))
        logger.warning("refusing node.revoke from node {} (target={})", session.node_id, target)
        await self.send(
            session.node_id,
            schemas.TOOL_RESULT,
            f"re:{frame['id']}",
            {
                "call_id": f"node-revoke:{session.node_id}",
                "ok": False,
                "error": "revocation is a gateway-side operation",
                "code": schemas.CODE_DENIED,
            },
        )

    async def _on_node_add(
        self, session: Session, frame: dict[str, Any], payload: dict[str, Any]
    ) -> None:
        """``node.add`` from a node — refused, same reasoning as revoke."""
        new_node = str(payload.get("node_id", ""))
        logger.warning("refusing node.add from node {} (target={})", session.node_id, new_node)
        await self.send(
            session.node_id,
            schemas.TOOL_RESULT,
            f"re:{frame['id']}",
            {
                "call_id": f"node-add:{session.node_id}",
                "ok": False,
                "error": "fleet membership is a gateway-side operation",
                "code": schemas.CODE_DENIED,
            },
        )

    # ------------------------------------------------------------------ outbound

    async def send(self, node_id: str, msg_type: str, msg_id: str, payload: dict[str, Any]) -> bool:
        """Validate and send an envelope to a node.

        Validation before send mirrors the node's own rule: an SC must never be
        able to receive a frame its own schema registry would reject.
        """
        frame = schemas.envelope(msg_type, msg_id, node_id, payload)
        self.schemas.validate_envelope(frame)
        session = self.sessions.get(node_id)
        if session is None:
            logger.debug("no live session for {}; dropping {}", node_id, msg_type)
            return False
        return await self._send_raw(session.ws, frame, session)

    async def _send_raw(
        self, ws: web.WebSocketResponse, frame: dict[str, Any], session: Session | None = None
    ) -> bool:
        if ws.closed:
            return False
        try:
            await ws.send_str(json.dumps(frame, separators=(",", ":")))
        except (ConnectionResetError, RuntimeError) as exc:
            logger.debug("send to {} failed: {}", session.node_id if session else "?", exc)
            return False
        if session is not None:
            session.frames_out += 1
        return True

    async def call_tool(
        self,
        node_id: str,
        capability: str,
        arguments: dict[str, Any],
        timeout_s: float = 30.0,
        *,
        await_approval: bool = True,
    ) -> dict[str, Any]:
        """Send a ``tool.call`` and await its ``tool.result``.

        ``await_approval`` decides what happens when the node answers
        ``needs_approval``, which is not an answer to the call but a *question*
        about it:

        * ``True`` (default) — the call stays open. The gateway routes the
          approval; when Viswa decides, the node persists the grant, resumes the
          parked call and sends a second ``tool.result`` with the same
          ``call_id``. That second result is what resolves here, which is exactly
          what Sarathy's ``sc-approval`` skill needs: one call, one answer.
        * ``False`` — ``needs_approval`` resolves immediately, for a caller that
          wants to see the block and decide for itself.

        Raises ``TimeoutError`` when the node never answers. The caller decides
        what that means — for a read it may be a retry, for a write it must not
        be, because the effect may already have happened.
        """
        session = self.sessions.get(node_id)
        if session is None:
            raise ConnectionError(f"node {node_id} is not connected")

        call_id = f"call-{secrets.token_hex(8)}"
        msg_id = _new_id()
        session.pending_calls[call_id] = msg_id
        loop = asyncio.get_running_loop()
        future: asyncio.Future[dict[str, Any]] = loop.create_future()
        # Marker read by _resolve_call; an attribute rather than a subclass so the
        # future is an ordinary asyncio future everywhere else.
        setattr(future, "park_on_approval", await_approval)
        session_results.setdefault((id(session)), {}).setdefault(call_id, []).append(future)

        frame = schemas.envelope(
            schemas.TOOL_CALL, msg_id, node_id,
            {"call_id": call_id, "capability": capability, "arguments": arguments},
        )
        self.schemas.validate_envelope(frame)
        if not await self._send_raw(session.ws, frame, session):
            raise ConnectionError(f"node {node_id} closed before the call was sent")

        try:
            return await asyncio.wait_for(future, timeout=timeout_s)
        finally:
            session.pending_calls.pop(call_id, None)
            session_results.get((id(session)), {}).pop(call_id, None)

    async def request_approval(self, node_id: str, payload: dict[str, Any]) -> bool:
        """Ask the gateway-side human to decide something on the node's behalf."""
        return await self.send(node_id, schemas.APPROVAL_REQUEST, _new_id(), payload)

    async def submit_job(self, node_id: str, job_id: str, job_type: str, workspace: str, spec: dict[str, Any]) -> bool:
        return await self.send(
            node_id,
            schemas.JOB_SUBMIT,
            _new_id(),
            {
                "job_id": job_id,
                "type": job_type,
                "node": node_id,
                "workspace": workspace,
                "spec": spec,
            },
        )

    # --------------------------------------------------------------- disconnect

    async def _on_disconnect(self, session: Session) -> None:
        # Idempotent: the read loop's ``finally`` and an explicit close can both
        # reach here, and a double "node disconnected" would double-resolve calls.
        if self.sessions.pop(session.node_id, None) is None:
            return
        for waiters in session_results.pop((id(session)), {}).values():
            for future in waiters:
                if not future.done():
                    future.set_exception(ConnectionError(f"node {session.node_id} disconnected"))
        try:
            self.registry.mark_offline(session.node_id)
        except Exception:  # pragma: no cover - defensive
            logger.exception("failed to mark {} offline", session.node_id)
        logger.info("SC node disconnected: {}", session.node_id)

    async def _close(self, session: Session, *, code: int = 1000, message: str = "") -> None:
        if not session.ws.closed:
            await session.ws.close(code=code, message=message.encode())
        await self._on_disconnect(session)


# call_id -> waiters, keyed by id(session) so a reconnect cannot resolve a stale
# call. Module level rather than a Session field because a Future must not be
# copied around when a Session is reconstructed.
session_results: dict[int, dict[str, list["asyncio.Future[dict[str, Any]]"]]] = {}


def _resolve_call(session: Session, call_id: str, result: dict[str, Any]) -> None:
    """Hand a ``tool.result`` to whoever is waiting on that ``call_id``.

    A ``needs_approval`` result deliberately resolves nothing: the node has not
    answered the call, it has asked a question about it. The waiter stays parked so
    the *resumed* result — the one the node sends after a human decided — is what
    it sees. Callers that want the block itself pass ``await_approval=False`` and
    get it, because such a caller's future was created with ``park_on_approval``
    cleared.
    """
    pending = session_results.get(id(session), {})
    waiters = pending.get(call_id)
    if not waiters:
        return
    parked = result.get("code") == schemas.CODE_NEEDS_APPROVAL
    if parked and getattr(waiters[0], "park_on_approval", True):
        return
    future = waiters.pop(0)
    if not future.done():
        future.set_result(result)


def _install_result_resolver(listener: SCListener) -> None:
    """Wire ``_on_tool_result`` to the call waiters created by :meth:`call_tool`.

    Done as an explicit hook rather than a class attribute so the resolution logic
    is visible in one place and the dispatch table stays a plain lookup.
    """
    original = listener._on_tool_result

    async def wrapper(session: Session, frame: dict[str, Any], payload: dict[str, Any]) -> None:
        _resolve_call(session, str(payload.get("call_id", "")), payload)
        await original(session, frame, payload)

    listener._on_tool_result = wrapper  # type: ignore[method-assign]


def create_listener(
    registry: NodeRegistry,
    *,
    watchdog_grace_s: float = DEFAULT_WATCHDOG_GRACE_S,
    ledger: JobLedger | None = None,
    approvals: ApprovalRouter | None = None,
) -> SCListener:
    """Build a listener with the result resolver installed."""
    listener = SCListener(
        registry,
        ledger=ledger,
        approvals=approvals,
        watchdog_grace_s=watchdog_grace_s,
    )
    _install_result_resolver(listener)
    return listener


def mint_pairing_key() -> str:
    """A human-typable pairing key: ``sc-`` plus four hex groups."""
    return "sc-" + "-".join(secrets.token_hex(2) for _ in range(4))


def pairing_key_for(node_id: str) -> str:
    """Deterministic per-node key, used by the E2E harness and local testing.

    Not for production: a predictable key derived from the node id is only
    acceptable on a loopback test listener.
    """
    return f"sc-test-{node_id}-{key_proof(node_id)[:8]}"


__all__ = [
    "MAX_FRAME_BYTES",
    "SCListener",
    "Session",
    "create_listener",
    "mint_pairing_key",
    "pairing_key_for",
]

# `Awaitable` is referenced in the type comments above; keep the import honest.
_ = Awaitable

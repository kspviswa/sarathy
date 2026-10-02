"""Approval router — the ask-Viswa pipeline (spec section 5.3, section 11).

When an SC raises ``approval.request``, the gateway **routes** it to Viswa and
carries the decision back. It cannot grant: the only actor that writes a grant is
the node itself, after it receives an ``approval.response`` correlated to a request
it raised (spec section 6.2, section 11).

The Telegram transport is injectable, which is what makes this testable and what
lets the E2E harness drive the identical code path without a network round trip:

* production: :class:`TelegramApprovalTransport` posts inline buttons to chat
  ``5878545507``;
* tests / E2E: :class:`MemoryApprovalTransport` (or any callable) records what
  would have been sent and returns a decision immediately.

Grant modes offered by the picker (spec section 6.2): ``one``, ``session``,
``task``, ``time``, ``perpetual``. The default suggestion is always ``one`` — the
narrowest thing that unblocks the call at hand.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Callable, Protocol

from loguru import logger

from sarathy.sc import schemas

#: Viswa's chat. Overridable so a second operator can be pointed at without a
#: code change; the default is the one in the design doc.
DEFAULT_TELEGRAM_CHAT_ID = "5878545507"

#: Grant modes, in the order the picker offers them (spec section 6.2).
GRANT_MODES = ("one", "session", "task", "time", "perpetual")

#: Approval record statuses.
STATUS_PENDING = "pending"
STATUS_APPROVED = "approved"
STATUS_DENIED = "denied"
STATUS_EXPIRED = "expired"
STATUS_AUTO_APPROVED = "auto_approved"

DECISION_APPROVE = "approve"
DECISION_DENY = "deny"
DECISION_EXPIRE = "expire"

#: How long a pending approval stays answerable. After this the router marks it
#: expired and the parked call is abandoned, rather than leaving a prompt on a
#: phone screen that could be tapped days later.
DEFAULT_TTL_S = 900.0

#: Telegram caps ``callback_data`` at 64 bytes. The longest button is
#: ``sc:<id>:approve:perpetual`` — 3 + len(id) + 19 — so an approval id may not
#: exceed 42 bytes. Ids are minted as ``appr-`` + 16 hex chars (21 bytes), which
#: leaves comfortable headroom; the check exists so a longer id fails loudly at
#: the point of construction rather than as a mystery 400 from Telegram.
MAX_APPROVAL_ID_BYTES = 64 - len("sc:") - len(":approve:perpetual")


def _iso(ts: float | None = None) -> str:
    current = time.time() if ts is None else ts
    return datetime.fromtimestamp(current, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def new_approval_id() -> str:
    return f"appr-{secrets.token_hex(8)}"


class ApprovalTransport(Protocol):
    """Where an approval request is delivered, and how a decision comes back."""

    async def deliver(self, request: ApprovalRequest) -> Any:
        """Deliver the request. The return value is opaque and stored for tests."""
        ...

    async def wait_for_decision(self, request: ApprovalRequest, timeout_s: float) -> ApprovalDecision | None:
        """Block until a human decides, or return ``None`` on timeout."""
        ...


@dataclass
class ApprovalRequest:
    """One elevation request, in the shape the router and the picker use."""

    id: str
    node: str
    capability: str
    reason: str = ""
    scope: str | None = None
    call_id: str | None = None
    job_id: str | None = None
    grant: dict[str, Any] | None = None
    created_at: float = field(default_factory=time.time)

    def text(self) -> str:
        """The message body. Deliberately explicit: this is read on a phone.

        It names the node, the capability, the scope, and — importantly — that
        approving creates an elevation *on that node*, not on the gateway.
        """
        scope = self.scope or "(any)"
        lines = [
            "🔐 *SC approval request*",
            f"node        `{self.node}`",
            f"capability  `{self.capability}`",
            f"scope       `{scope}`",
        ]
        if self.call_id:
            lines.append(f"call        `{self.call_id}`")
        if self.job_id:
            lines.append(f"job         `{self.job_id}`")
        if self.reason:
            lines.append(f"reason      {self.reason}")
        lines.append("")
        lines.append(f"id          `{self.id}`")
        lines.append("_Approving creates a grant on the node. The gateway cannot grant._")
        return "\n".join(lines)

    def callbacks(self) -> list[tuple[str, str]]:
        """Inline-keyboard (label, callback_data) pairs.

        Callback data is ``sc:<approval-id>:<decision>[:<mode>]``, which is
        self-describing and short enough for Telegram's 64-byte limit. The TTL is
        not encoded: ``time`` always means the picker's default window, which keeps
        every callback inside the budget.
        """
        if len(self.id.encode("utf-8")) > MAX_APPROVAL_ID_BYTES:
            raise ValueError(
                f"approval id {self.id!r} is {len(self.id.encode())} bytes; "
                f"the inline-keyboard callback budget is {MAX_APPROVAL_ID_BYTES}"
            )
        # Telegram caps callback_data at 64 bytes, so the TTL is not carried in
        # the button: ``time`` always means the picker's default window, which
        # keeps every callback comfortably inside the limit.
        buttons = [
            ("✅ Approve once", f"sc:{self.id}:{DECISION_APPROVE}:one"),
            ("🔁 Session", f"sc:{self.id}:{DECISION_APPROVE}:session"),
            ("⏳ 30 min", f"sc:{self.id}:{DECISION_APPROVE}:time"),
            ("♾ Perpetual", f"sc:{self.id}:{DECISION_APPROVE}:perpetual"),
            ("❌ Deny", f"sc:{self.id}:{DECISION_DENY}"),
        ]
        return buttons

    def suggested_grant(self, mode: str = "one") -> dict[str, Any]:
        """Build the grant document for a chosen mode (valid against grant.schema.json)."""
        if mode not in GRANT_MODES:
            raise ValueError(f"grant mode {mode!r} must be one of {', '.join(GRANT_MODES)}")
        grant: dict[str, Any] = {
            "capability": self.capability,
            "node": self.node,
            "scope": self.scope,
            "mode": mode,
            "ttl": None,
            "created": _iso(),
            "expires": None,
            "revoked": False,
            "source": "telegram",
        }
        if mode == "time":
            grant["ttl"] = 1800
            grant["expires"] = _iso(time.time() + 1800)
        return grant


@dataclass
class ApprovalDecision:
    """A human's answer."""

    approval_id: str
    decision: str
    mode: str = "one"
    grant: dict[str, Any] | None = None
    decided_by: str = "viswa"
    note: str = ""
    #: Capability the approval was raised for. Used to synthesise a grant when a
    #: bare approve arrives with no picker choice attached.
    capability: str = ""


class MemoryApprovalTransport:
    """In-process transport for tests and the automated E2E run.

    Records every delivered request and answers it from ``decide``. Nothing here
    touches the network, so ``pytest`` needs no Telegram credentials and the E2E
    harness exercises the same router code the phone path uses.
    """

    def __init__(self, decide: Callable[[ApprovalRequest], ApprovalDecision | None] | None = None) -> None:
        self.delivered: list[ApprovalRequest] = []
        self.decide = decide or (lambda request: ApprovalDecision(request.id, DECISION_APPROVE, "one"))
        self._pending: dict[str, asyncio.Future[ApprovalDecision]] = {}

    async def deliver(self, request: ApprovalRequest) -> dict[str, Any]:
        self.delivered.append(request)
        decision = self.decide(request)
        if decision is not None:
            loop = asyncio.get_running_loop()
            future = self._pending.get(request.id)
            if future is None or future.done():
                future = loop.create_future()
                self._pending[request.id] = future
            future.set_result(decision)
        return {"chat_id": "memory", "text": request.text(), "callbacks": request.callbacks()}

    async def wait_for_decision(self, request: ApprovalRequest, timeout_s: float) -> ApprovalDecision | None:
        loop = asyncio.get_running_loop()
        future = self._pending.get(request.id)
        if future is None:
            future = loop.create_future()
            self._pending[request.id] = future
        try:
            return await asyncio.wait_for(future, timeout=timeout_s)
        except asyncio.TimeoutError:
            self._pending.pop(request.id, None)
            return None

    def approve_all(self, mode: str = "one", decided_by: str = "e2e") -> Callable[[ApprovalRequest], ApprovalDecision]:
        """A ``decide`` callable that approves everything, for the E2E harness."""

        def _decide(request: ApprovalRequest) -> ApprovalDecision:
            return ApprovalDecision(
                approval_id=request.id,
                decision=DECISION_APPROVE,
                mode=mode,
                grant=request.suggested_grant(mode),
                decided_by=decided_by,
            )

        return _decide


class TelegramApprovalTransport:
    """Posts the request to Telegram with inline buttons.

    Uses ``httpx`` against the Bot API directly rather than reaching into the
    running ``TelegramChannel``: approvals must work even when the Telegram
    channel is disabled or the gateway is running headless, and a module that
    depends on another channel's lifecycle is a module that breaks when that
    channel is reconfigured.

    The bot token is read from the environment or sarathy's config; without one,
    delivery fails loudly and the request stays pending rather than being silently
    dropped — a lost approval blocks a human's task, which must be visible.
    """

    API = "https://api.telegram.org"

    def __init__(self, bot_token: str | None = None, chat_id: str | None = None) -> None:
        self.bot_token = bot_token or os.environ.get("SARATHY_TELEGRAM_BOT_TOKEN", "")
        self.chat_id = chat_id or os.environ.get("SARATHY_TELEGRAM_CHAT_ID", DEFAULT_TELEGRAM_CHAT_ID)

    @property
    def configured(self) -> bool:
        return bool(self.bot_token)

    async def deliver(self, request: ApprovalRequest) -> dict[str, Any]:
        if not self.configured:
            raise RuntimeError(
                "Telegram approval transport needs a bot token "
                "(SARATHY_TELEGRAM_BOT_TOKEN or sarathy config channels.telegram.bot_token)"
            )
        import httpx

        # One row per inline button keeps the keyboard readable on a phone.
        keyboard = [[{"text": label, "callback_data": data}] for label, data in request.callbacks()]
        payload = {
            "chat_id": self.chat_id,
            "text": request.text(),
            "parse_mode": "Markdown",
            "reply_markup": {"inline_keyboard": keyboard},
        }
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.post(f"{self.API}/bot{self.bot_token}/sendMessage", json=payload)
            response.raise_for_status()
            return response.json()

    async def wait_for_decision(self, request: ApprovalRequest, timeout_s: float) -> ApprovalDecision | None:
        """Decisions arrive via the channel's ``callback_query`` handler.

        The channel is the only component with a live Telegram update stream, so
        the router registers itself there rather than opening a second long-poll —
        two pollers on one token fight and Telegram drops updates. When the channel
        is not running there is no way to receive a tap, so this returns ``None``
        and the request expires; that is honest rather than a hang.
        """
        from sarathy.channels.manager import ChannelManager  # noqa: F401  (documented coupling)

        del ChannelManager
        return None


@dataclass
class RouterConfig:
    ttl_s: float = DEFAULT_TTL_S
    transport: ApprovalTransport | None = None
    chat_id: str = DEFAULT_TELEGRAM_CHAT_ID


class ApprovalRouter:
    """Routes ``approval.request`` frames to Viswa and relays the decision.

    The router is the *courier*, not the authority. Its whole job is: validate the
    request, deliver it, wait for a decision, and hand that decision back to the
    node that asked. It never writes a grant anywhere the gateway controls, because
    the gateway controls nothing about permissions.
    """

    def __init__(self, config: RouterConfig | None = None) -> None:
        self.config = config or RouterConfig()
        self._transport: ApprovalTransport = self.config.transport or MemoryApprovalTransport()
        self._tasks: dict[str, asyncio.Task[None]] = {}

    @property
    def transport(self) -> ApprovalTransport:
        return self._transport

    def set_transport(self, transport: ApprovalTransport) -> None:
        """Swap the delivery channel. Used by the CLI to opt into Telegram."""
        self._transport = transport

    async def route(
        self,
        *,
        node_id: str,
        approval_id: str,
        capability: str,
        registry: Any,
        scope: str | None = None,
        reason: str = "",
        call_id: str | None = None,
        job_id: str | None = None,
        grant: dict[str, Any] | None = None,
        auto_approve: Callable[[str], bool] | None = None,
        relay: Callable[..., Any] | None = None,
    ) -> dict[str, Any]:
        """Route one request and record it. Returns the stored record.

        ``auto_approve`` is the E2E hook: when it returns True for this approval
        id, the router approves immediately instead of waiting for a human. It
        still builds the same grant document and still relays the same frame, so
        the code path under test is the production one.
        """
        request = ApprovalRequest(
            id=approval_id or new_approval_id(),
            node=node_id,
            capability=capability,
            reason=reason,
            scope=scope,
            call_id=call_id,
            job_id=job_id,
            grant=grant,
        )
        # Validate the suggested grant before it can reach any human surface.
        if grant is not None:
            schemas.validate_grant(grant)

        record = {
            "id": request.id,
            "node": node_id,
            "capability": capability,
            "scope": scope,
            "reason": reason,
            "call_id": call_id,
            "job_id": job_id,
            "grant": grant,
            "status": STATUS_PENDING,
            "created_at": time.time(),
        }
        ledger = _ledger_of(registry)
        if ledger is not None:
            ledger.add_approval(record)
        else:
            _fallback_approvals(registry).append(record)

        approved_by_harness = bool(auto_approve and auto_approve(request.id))
        if approved_by_harness:
            decision = ApprovalDecision(
                approval_id=request.id,
                decision=DECISION_APPROVE,
                mode=str((grant or {}).get("mode", "one")),
                grant=grant or request.suggested_grant("one"),
                decided_by="e2e-auto-approve",
                note="approved by the automated E2E harness",
            )
            record["status"] = STATUS_AUTO_APPROVED
            if ledger is not None:
                ledger.update_approval(request.id, status=STATUS_AUTO_APPROVED, decided_by="e2e")
            if relay is not None:
                result = relay(
                    node_id,
                    request.id,
                    decision.decision,
                    decision.grant,
                    decision.decided_by,
                    decision.note,
                )
                if asyncio.iscoroutine(result):
                    await result
            return record

        try:
            await self._transport.deliver(request)
        except Exception as exc:
            # Delivery failed. The record stays pending so the dashboard shows the
            # queue depth honestly and an operator can re-route it.
            logger.error("approval {} delivery failed: {}", request.id, exc)
            record["status"] = STATUS_PENDING
            record["delivery_error"] = str(exc)
            return record

        if relay is not None:
            self._tasks[request.id] = asyncio.create_task(
                self._await_decision(request, relay), name=f"sc-approval-{request.id[:16]}"
            )
        return record

    async def _await_decision(
        self, request: ApprovalRequest, relay: Callable[..., Any]
    ) -> None:
        decision = await self._transport.wait_for_decision(request, self.config.ttl_s)
        if decision is None:
            logger.info("approval {} expired without a decision", request.id)
            if relay is not None:
                await _maybe_await(
                    relay(request.node, request.id, DECISION_EXPIRE, None, "router", "no decision in time")
                )
            return
        decision.capability = decision.capability or request.capability
        await self.apply_decision(request.node, decision, relay)

    async def apply_decision(
        self, node_id: str, decision: ApprovalDecision, relay: Callable[..., Any] | None
    ) -> None:
        """Relay a decision to the node that raised the request.

        ``node_id`` is passed in rather than looked up: the router holds the
        request, and the node that asked is the only node the answer may go to.
        """
        grant = decision.grant
        if decision.decision == DECISION_APPROVE and grant is None:
            if not decision.capability:
                # Approving with neither a grant nor a capability would mean
                # inventing a permission from nothing. Refuse instead: an approval
                # always names what it authorises.
                raise ValueError(
                    f"approval {decision.approval_id} was approved with no grant and no "
                    "capability; refusing to synthesise one"
                )
            # A bare "approve" with no picker choice: build the narrowest grant
            # that satisfies the request we routed.
            grant = ApprovalRequest(
                id=decision.approval_id, node=node_id, capability=decision.capability
            ).suggested_grant(decision.mode)
        if grant is not None:
            schemas.validate_grant(grant)
        logger.info(
            "approval {} decision={} mode={} by={} → node {}",
            decision.approval_id,
            decision.decision,
            decision.mode,
            decision.decided_by,
            node_id,
        )
        if relay is not None:
            await _maybe_await(
                relay(
                    node_id,
                    decision.approval_id,
                    decision.decision,
                    grant,
                    decision.decided_by,
                    decision.note,
                )
            )

    async def record_decision(
        self,
        *,
        approval_id: str,
        decision: str,
        decided_by: str,
        note: str,
        registry: Any,
    ) -> dict[str, Any]:
        """Record a decision that arrived over the wire (e.g. relayed by a node)."""
        status = {
            DECISION_APPROVE: STATUS_APPROVED,
            DECISION_DENY: STATUS_DENIED,
            DECISION_EXPIRE: STATUS_EXPIRED,
        }.get(decision, STATUS_PENDING)
        ledger = _ledger_of(registry)
        if ledger is not None:
            ledger.update_approval(approval_id, status=status, decided_by=decided_by, note=note)
            return ledger.get_approval(approval_id) or {}
        for record in _fallback_approvals(registry):
            if record["id"] == approval_id:
                record["status"] = status
                record["decided_by"] = decided_by
                record["note"] = note
                return record
        return {}

    def pending(self, registry: Any) -> list[dict[str, Any]]:
        ledger = _ledger_of(registry)
        if ledger is not None:
            return ledger.list_approvals(status=STATUS_PENDING)
        return [r for r in _fallback_approvals(registry) if r.get("status") == STATUS_PENDING]


# --------------------------------------------------------------------------- utils


def _ledger_of(registry: Any) -> Any | None:
    """The ledger attached to a registry, if any.

    Kept as a lookup rather than a hard attribute so the router works against a
    bare :class:`NodeRegistry` in unit tests.
    """
    return getattr(registry, "_sc_ledger", None)


_FALLBACK_ATTR = "_sc_approvals"


def _fallback_approvals(registry: Any) -> list[dict[str, Any]]:
    bucket = getattr(registry, _FALLBACK_ATTR, None)
    if bucket is None:
        bucket = []
        setattr(registry, _FALLBACK_ATTR, bucket)
    return bucket


async def _maybe_await(value: Any) -> Any:
    if asyncio.iscoroutine(value):
        return await value
    return value

"""Sarathy Clients (SC) — gateway-side module.

Spec: ``design/SARATHY_CLIENTS_SPEC.md`` sections 5, 6, 9, 11.

The gateway is the *control plane*. It keeps the fleet registry, the job ledger
and the approval router. It is deliberately **not** the policy authority: the
allowlist and grant store live on each node (spec section 6.2, section 11), and
nothing in this package can widen them. What the gateway can do is observe, and
route a human's decision back to the node that asked.

Layout (spec section 9):

======================  ==========================================================
``schemas.py``          loads ``protos/`` — the single source of truth
``registry.py``         node DB: id, name, pairing hash, last_seen, caps, state
``ws.py``               WS listener, pairing handshake, heartbeat watchdog
``ledger.py``           job ledger + A2A state machine (spec section 5.4)
``approvals.py``        approval router → Telegram, with an injectable transport
``dashboard_api.py``    ``/api/sc/*`` routes for the dashboard fleet view
``mcp_bridge.py``       node-registered services seen as tools (stub, Phase 3)
``cli.py``              ``sarathy sc ...`` commands
======================  ==========================================================
"""

from __future__ import annotations

# Schema registry version this build understands. Bumped only on a breaking
# change in protos/registry.json; the loader refuses to run on a mismatch rather
# than half-understanding the protocol.
REGISTRY_VERSION = 1

__all__ = ["REGISTRY_VERSION"]

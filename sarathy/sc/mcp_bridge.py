"""MCP client bridge — node-registered services seen as tools (spec section 9).

A node that registers a local service (a searxng on :8888, say) should appear in
Sarathy's tool surface as something callable, without Sarathy needing an SSH key
or a route into that host. This module is the consumer half: it turns the service
mirror the registry keeps into MCP-shaped tool descriptors.

Scope note, stated plainly because it matters for planning: **this is a
descriptor builder, not a transport.** Spec section 12 puts service proxying in
Phase 3, and this slice is Phase 1 (spec section 12, Phase 1 exit: "SC registers,
heartbeats, gateway shows it in registry. No tools yet"). So what ships here is:

* discovery — nodes' services become tool descriptors with JSON schemas;
* naming and description, so a duplicate across nodes is resolvable;
* a ``proxy_call`` entry point that raises a clear, specific error rather than
  pretending to have made a request.

The alternative — a half-working proxy that returns a plausible-looking result —
is much worse than an honest stub: it would let an agent believe it had searched
something when it had not.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Iterable

from sarathy.sc import schemas

#: Service name → tool name. MCP tool names are dotted and lowercase; a service
#: called ``searxng`` becomes ``searxng.search``.
PROXY_METHODS: dict[str, tuple[str, ...]] = {
    "http": ("search", "fetch"),
    "mcp": ("tools", "call"),
}


class ProxyUnavailable(RuntimeError):  # noqa: N818 - the proxy is *unavailable*
    """The service proxy is not wired in this build.

    Raised rather than returned as an error-shaped result so a caller cannot
    mistake it for a legitimate empty response.
    """


@dataclass
class ServiceTool:
    """One node service, described as an MCP-shaped tool."""

    node: str
    name: str
    service: str
    port: int
    type: str
    schema_uri: str | None = None
    description: str = ""
    input_schema: dict[str, Any] = field(default_factory=dict)

    def document(self) -> dict[str, Any]:
        return {
            "node": self.node,
            "name": self.name,
            "service": self.service,
            "port": self.port,
            "type": self.type,
            "schema_uri": self.schema_uri,
            "description": self.description,
            "inputSchema": self.input_schema,
            # Explicitly reported so a caller can tell a descriptor from a live
            # tool without reading this file.
            "transport": "not-bound",
        }


def tool_name(service: str, method: str) -> str:
    """``searxng`` + ``search`` → ``searxng.search``."""
    return f"{service.strip().lower()}.{method.strip().lower()}"


def describe(node: Any) -> list[ServiceTool]:
    """Build tool descriptors for one node's registered services."""
    out: list[ServiceTool] = []
    for service in getattr(node, "services", []) or []:
        raw_name = str(service.get("name", ""))
        if not raw_name:
            continue
        kind = str(service.get("type", "http"))
        port = int(service.get("port") or 0)
        for method in PROXY_METHODS.get(kind, ("request",)):
            out.append(
                ServiceTool(
                    node=node.id,
                    name=tool_name(raw_name, method),
                    service=raw_name,
                    port=port,
                    type=kind,
                    schema_uri=service.get("schema_uri"),
                    description=(
                        f"{raw_name}.{method} on node {node.id} "
                        f"(127.0.0.1:{port}, {kind})"
                    ),
                    input_schema=_input_schema(method),
                )
            )
    return out


def _input_schema(method: str) -> dict[str, Any]:
    """The argument schema a proxied call would use.

    ``additionalProperties: false`` throughout, matching the rest of the system:
    a proxied tool that accepts arbitrary arguments is a free-form entry point
    dressed up as a typed one.
    """
    base: dict[str, Any] = {"type": "object", "properties": {}, "additionalProperties": False}
    if method == "search":
        base["properties"] = {
            "q": {"type": "string", "minLength": 1, "description": "Search query."},
            "format": {"enum": ["json", "html"], "default": "json"},
        }
        base["required"] = ["q"]
    elif method == "fetch":
        base["properties"] = {
            "url": {"type": "string", "minLength": 1},
            "method": {"enum": ["GET", "POST"], "default": "GET"},
        }
        base["required"] = ["url"]
    elif method == "tools":
        base["properties"] = {}
    elif method == "call":
        base["properties"] = {
            "tool": {"type": "string", "minLength": 1},
            "arguments": {"type": "object"},
        }
        base["required"] = ["tool"]
    else:
        base["properties"] = {
            "path": {"type": "string", "minLength": 1},
        }
        base["required"] = ["path"]
    return base


def catalogue(nodes: Iterable[Any]) -> list[dict[str, Any]]:
    """The whole fleet's tool descriptors, de-duplicated by name.

    Two nodes exposing the same service produce two descriptors with the same
    tool name. Both are listed, with the node named in the description, rather than
    silently keeping one — picking arbitrarily would make results depend on
    registry ordering.
    """
    seen: dict[str, ServiceTool] = {}
    for node in nodes:
        for tool in describe(node):
            seen.setdefault(tool.name, tool)
    return [t.document() for t in sorted(seen.values(), key=lambda t: t.name)]


async def proxy_call(node_id: str, tool: str, arguments: dict[str, Any]) -> Any:
    """Entry point for a proxied call. Not bound in this build.

    Raises :class:`ProxyUnavailable` with the exact reason, so the caller — Sarathy
    via a skill, or a future Phase 3 implementation — has one obvious place to
    change and no ambiguity about what happened.
    """
    del node_id, tool, arguments
    raise ProxyUnavailable(
        "service proxying is Phase 3 (SARATHY_CLIENTS_SPEC.md section 12); "
        "this build discovers and describes node services but does not proxy calls to them"
    )


def validate_tool_input(tool: str, arguments: dict[str, Any]) -> None:
    """Validate arguments against a described tool's schema.

    Uses the same ``jsonschema`` machinery as the protocol so a proxied call is
    validated exactly like a wire frame.
    """
    from jsonschema import Draft202012Validator

    schema = _input_schema(tool.split(".")[-1])
    errors = sorted(Draft202012Validator(schema).iter_errors(arguments), key=lambda e: list(e.absolute_path))
    if errors:
        raise ValueError(f"{tool}: " + "; ".join(f"/{'/'.join(str(p) for p in e.absolute_path)}: {e.message}" for e in errors))


def summary(nodes: Iterable[Any]) -> dict[str, Any]:
    """Counts for the dashboard."""
    nodes = list(nodes)
    tools = catalogue(nodes)
    return {
        "nodes_with_services": sum(1 for n in nodes if getattr(n, "services", None)),
        "services": len({s["name"] for n in nodes for s in (getattr(n, "services", None) or [])}),
        "tools": len(tools),
        "transport": "not-bound",
        "registry_version": schemas.REGISTRY_VERSION if hasattr(schemas, "REGISTRY_VERSION") else 1,
    }

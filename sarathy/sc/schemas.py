"""Schema registry loader — the gateway's half of the single source of truth.

Every frame the gateway sends or accepts is validated against ``protos/``, the
same files the Go SC validates against (spec section 5.2: "Every message is
validated against the schema registry before dispatch").

Two design points worth stating explicitly, because they are what keeps the two
implementations from drifting:

* **No embedded copy.** The registry is read from disk at load time. There is no
  fallback dict of hand-written validators, so a schema change cannot be applied
  on one side only.
* **No network $ref.** Every schema is registered under both its on-disk path and
  its declared ``$id`` before anything is compiled, so a cross-file ``$ref``
  resolves locally. A dangling reference therefore raises at load time instead of
  hanging on DNS.

The directory is found via ``SC_PROTOS_DIR`` or by walking up from this file,
which works from a source checkout, an installed wheel that shipped ``protos/``,
and the E2E harness, without any of them having to agree on a hardcoded path.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any

from jsonschema import Draft202012Validator, FormatChecker
from referencing import Registry, Resource

from sarathy.sc import REGISTRY_VERSION

# Direction values, matching protos/registry.json. The names are from the **SC's**
# point of view, which is how the design spec frames them ("node dials out"):
# DIR_TO_NODE is something the gateway sends to a node, DIR_FROM_NODE is something
# a node sends to the gateway.
DIR_TO_NODE = "gateway->sc"
DIR_FROM_NODE = "sc->gateway"
DIR_BOTH = "both"

# Back-compat aliases for the raw registry strings.
DIR_INBOUND = DIR_TO_NODE
DIR_OUTBOUND = DIR_FROM_NODE

# Message types (spec section 5.3). Kept as constants so a typo is an AttributeError
# at import time rather than a frame nobody dispatches.
HELLO = "hello"
HEARTBEAT = "heartbeat"
CAPABILITY_UPDATE = "capability.update"
NODE_LIST = "node.list"
NODE_ADD = "node.add"
NODE_REVOKE = "node.revoke"
PAIR_REQUEST = "pair.request"
PAIR_CONFIRM = "pair.confirm"
TOOL_CALL = "tool.call"
TOOL_RESULT = "tool.result"
TOOL_STREAM = "tool.stream"
JOB_SUBMIT = "job.submit"
JOB_STATUS = "job.status"
JOB_EVENTS = "job.events"
JOB_CANCEL = "job.cancel"
JOB_ARTIFACT = "job.artifact"
SVC_REGISTER = "svc.register"
SVC_PROXY = "svc.proxy"
APPROVAL_REQUEST = "approval.request"
APPROVAL_RESPONSE = "approval.response"

# Result codes the SC may return (protos/messages/tool.result.payload.schema.json).
CODE_NEEDS_APPROVAL = "needs_approval"
CODE_DENIED = "denied"
CODE_NOT_FOUND = "not_found"
CODE_DISABLED = "disabled"
CODE_SCOPE_VIOLATION = "scope_violation"
CODE_INVALID_ARGUMENTS = "invalid_arguments"
CODE_INTERNAL = "internal"


#: Format assertions. The Go SC calls ``AssertFormat()``, so a malformed
#: timestamp is a protocol error on *both* ends — asserting only one of them is
#: how the two implementations quietly drift.
#:
#: jsonschema ships no ``date-time`` checker without an extra dependency
#: (``rfc3339-validator``/``strict-rfc3339``), and this protocol only needs the
#: one keyword, so it is implemented here on stdlib ``fromisoformat`` (RFC 3339
#: with ``Z`` is accepted from Python 3.11).
FORMAT_CHECKER = FormatChecker()


@FORMAT_CHECKER.checks("date-time", raises=(ValueError, TypeError))
def _is_rfc3339(value: object) -> bool:
    if not isinstance(value, str):
        return True  # type checking is the schema's job, not the format's
    from datetime import datetime

    text = value[:-1] + "+00:00" if value.endswith(("Z", "z")) else value
    datetime.fromisoformat(text)
    return True


class SchemaError(RuntimeError):
    """Raised when protos/ cannot be loaded or does not match this build."""


class InvalidEnvelope(ValueError):  # noqa: N818 - an *envelope* is invalid; the Error suffix would read oddly
    """A frame failed schema validation. Carries the type and the reason."""

    def __init__(self, msg_type: str | None, reason: str) -> None:
        self.msg_type = msg_type
        self.reason = reason
        super().__init__(f"invalid {msg_type or 'envelope'}: {reason}")


class UnknownType(InvalidEnvelope):
    """A frame carried a type outside the dispatch table (spec section 5.3)."""

    def __init__(self, msg_type: str) -> None:
        super().__init__(msg_type, f"unknown message type {msg_type!r}")


def find_protos_dir() -> Path:
    """Locate ``protos/``.

    Order: ``SC_PROTOS_DIR``, then an upward walk from this module, then from the
    current working directory. A hardcoded deployment path would be wrong in at
    least one of the three layouts this runs in.

    Two layouts are accepted, because a submodule pin of the ``sarathyos`` repo
    lands the schemas one level deeper than a plain checkout (the submodule root
    *is* the sarathyos repo root, and the schemas live in its ``protos/``):
    ``<dir>/protos/registry.json`` and ``<dir>/protos/protos/registry.json``.
    """
    env = os.environ.get("SC_PROTOS_DIR")
    if env:
        candidate = Path(env).expanduser()
        for layout in (candidate, candidate / "protos"):
            if (layout / "registry.json").is_file():
                return layout.resolve()
        raise SchemaError(f"SC_PROTOS_DIR={env!r} does not contain registry.json")

    starts = [Path(__file__).resolve().parent, Path.cwd().resolve()]
    for start in starts:
        for directory in [start, *start.parents]:
            for candidate in (directory / "protos", directory / "protos" / "protos"):
                if (candidate / "registry.json").is_file():
                    return candidate.resolve()
    raise SchemaError(
        "protos/ not found: set SC_PROTOS_DIR or run from inside the "
        "sarathy_clients_workspace tree"
    )


@dataclass(frozen=True)
class MessageSpec:
    """One row of the dispatch table."""

    msg_type: str
    schema: str
    direction: str

    def arrives_from_node(self) -> bool:
        """Whether a frame of this type may arrive at the gateway from a node."""
        return self.direction in (DIR_FROM_NODE, DIR_BOTH)

    def sent_to_node(self) -> bool:
        """Whether the gateway may send this type to a node."""
        return self.direction in (DIR_TO_NODE, DIR_BOTH)


@dataclass
class SchemaRegistry:
    """The loaded ``protos/`` directory."""

    directory: Path
    version: int
    envelope: str
    dispatch: str
    capability: str
    grant: str
    messages: dict[str, MessageSpec] = field(default_factory=dict)
    _validators: dict[str, Draft202012Validator] = field(default_factory=dict, repr=False)
    #: Every schema in protos/, registered under both its on-disk path and its
    #: declared ``$id``, so a cross-file ``$ref`` resolves locally. A dangling
    #: reference therefore fails at compile time instead of reaching the network.
    _refs: Registry = field(default_factory=Registry, repr=False)

    # ------------------------------------------------------------------ loading

    def validator_for(self, msg_type: str) -> Draft202012Validator:
        """Return the payload validator for a message type."""
        if msg_type not in self._validators:
            raise UnknownType(msg_type)
        return self._validators[msg_type]

    def known(self, msg_type: str) -> bool:
        return msg_type in self.messages

    def types(self) -> list[str]:
        return sorted(self.messages)

    def spec(self, msg_type: str) -> MessageSpec:
        try:
            return self.messages[msg_type]
        except KeyError:
            raise UnknownType(msg_type) from None

    def accepts_from_node(self, msg_type: str) -> bool:
        """Whether the gateway should dispatch a frame of this type arriving from a node."""
        return msg_type in self.messages and self.messages[msg_type].arrives_from_node()

    def accepts_inbound(self, msg_type: str) -> bool:
        """Alias for :meth:`accepts_from_node`, for SC-side vocabulary."""
        return self.accepts_from_node(msg_type)

    # -------------------------------------------------------------- validation

    def validate_envelope(self, raw: Any) -> dict[str, Any]:
        """Validate a decoded frame against the envelope + per-type schemas.

        Raises :class:`UnknownType` for a type outside the dispatch table and
        :class:`InvalidEnvelope` for anything else, so callers can answer
        differently: an unknown type is dropped (spec section 5.3), a malformed
        one is answered with an error result.
        """
        if not isinstance(raw, dict):
            raise InvalidEnvelope(None, "frame is not a JSON object")
        msg_type = raw.get("type")
        if not isinstance(msg_type, str):
            raise InvalidEnvelope(None, f"frame type must be a string, got {type(msg_type).__name__}")
        if msg_type not in self.messages:
            raise UnknownType(msg_type)

        errors = sorted(self._dispatch_validator().iter_errors(raw), key=lambda e: list(e.absolute_path))
        if errors:
            raise InvalidEnvelope(msg_type, _render(errors))
        return raw

    def validate_payload(self, msg_type: str, payload: Any) -> Any:
        """Validate a bare payload object against its per-type schema."""
        validator = self.validator_for(msg_type)
        errors = sorted(validator.iter_errors(payload), key=lambda e: list(e.absolute_path))
        if errors:
            raise InvalidEnvelope(msg_type, _render(errors))
        return payload

    def validate_capability(self, doc: Any) -> Any:
        errors = sorted(
            self._bare_validator(self.capability).iter_errors(doc),
            key=lambda e: list(e.absolute_path),
        )
        if errors:
            raise InvalidEnvelope("capability", _render(errors))
        return doc

    def validate_grant(self, doc: Any) -> Any:
        errors = sorted(
            self._bare_validator(self.grant).iter_errors(doc),
            key=lambda e: list(e.absolute_path),
        )
        if errors:
            raise InvalidEnvelope("grant", _render(errors))
        return doc

    def _dispatch_validator(self) -> Draft202012Validator:
        if "__dispatch__" not in self._validators:
            self._validators["__dispatch__"] = self._bare_validator(self.dispatch)
        return self._validators["__dispatch__"]

    def _load_refs(self) -> Registry:
        """Register every schema in ``protos/`` under its path *and* its ``$id``.

        The dispatch table ``allOf``/``if-then`` references each payload schema by
        its ``$id`` URI, and those schemas reference the capability and grant
        documents by URI too. Registering the whole directory up front means no
        lookup ever escapes to the network: a missing ref raises here, loudly.
        """
        if self._refs:
            return self._refs
        registry = Registry()
        paths = sorted(self.directory.glob("*.json")) + sorted((self.directory / "messages").glob("*.json"))
        for path in paths:
            document = json.loads(path.read_text(encoding="utf-8"))
            resource = Resource.from_contents(document)
            relative = path.relative_to(self.directory).as_posix()
            registry = registry.with_resource(uri=relative, resource=resource)
            declared = document.get("$id")
            if isinstance(declared, str) and declared:
                registry = registry.with_resource(uri=declared, resource=resource)
        self._refs = registry
        return registry

    def _bare_validator(self, filename: str) -> Draft202012Validator:
        schema = json.loads((self.directory / filename).read_text(encoding="utf-8"))
        return Draft202012Validator(
            schema, registry=self._load_refs(), format_checker=FORMAT_CHECKER
        )


def _render(errors: list[Any]) -> str:
    """Render jsonschema errors as one readable line naming the offending field."""
    parts: list[str] = []
    for err in errors:
        path = "/" + "/".join(str(p) for p in err.absolute_path) if err.absolute_path else "/"
        parts.append(f"{path}: {err.message}")
        for sub in err.context or ():
            sub_path = "/" + "/".join(str(p) for p in sub.absolute_path)
            parts.append(f"{sub_path}: {sub.message}")
    return "; ".join(dict.fromkeys(parts))


def load_registry(directory: Path | str | None = None) -> SchemaRegistry:
    """Read and compile ``protos/registry.json`` and everything it references."""
    protos = Path(directory).expanduser().resolve() if directory else find_protos_dir()
    index_path = protos / "registry.json"
    if not index_path.is_file():
        raise SchemaError(f"{index_path} is missing")

    index = json.loads(index_path.read_text(encoding="utf-8"))
    version = int(index.get("registry_version", 0))
    if version != REGISTRY_VERSION:
        raise SchemaError(
            f"schema registry version mismatch: protos={version} gateway={REGISTRY_VERSION}"
        )

    messages_dir = protos / "messages"
    if not messages_dir.is_dir():
        raise SchemaError(f"{messages_dir} is missing")

    schema_registry = SchemaRegistry(
        directory=protos,
        version=version,
        envelope=index["envelope"],
        dispatch=index["dispatch"],
        capability=index["capability"],
        grant=index["grant"],
    )

    for name, row in sorted(index["messages"].items()):
        payload_path = messages_dir.parent / row["schema"]
        if not payload_path.is_file():
            raise SchemaError(f"{name} references a missing schema: {row['schema']}")
        schema_registry.messages[name] = MessageSpec(
            msg_type=name, schema=row["schema"], direction=row["direction"]
        )
        schema_registry._validators[name] = schema_registry._bare_validator(row["schema"])

    # Compile the dispatch table last: it $refs every payload schema by $id, so
    # anything broken above surfaces here too.
    schema_registry._dispatch_validator()
    return schema_registry


@lru_cache(maxsize=4)
def cached_registry(directory: str | None = None) -> SchemaRegistry:
    """Process-wide cached registry. Compiling the schemas is not free."""
    return load_registry(directory)


# Module-level shortcuts. The registry is process-cached, so these are cheap and
# they keep call sites from having to know about the cache.


def validate_envelope(raw: Any) -> dict[str, Any]:
    """Validate a frame against the dispatch table, using the cached registry."""
    return cached_registry().validate_envelope(raw)


def validate_payload(msg_type: str, payload: Any) -> Any:
    """Validate a bare payload against its per-type schema."""
    return cached_registry().validate_payload(msg_type, payload)


def validate_capability(doc: Any) -> Any:
    """Validate a bare capability document."""
    return cached_registry().validate_capability(doc)


def validate_grant(doc: Any) -> Any:
    """Validate a bare grant document."""
    return cached_registry().validate_grant(doc)


def envelope(
    msg_type: str,
    msg_id: str,
    node: str,
    payload: dict[str, Any],
    *,
    ts: str | None = None,
) -> dict[str, Any]:
    """Build an outbound envelope (spec section 5.2).

    Field order matches the schema example; JSON object order is not semantic but
    keeping it stable makes packet captures and logs readable.
    """
    from datetime import datetime, timezone

    return {
        "v": 1,
        "type": msg_type,
        "id": msg_id,
        "node": node,
        "ts": ts or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "payload": payload,
    }

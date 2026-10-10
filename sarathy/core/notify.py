"""Notify-target helpers: one source of truth for "where does Sarathy ping?".

Two features needed the same thing and each used to carry exactly one
destination:

* the restart/redeploy monitor (``restart_pending.json``), and
* the backend channel's escalation target (``escalate_to``).

Both were a single ``channel``/``chat_id`` slot, which made them
last-writer-wins: a redeploy triggered from the dashboard pinged the dashboard
but never Telegram (and the workspace redeploy script pinged Telegram but never
the dashboard). Viswa reported this on 2026-10-10 — the restart boot ping has to
land on BOTH surfaces.

This module normalizes every shape those two callers may see into an ordered,
de-duplicated list of ``(channel, chat_id)`` targets:

* the new list form — ``["telegram:5878545507", "dashboard:console"]`` or
  ``[{"channel": ..., "chat_id": ...}, ...]``,
* the legacy single-target form — ``"telegram:5878545507"``,
* the legacy flag file form — ``{"channel": ..., "chat_id": ...}``,
* the flag file wrapper — ``{"targets": [...]}``.

Stdlib only; no new dependency.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Iterable

# Live Telegram session chat id — the ONLY id relays should ever target.
# (AGENTS.md once showed 8281248569 as an example; that id is stale and
# Telegram returns "Chat not found" for it. See KB #394/#395.)
TG_LIVE_CHAT_ID = "5878545507"

# The dashboard console session/channel pair. The dashboard channel broadcasts
# every console message to all connected WS clients, so this one target reaches
# every open tab.
DASHBOARD_CHANNEL = "dashboard"
DASHBOARD_CHAT_ID = "console"

NotifyTarget = tuple[str, str]


def live_telegram_target() -> NotifyTarget:
    """The canonical Telegram relay target."""
    return ("telegram", TG_LIVE_CHAT_ID)


def dashboard_target() -> NotifyTarget:
    """The canonical dashboard console target."""
    return (DASHBOARD_CHANNEL, DASHBOARD_CHAT_ID)


def _coerce_pair(value: Any, *, default_channel: str = "cli", default_chat: str = "direct") -> NotifyTarget | None:
    """Coerce one entry to a ``(channel, chat_id)`` pair, or None if unusable."""
    if isinstance(value, str):
        text = value.strip()
        if not text:
            return None
        if ":" in text:
            channel, _, chat_id = text.partition(":")
            channel, chat_id = channel.strip(), chat_id.strip()
            if channel and chat_id:
                return (channel, chat_id)
            # "dashboard:" / ":console" — keep whichever half we got.
            return (channel or default_channel, chat_id or default_chat)
        # A bare id with no channel: treat it as the default channel.
        return (default_channel, text)

    if isinstance(value, dict):
        channel = value.get("channel")
        chat_id = value.get("chat_id", value.get("chatId"))
        channel = str(channel).strip() if channel is not None else ""
        chat_id = str(chat_id).strip() if chat_id is not None else ""
        if not channel and not chat_id:
            return None
        return (channel or default_channel, chat_id or default_chat)

    if isinstance(value, (tuple, list)) and len(value) == 2:
        channel = str(value[0]).strip()
        chat_id = str(value[1]).strip()
        if channel or chat_id:
            return (channel or default_channel, chat_id or default_chat)

    return None


def normalize_targets(raw: Any) -> list[NotifyTarget]:
    """Normalize any supported target shape into an ordered, de-duplicated list.

    Accepts ``None`` (→ ``[]``), a ``"channel:chat_id"`` string, a list of
    strings/dicts/pairs, a legacy single-target dict, or a dict wrapping a list
    under ``targets``. Unusable entries are dropped rather than raising: a
    malformed flag must never take the gateway down.
    """
    out: list[NotifyTarget] = []
    seen: set[NotifyTarget] = set()

    def _add(pair: NotifyTarget | None) -> None:
        if pair is None or pair in seen:
            return
        seen.add(pair)
        out.append(pair)

    if raw is None:
        return out

    if isinstance(raw, dict):
        if "targets" in raw:
            return normalize_targets(raw.get("targets"))
        # Legacy single-target flag shape: {"channel": ..., "chat_id": ...}
        _add(_coerce_pair(raw))
        return out

    if isinstance(raw, str):
        _add(_coerce_pair(raw))
        return out

    if isinstance(raw, (list, tuple, set)):
        for item in raw:
            _add(_coerce_pair(item))
        return out

    return out


def default_notify_targets(origin: NotifyTarget | None = None) -> list[NotifyTarget]:
    """The standard fan-out: Telegram live chat + dashboard console.

    ``origin`` (the channel the user triggered the action from) is prepended so
    the surface they acted on is always answered, even if it is neither
    Telegram nor the dashboard (e.g. CLI, Discord, email).
    """
    return normalize_targets([origin, live_telegram_target(), dashboard_target()])


def notify_targets_to_json(targets: Iterable[NotifyTarget]) -> list[dict[str, str]]:
    """Serialize targets into the flag-file list shape."""
    return [{"channel": channel, "chat_id": chat_id} for channel, chat_id in targets]


def build_restart_flag(
    origin_channel: str | None = None,
    origin_chat_id: str | None = None,
    sender_id: str | None = None,
) -> dict:
    """Build the ``restart_pending.json`` payload for a restart request.

    Carries BOTH the Telegram live chat and the dashboard console so the boot
    ping reaches every surface regardless of which one asked for the restart
    (spec §C3). The legacy ``channel``/``chat_id`` keys are kept alongside
    ``targets`` so an older gateway build reading the same file still notifies
    the originating channel instead of ignoring the request entirely.
    """
    origin = (origin_channel, origin_chat_id) if origin_channel and origin_chat_id else None
    targets = default_notify_targets(origin)
    flag: dict[str, Any] = {"targets": notify_targets_to_json(targets)}
    if origin is not None:
        flag["channel"] = origin[0]
        flag["chat_id"] = origin[1]
        if sender_id is not None:
            flag["sender_id"] = str(sender_id)
    return flag


def read_restart_targets(data: Any) -> list[NotifyTarget]:
    """Read targets out of a parsed ``restart_pending.json`` payload.

    Falls back to the legacy ``cli:direct`` default when the file is
    unrecognizable, matching the pre-list behavior.
    """
    targets = normalize_targets(data)
    if targets:
        return targets
    return [("cli", "direct")]


def write_restart_flag(
    origin_channel: str | None = None,
    origin_chat_id: str | None = None,
    sender_id: str | None = None,
    path: Path | None = None,
) -> dict:
    """Write the multi-target restart flag and return the payload written."""
    from sarathy.utils.helpers import get_data_path

    flag_path = path or (get_data_path() / "restart_pending.json")
    payload = build_restart_flag(origin_channel, origin_chat_id, sender_id)
    flag_path.write_text(json.dumps(payload), encoding="utf-8")
    return payload


def targets_from_escalate(escalate_to: Any) -> list[NotifyTarget]:
    """Resolve a backend ``escalate_to`` value into its target list.

    Unset/empty/malformed values fall back to the Telegram live chat — the
    KB #391 escalation rule: a backend relay must ALWAYS reach Viswa, so the
    fallback is never "nowhere". An explicit list fans out to every entry.
    """
    targets = normalize_targets(escalate_to)
    if targets:
        return targets
    return [live_telegram_target()]

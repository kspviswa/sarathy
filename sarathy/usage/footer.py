"""Shared footer formatting for usage telemetry."""

from __future__ import annotations

from typing import Any

from sarathy.usage.store import get_usage_store


def format_usage_footer(stats: dict[str, Any] | None, session_key: str | None) -> str | None:
    """Format the usage footer for a response.

    Args:
        stats: Dict with total_tokens, total_time, tokens_per_sec (from AgentLoop stats).
        session_key: Session key for cost aggregation (channel:chat_id format).

    Returns:
        Formatted footer string with compact tokens/sec and cost line, or None if
        nothing to render (no stats and no session key path).
    """
    parts: list[str] = []

    # Compact tokens/sec line: "⚡ 123 tkn @ 4.5 tps"
    if stats:
        tokens = stats.get("total_tokens", 0)
        tps = stats.get("tokens_per_sec", 0)
        if tokens > 0 and tps > 0:
            parts.append(f"⚡ {tokens} tkn @ {tps:.1f} tps")

    # Cost line - only render when session_key is available for aggregation
    if session_key:
        cost_line = "💵 $xx.xx session"
        try:
            cost = get_usage_store().session_cost(session_key)
            if cost is not None:
                cost_line = f"💵 ${cost:.4f} session"
        except Exception:
            # Benign: telemetry failure must never break a turn
            pass
        parts.append(cost_line)

    if not parts:
        return None

    # Single compact line joined with " · "
    return "\n\n" + " · ".join(parts)
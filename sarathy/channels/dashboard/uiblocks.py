"""Compact typed UI-block schema for the dashboard channel's system prompt.

This module is the single source of truth for which UI components the model may
emit on the dashboard channel. The frontend mirrors this catalog in
``dashboard/src/lib/uiBlocks.tsx`` (the openUI adapter); ``UI_BLOCK_COMPONENTS``
is asserted against the adapter's allowlist by the test suite so the two can
never drift apart silently.

Design rules (deliberate, do not relax without updating the adapter):

- **Curated allowlist only.** No generic/raw-HTML component, no forms, no
  ``Mutation``/``Action``/``Query``. The dashboard is a read-mostly chat
  surface, so the catalog is small and side-effect free.
- **Positional arguments only.** OpenUI Lang maps positional args to named
  props by schema key order. Optional props may only be omitted from the end.
- **No raw HTML.** Every component renders through a hand-written React
  component in the adapter. Model output is never injected as HTML.
- **URLs are sanitised adapter-side** (``sanitizeUrl``): http/https only.

The block is appended to the system prompt for the ``dashboard`` channel ONLY.
Every other channel (telegram, discord, email, backend, cli) keeps the classic
text-first prompt and pays zero token cost for this.
"""

from __future__ import annotations

# Channel names that receive the UI-block schema. Keep this an explicit
# allowlist rather than a deny-list: a new channel must opt in deliberately.
UI_BLOCK_CHANNELS = frozenset({"dashboard"})

# Component names in the curated catalog. Mirrored by the frontend adapter's
# allowlist; asserted in tests/test_dashboard_uiblocks.py.
UI_BLOCK_COMPONENTS: tuple[str, ...] = (
    "Root",
    "Heading",
    "Text",
    "KeyValues",
    "Steps",
    "Callout",
    "LinkList",
    "CodeBlock",
)


def wants_ui_blocks(channel: str | None) -> bool:
    """Return True when ``channel`` should receive the UI-block schema.

    Telegram (and every other channel) returns False, keeping its prompt
    byte-identical to the pre-0.16.0 text-first prompt.
    """
    if not channel:
        return False
    return channel.strip().lower() in UI_BLOCK_CHANNELS


def ui_block_prompt() -> str:
    """Return the compact UI-block schema block for the system prompt.

    Deliberately terse: this is appended to a cached system prefix, so every
    token is paid on every turn. ``generateSystemPrompt`` on the frontend
    produces the same component signatures; this is the canonical hand-written
    source of truth for what the model is told.
    """
    return """## Dashboard UI Blocks (opt-in, dashboard channel only)

You may attach a typed UI block to a reply. Prose outside the fence renders as
normal markdown. Emit the fence ONLY when the structured form is genuinely
clearer than prose; a normal conversational reply needs no fence.

Syntax (openui-lang): one `identifier = Expression` per line, `root` first.

```
root = Root([items], "Optional title")
items = KeyValues([row1, row2])
row1 = {label: "Latency", value: "42 ms"}
```

Rules:
- Arguments are POSITIONAL, never `name: value`. Order is fixed per signature.
- Every defined name except `root` must be referenced by `root`.
- Optional arguments may only be omitted from the END of a call.
- Strings use double quotes; escape inner quotes with a backslash.
- Prefer hoisting: define `root` first, leaves last.

Available components:

Root(children: any[], title?: string) — Top-level container for the whole block.
Heading(text: string, level?: 1|2|3) — A section heading.
Text(text: string, muted?: boolean) — A paragraph of plain text (not markdown).
KeyValues(items: {label: string, value: string}[]) — Label/value pairs, rendered
  as a compact table. Good for metrics, config, comparisons.
Steps(items: {title: string, detail?: string}[]) — An ordered list of steps.
  Good for procedures and plans.
Callout(text: string, tone?: "info"|"warning"|"success"|"danger") — A single
  highlighted aside. Use sparingly for warnings and confirmations.
LinkList(items: {label: string, href: string}[]) — Links. Only http:// and
  https:// hrefs render; anything else is dropped by the client.
CodeBlock(code: string, language?: string) — Preformatted code.

Never invent a component name. If none of the above fit, reply in prose."""


def ui_block_fence_language() -> str:
    """The fence language tag the frontend adapter recognises."""
    return "openui-lang"

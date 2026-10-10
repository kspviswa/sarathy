"""Dashboard UI-block schema for the dashboard channel's system prompt.

Single source of truth: the official openUI component library
(``@openuidev/react-ui``'s ``openuiLibrary``, 80+ components). The prompt text
served here is GENERATED from that library by
``dashboard/scripts/gen-openui-prompt.mjs`` (run ``npm run gen:openui-prompt``)
and committed as ``openui_prompt.txt``. The frontend renders through the very
same library (``dashboard/src/lib/uiBlocks.tsx`` imports ``openuiLibrary``), so
the model can never be told about a component the UI cannot render — there is
only one list.

Design rules:

- **Generated, not hand-written.** Do not edit ``openui_prompt.txt`` by hand;
  regenerate it from the library. Editing it here would restore the drift the
  old two-list design suffered from.
- **Inline mode.** The prompt is the library's ``inlineMode`` variant: prose
  plus an OPTIONAL fenced ``openui-lang`` block. Prose outside the fence
  renders as markdown; the fenced block renders as a typed UI card.
- **Dashboard channel only.** Every other channel (telegram, discord, email,
  backend, cli) keeps the classic text-first prompt and pays zero token cost.
- **Client-side safety.** URLs are sanitised adapter-side (``sanitizeUrl``):
  http/https only. Model output is never injected as HTML.

If ``openui_prompt.txt`` is missing (e.g. a checkout without the generated
artifact), :func:`ui_block_prompt` degrades to a short notice rather than
crashing the agent.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

# Channel names that receive the UI-block schema. Keep this an explicit
# allowlist rather than a deny-list: a new channel must opt in deliberately.
UI_BLOCK_CHANNELS = frozenset({"dashboard"})

# The sentinel the prompt leads with. Tests across the suite use this string to
# assert the schema is attached to the dashboard channel and ONLY that one.
UI_BLOCK_HEADER = "## Dashboard UI Blocks (dashboard channel only)"

_PROMPT_PATH = Path(__file__).with_name("openui_prompt.txt")

_FALLBACK_PROMPT = (
    "You may attach a typed UI block to a reply, fenced with ```openui-lang. "
    "Prose outside the fence renders as markdown. Emit a block only when the "
    "structured form is genuinely clearer than prose."
)


def wants_ui_blocks(channel: str | None) -> bool:
    """Return True when ``channel`` should receive the UI-block schema.

    Telegram (and every other channel) returns False, keeping its prompt
    byte-identical to the pre-0.16.0 text-first prompt.
    """
    if not channel:
        return False
    return channel.strip().lower() in UI_BLOCK_CHANNELS


@lru_cache(maxsize=1)
def _prompt_body() -> str:
    """The generated library prompt, or a terse fallback if it is absent."""
    try:
        body = _PROMPT_PATH.read_text(encoding="utf-8").strip()
    except OSError:
        return _FALLBACK_PROMPT
    return body or _FALLBACK_PROMPT


def ui_block_prompt() -> str:
    """Return the UI-block schema block for the system prompt.

    Leads with :data:`UI_BLOCK_HEADER` (the channel sentinel) followed by the
    library-generated catalog. This is appended to a cached system prefix, so
    every token is paid on every turn — which is exactly why the catalog is
    generated from the library rather than duplicated.
    """
    return f"{UI_BLOCK_HEADER}\n\n{_prompt_body()}"


@lru_cache(maxsize=1)
def ui_block_components() -> tuple[str, ...]:
    """Component names advertised in the generated prompt.

    Parsed from the prompt's ``## Component Signatures`` section so this list
    can never disagree with what the model is actually shown.
    """
    body = _prompt_body()
    section = re.split(r"^## ", body, flags=re.M)
    signatures = ""
    for part in section:
        if part.startswith("Component Signatures"):
            signatures = part
            break
    names = re.findall(r"^\s*([A-Z][A-Za-z0-9]*)\(([^)]*)\)", signatures, flags=re.M)
    return tuple(dict.fromkeys(name for name, _ in names))


# Back-compat module constant. Prefer :func:`ui_block_components`.
UI_BLOCK_COMPONENTS: tuple[str, ...] = ui_block_components()


def ui_block_fence_language() -> str:
    """The fence language tag the frontend adapter recognises."""
    return "openui-lang"

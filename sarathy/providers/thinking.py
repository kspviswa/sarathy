"""Reasoning normalization at the provider boundary (spec 131 §A).

Reasoning models deliver their monologue two different ways, and Sarathy has to
handle both:

* **Source A** — a dedicated delta field (``reasoning_content`` for DeepSeek/Kimi,
  ``reasoning`` / ``thinking`` for Ollama and LM Studio). Already routed to
  ``on_thinking`` by the provider.
* **Source B** — ``<think>...</think>`` tags embedded inline in the normal
  ``content`` string (Qwen3 and several local models).

Both are normalized here, *before* they leave the provider, so that downstream
of this boundary ``content`` is ALWAYS visible prose and ``thinking`` is ALWAYS
the collapse. There is deliberately no text heuristic ("does this look like
reasoning?") anywhere in the stack: the discriminator is which channel the text
arrived on.

The splitter is an incremental state machine with a carry buffer, so a tag split
across stream chunks (``<think>Le`` / ``t me`` / ``</think>``) is still a tag,
and a partial tag is never emitted as visible text.
"""

from __future__ import annotations

import re

THINK_OPEN = "<think>"
THINK_CLOSE = "</think>"

# Complete, non-greedy block (plus trailing whitespace) → nothing.
_THINK_BLOCK_RE = re.compile(r"<think>[\s\S]*?</think>\s*", re.IGNORECASE)
# Truncated stream / early stop: an open tag with no close swallows the rest.
_THINK_TAIL_RE = re.compile(r"<think>[\s\S]*\Z", re.IGNORECASE)


def strip_think(text: str | None) -> str | None:
    """Return only the *visible* prose of ``text``, or ``None``.

    Think-blocks are removed — never their contents promoted to prose, and never
    a fallback to some separate reasoning field. Reasoning belongs to the
    thinking collapse; this returns what the user should actually read.
    """
    if not text:
        return None
    stripped = _THINK_BLOCK_RE.sub("", text)
    stripped = _THINK_TAIL_RE.sub("", stripped).strip()
    return stripped or None


def _partial_tag_len(buf: str, *tags: str) -> int:
    """Length of the longest suffix of ``buf`` that is a proper prefix of a tag.

    That suffix is a tag fragment the stream cut in half, so it has to be held
    back until the next delta decides whether it is a tag or ordinary text.
    """
    best = 0
    for tag in tags:
        for n in range(min(len(tag) - 1, len(buf)), 0, -1):
            if buf.endswith(tag[:n]):
                best = max(best, n)
                break
    return best


class ThinkSplitter:
    """Route inline ``<think>`` blocks out of a streamed ``content`` delta.

    Feed each content delta in arrival order; each call returns the
    ``(visible, thinking)`` fragments it produced. Fragments are *deltas* — the
    caller accumulates them per channel and hands the running total to
    ``on_progress`` / ``on_thinking``.

    The splitter is stateful: it remembers whether it is inside a think-block
    and holds back a possibly-incomplete tag between calls, so a tag split
    across any number of deltas is still recognized and never leaks as prose.
    A ``</think>`` that shows up outside a block is swallowed rather than shown
    — models emit one when the close tag itself is split across deltas.
    """

    def __init__(self) -> None:
        self._inside = False
        self._carry = ""

    @property
    def inside(self) -> bool:
        """True when the stream is currently inside an unterminated block."""
        return self._inside

    def feed(self, text: str) -> tuple[str, str]:
        """Consume one content delta; return ``(visible, thinking)`` fragments."""
        if not text:
            return "", ""
        visible: list[str] = []
        thinking: list[str] = []
        buf = self._carry + text
        self._carry = ""

        while buf:
            sink = thinking if self._inside else visible

            if self._inside:
                close_at = buf.find(THINK_CLOSE)
                if close_at < 0:
                    self._emit_tail(buf, sink, THINK_CLOSE)
                    break
                sink.append(buf[:close_at])
                self._inside = False
                buf = buf[close_at + len(THINK_CLOSE) :]
                continue

            # Outside a block: an open tag starts one, a stray close tag is
            # swallowed, and whichever comes first wins.
            open_at = buf.find(THINK_OPEN)
            close_at = buf.find(THINK_CLOSE)
            if open_at >= 0 and (close_at < 0 or open_at < close_at):
                visible.append(buf[:open_at])
                self._inside = True
                buf = buf[open_at + len(THINK_OPEN) :]
                continue
            if close_at >= 0:
                visible.append(buf[:close_at])
                buf = buf[close_at + len(THINK_CLOSE) :]
                continue

            self._emit_tail(buf, visible, THINK_OPEN, THINK_CLOSE)
            break

        return "".join(visible), "".join(thinking)

    def _emit_tail(self, buf: str, sink: list[str], *tags: str) -> None:
        """Emit ``buf`` minus a trailing half-tag, which is carried to the next delta."""
        hold = _partial_tag_len(buf, *tags)
        sink.append(buf[: len(buf) - hold] if hold else buf)
        self._carry = buf[len(buf) - hold :] if hold else ""

    def flush(self) -> str:
        """Drop the dangling partial tag and return it.

        The carried fragment can only ever be half a tag (the stream ended), so
        it is never rendered — visible or thinking. Nothing else is pending: any
        unterminated block's text was already emitted to the thinking channel.
        """
        carry, self._carry = self._carry, ""
        return carry

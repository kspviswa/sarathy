"""Markdown → speakable text for LLM answers (shravana stripper rules, minimal subset)."""

from __future__ import annotations

import re

from sarathy.agent.loop import strip_topic_marker

# Reuse shravana plain-text rules (fenced code, URLs, citations, technical normalization).
from sarathy.voice._stripper_core import clean_prose, normalize_spaces

OPENUI_FENCE_RE = re.compile(
    r"```\s*openui(?:-lang)?[^\n]*\n.*?\n```", re.S | re.I
)
GENERIC_FENCE_RE = re.compile(r"```[a-zA-Z0-9_+-]*\n.*?\n```", re.S)
INLINE_CODE_RE = re.compile(r"`[^`\n]+`")
MD_TABLE_BLOCK_RE = re.compile(
    r"(?:^\|.*\|\s*$\n?)+", re.M
)


def _drop_markdown_tables(text: str) -> str:
    lines = text.splitlines()
    out: list[str] = []
    i = 0
    while i < len(lines):
        ln = lines[i]
        if ln.strip().startswith("|") and "|" in ln.strip()[1:]:
            while i < len(lines) and lines[i].strip().startswith("|"):
                i += 1
            continue
        out.append(ln)
        i += 1
    return "\n".join(out)


def strip_for_speech(raw: str) -> str:
    """Return TTS-ready prose from a streaming LLM answer buffer."""
    if not raw:
        return ""
    text, _topic = strip_topic_marker(raw)
    text = OPENUI_FENCE_RE.sub("", text)
    text = GENERIC_FENCE_RE.sub("", text)
    text = INLINE_CODE_RE.sub("", text)
    text = _drop_markdown_tables(text)
    text = MD_TABLE_BLOCK_RE.sub("", text)
    text = normalize_spaces(text)
    return clean_prose(text, ctx="text", min_words=0)

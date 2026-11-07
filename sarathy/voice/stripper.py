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
# Inline emphasis. Bold first so `***x***` collapses cleanly, then italics.
# Woof's splitter passes these through verbatim, so left in place the voice
# reads "asterisk asterisk v0.20.0 asterisk asterisk".
MD_BOLD_RE = re.compile(r"(\*\*|__)(?=\S)(.+?)(?<=\S)\1", re.S)
MD_ITALIC_RE = re.compile(r"(?<![\w*])(\*|_)(?=\S)(.+?)(?<=\S)\1(?![\w*])", re.S)
MD_STRIKE_RE = re.compile(r"~~(?=\S)(.+?)(?<=\S)~~", re.S)
# Block markers at line start: ATX headings, blockquotes, bullets, ordered lists.
MD_LINE_MARKER_RE = re.compile(
    r"^[ \t]*(?:#{1,6}[ \t]+|>[ \t]?|[-*+][ \t]+|\d{1,3}[.)][ \t]+)", re.M
)
MD_HR_RE = re.compile(r"^[ \t]*(?:[-*_][ \t]*){3,}$", re.M)
MD_LINK_RE = re.compile(r"\[([^\]\n]+)\]\([^)\n]*\)")


def _strip_inline_markdown(text: str) -> str:
    """Remove formatting markers, keeping the words inside them."""
    text = MD_LINK_RE.sub(r"\1", text)
    text = MD_STRIKE_RE.sub(r"\1", text)
    text = MD_BOLD_RE.sub(r"\2", text)
    text = MD_ITALIC_RE.sub(r"\2", text)
    text = MD_HR_RE.sub("", text)
    text = MD_LINE_MARKER_RE.sub("", text)
    return text


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
    text = _strip_inline_markdown(text)
    text = normalize_spaces(text)
    return clean_prose(text, ctx="text", min_words=0)

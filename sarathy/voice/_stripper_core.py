"""Minimal port of ~/portals/shravana/stripper.py (plain-text / TTS path only)."""

from __future__ import annotations

import re

CODE_FENCE_RE = re.compile(r"```[a-zA-Z0-9_+-]*\n.*?\n```", re.S)
URL_RE = re.compile(r"https?://\S+|www\.\S+", re.I)
EMAIL_RE = re.compile(r"[\w.+-]+@[\w-]+\.[\w.-]+")
CAPTION_RE = re.compile(
    r"^(figure|fig\.?|table|diagram|chart|image|screenshot|plate|map)\s+[\dIVX]+[\s:.—–-]",
    re.I,
)
SOURCE_RE = re.compile(r"^source[:\s]", re.I)
CONTROL_CHARS_RE = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
BRACKET_CITE_RE = re.compile(r"\[\s*\d+(?:\s*[-\u2013,;]\s*\d+)*\s*\]")
PAREN_NUM_CITE_RE = re.compile(r"\(\s*\d+(?:\s*[-\u2013,;]\s*\d+)*\s*\)")


def normalize_spaces(s: str) -> str:
    s = re.sub(r"[\t\r\f\v ]+", " ", s)
    return s.strip()


def clean_urls(text: str) -> str:
    out_lines = []
    for para in text.split("\n\n"):
        p = para.strip()
        if not p:
            continue
        bare = URL_RE.sub("", p)
        bare_wo_email = EMAIL_RE.sub("", bare).strip()
        if not bare_wo_email or not re.search(r"[A-Za-z]{2,}", bare_wo_email):
            continue
        cleaned = EMAIL_RE.sub("", URL_RE.sub("", p))
        cleaned = re.sub(r"\s+([.,;!?])", r"\1", cleaned)
        cleaned = re.sub(r"\s{2,}", " ", cleaned).strip()
        if cleaned:
            out_lines.append(cleaned)
    return "\n\n".join(out_lines)


def drop_citations(text: str) -> str:
    text = BRACKET_CITE_RE.sub(" ", text)
    text = PAREN_NUM_CITE_RE.sub(" ", text)
    return text


def expand_abbreviations(text: str) -> str:
    for rx, repl in (
        (re.compile(r"\be\.g\.", re.I), "for example"),
        (re.compile(r"\bi\.e\.", re.I), "that is"),
        (re.compile(r"\bvs\.?(?=\s|$)", re.I), "versus"),
    ):
        text = rx.sub(repl, text)
    return text


def normalize_punctuation(text: str) -> str:
    text = re.sub(r"\s*[\u2013\u2014]\s*", ", ", text)
    text = re.sub(r"\s*&\s*", " and ", text)
    return text


def normalize_technical(text: str) -> str:
    text = drop_citations(text)
    text = normalize_punctuation(text)
    return re.sub(r"[ \t]{2,}", " ", text)


def normalize_prose(text: str, min_words: int = 0) -> str:
    text = CONTROL_CHARS_RE.sub("", text)
    text = expand_abbreviations(text)
    paras = []
    for para in re.split(r"\n\s*\n", text):
        p = normalize_spaces(para)
        if not p:
            continue
        if CAPTION_RE.match(p) or SOURCE_RE.match(p):
            continue
        if not re.search(r'[.!?…:;]["\')\]]?$', p):
            p += "."
        paras.append(p)
    result = normalize_technical("\n\n".join(paras))
    if min_words > 0 and len(re.findall(r"\b[\w'-]+\b", result)) < min_words:
        return ""
    return result


def clean_plain_text(raw: str) -> str:
    text = CODE_FENCE_RE.sub("", raw)
    blocks = re.split(r"\n\s*\n", text)
    keep = []
    for blk in blocks:
        b = blk.strip()
        if not b:
            continue
        if CAPTION_RE.match(b.splitlines()[0].strip()) or SOURCE_RE.match(
            b.splitlines()[0].strip()
        ):
            continue
        keep.append(b)
    text = "\n\n".join(keep)
    return clean_urls(text)


def clean_prose(html_or_text: str, ctx: str = "text", min_words: int = 0) -> str:
    if ctx == "text":
        text = clean_plain_text(html_or_text)
    else:
        text = clean_plain_text(html_or_text)
    return normalize_prose(text, min_words=min_words)

"""Sibling module of the echo-package extension (reachable via relative import)."""

from __future__ import annotations


def greet(name: str) -> str:
    return f"Hello, {name}!"

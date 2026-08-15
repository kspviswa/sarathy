"""Sarathy extensions: Pi-compatible extension API, loader, and host.

An extension is a standalone Python module in `~/.sarathy/extensions/` (or a
directory with a `pyproject.toml` declaring `[tool.tau] extensions=[...]`) that
exposes a sync `setup(sarathy)` entry point. It imports only public
`tau_*` / `sarathy` APIs, so extending sarathy never requires sharing its
source code.
"""

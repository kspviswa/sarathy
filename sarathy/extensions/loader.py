"""Discovery of extension modules on the filesystem (tau-faithful subset).

Mirrors the upstream tau project's extension discovery:

- Extensions live under an extensions data directory as single `.py` files or
  package-style directories.
- A directory is an extension if it contains `extension.py` (or `__init__.py`),
  or a `pyproject.toml` declaring ``[tool.tau] extensions = [...]`` (a list of
  entry files, e.g. ``["src/my_ext/extension.py"]``); the manifest takes
  precedence over an `extension.py` in the same directory.
- Names starting with ``_`` or ``.`` are skipped. On name conflicts the
  first-loaded extension wins.
- Package-style extensions load as real packages (package_dir set) so sibling
  modules stay reachable with relative imports.
"""

from __future__ import annotations

import tomllib
from dataclasses import dataclass
from pathlib import Path

from loguru import logger


@dataclass(frozen=True, slots=True)
class DiscoveredExtension:
    name: str
    path: Path
    package_dir: Path | None = None


def discover(data_dir: Path, workspace: Path | None = None) -> list[DiscoveredExtension]:
    """Find extension modules under the extensions data directories."""
    found: list[DiscoveredExtension] = []
    seen_paths: set[Path] = set()
    seen_names: set[str] = set()

    def add(entry: DiscoveredExtension) -> None:
        resolved = entry.path.resolve()
        if resolved in seen_paths:
            return
        if entry.name in seen_names:
            logger.warning("duplicate extension name '{}' ignored (first wins)", entry.name)
            return
        seen_paths.add(resolved)
        seen_names.add(entry.name)
        found.append(entry)

    def collect(root: Path) -> None:
        if not root.exists():
            return
        for entry in sorted(root.iterdir(), key=lambda item: item.name):
            if entry.name.startswith((".", "_")):
                continue
            if entry.is_dir():
                for discovered in _discover_in_dir(entry):
                    add(discovered)
            elif entry.suffix == ".py":
                add(DiscoveredExtension(name=entry.stem, path=entry))

    collect(data_dir / "extensions")
    if workspace is not None:
        collect(workspace / "extensions")
    return found


def _discover_in_dir(dir_path: Path) -> list[DiscoveredExtension]:
    entries: list[DiscoveredExtension] = []
    manifest = _manifest_entries(dir_path)
    if manifest:
        entries.extend(manifest)
        return entries
    entry_file = dir_path / "extension.py"
    if entry_file.is_file():
        entries.append(
            DiscoveredExtension(name=dir_path.name, path=entry_file, package_dir=dir_path)
        )
        return entries
    init_file = dir_path / "__init__.py"
    if init_file.is_file():
        entries.append(
            DiscoveredExtension(name=dir_path.name, path=init_file, package_dir=dir_path)
        )
    return entries


def _manifest_entries(dir_path: Path) -> list[DiscoveredExtension]:
    """Resolve entry files declared under ``[tool.tau] extensions = [...]``."""
    manifest = dir_path / "pyproject.toml"
    if not manifest.is_file():
        return []
    try:
        data = tomllib.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, tomllib.TOMLDecodeError) as exc:
        logger.warning("could not parse pyproject.toml for {}: {}", dir_path, exc)
        return []
    tool_table = data.get("tool")
    tau_table = tool_table.get("tau") if isinstance(tool_table, dict) else None
    declared = tau_table.get("extensions") if isinstance(tau_table, dict) else None
    if declared is None:
        return []
    if not isinstance(declared, list) or not all(isinstance(item, str) for item in declared):
        logger.warning("`tool.tau.extensions` must be a list of file paths for {}", dir_path)
        return []
    entries: list[DiscoveredExtension] = []
    for item in declared:
        entry_file = (dir_path / item).resolve()
        if not entry_file.is_file():
            logger.warning("declared extension entry does not exist: {}", item)
            continue
        name = entry_file.parent.name if entry_file.stem == "extension" else entry_file.stem
        entries.append(
            DiscoveredExtension(name=name, path=entry_file, package_dir=entry_file.parent)
        )
    return entries


def load_module(path: Path, module_name: str, package_dir: Path | None = None):
    """Import a module from a file path, returning the module or None on failure."""
    import importlib.util

    search_locations = [str(package_dir)] if package_dir is not None else None
    spec = importlib.util.spec_from_file_location(
        module_name,
        path,
        submodule_search_locations=search_locations,
    )
    if spec is None or spec.loader is None:
        logger.error("could not create spec for {}", path)
        return None
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        return module
    except Exception as exc:  # noqa: BLE001
        logger.error("failed to import {}: {}", path, exc)
        return None

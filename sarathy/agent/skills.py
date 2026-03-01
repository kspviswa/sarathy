"""Skills loader for agent capabilities with hot-reload support."""

import asyncio
import json
import os
import re
import shutil
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Awaitable, Callable

from loguru import logger

# Default builtin skills directory (relative to this file)
BUILTIN_SKILLS_DIR = Path(__file__).parent.parent / "skills"


@dataclass
class SkillCommand:
    """Represents a command defined in a skill."""

    name: str
    description: str
    help_text: str
    skill_name: str


@dataclass
class SkillInfo:
    """Information about a loaded skill."""

    name: str
    path: Path
    source: str  # "workspace" or "builtin" or "global"
    content: str
    commands: list[SkillCommand] = field(default_factory=list)


class SkillsLoader:
    """
    Loader for agent skills.

    Skills are markdown files (SKILL.md) that teach the agent how to use
    specific tools or perform certain tasks.
    """

    def __init__(self, workspace: Path, builtin_skills_dir: Path | None = None):
        self.workspace = workspace
        self.workspace_skills = workspace / "skills"
        self.global_skills = Path.home() / ".sarathy" / "skills"
        self.builtin_skills = builtin_skills_dir or BUILTIN_SKILLS_DIR

    def list_skills(self, filter_unavailable: bool = True) -> list[dict[str, str]]:
        """
        List all available skills.

        Args:
            filter_unavailable: If True, filter out skills with unmet requirements.

        Returns:
            List of skill info dicts with 'name', 'path', 'source'.
        """
        skills = []

        # Workspace skills (highest priority)
        if self.workspace_skills.exists():
            for skill_dir in self.workspace_skills.iterdir():
                if skill_dir.is_dir():
                    skill_file = skill_dir / "SKILL.md"
                    if skill_file.exists():
                        skills.append(
                            {"name": skill_dir.name, "path": str(skill_file), "source": "workspace"}
                        )

        # Built-in skills
        if self.builtin_skills and self.builtin_skills.exists():
            for skill_dir in self.builtin_skills.iterdir():
                if skill_dir.is_dir():
                    skill_file = skill_dir / "SKILL.md"
                    if skill_file.exists() and not any(s["name"] == skill_dir.name for s in skills):
                        skills.append(
                            {"name": skill_dir.name, "path": str(skill_file), "source": "builtin"}
                        )

        # Filter by requirements
        if filter_unavailable:
            return [s for s in skills if self._check_requirements(self._get_skill_meta(s["name"]))]
        return skills

    def load_skill(self, name: str) -> str | None:
        """
        Load a skill by name.

        Args:
            name: Skill name (directory name).

        Returns:
            Skill content or None if not found.
        """
        # Check workspace first
        workspace_skill = self.workspace_skills / name / "SKILL.md"
        if workspace_skill.exists():
            return workspace_skill.read_text(encoding="utf-8")

        # Check built-in
        if self.builtin_skills:
            builtin_skill = self.builtin_skills / name / "SKILL.md"
            if builtin_skill.exists():
                return builtin_skill.read_text(encoding="utf-8")

        return None

    def load_skills_for_context(self, skill_names: list[str]) -> str:
        """
        Load specific skills for inclusion in agent context.

        Args:
            skill_names: List of skill names to load.

        Returns:
            Formatted skills content.
        """
        parts = []
        for name in skill_names:
            content = self.load_skill(name)
            if content:
                content = self._strip_frontmatter(content)
                parts.append(f"### Skill: {name}\n\n{content}")

        return "\n\n---\n\n".join(parts) if parts else ""

    def build_skills_summary(self) -> str:
        """
        Build a summary of all skills (name, description, path, availability).

        This is used for progressive loading - the agent can read the full
        skill content using read_file when needed.

        Returns:
            XML-formatted skills summary.
        """
        all_skills = self.list_skills(filter_unavailable=False)
        if not all_skills:
            return ""

        def escape_xml(s: str) -> str:
            return s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

        lines = ["<skills>"]
        for s in all_skills:
            name = escape_xml(s["name"])
            path = s["path"]
            desc = escape_xml(self._get_skill_description(s["name"]))
            skill_meta = self._get_skill_meta(s["name"])
            available = self._check_requirements(skill_meta)

            lines.append(f'  <skill available="{str(available).lower()}">')
            lines.append(f"    <name>{name}</name>")
            lines.append(f"    <description>{desc}</description>")
            lines.append(f"    <location>{path}</location>")

            # Show missing requirements for unavailable skills
            if not available:
                missing = self._get_missing_requirements(skill_meta)
                if missing:
                    lines.append(f"    <requires>{escape_xml(missing)}</requires>")

            lines.append(f"  </skill>")
        lines.append("</skills>")

        return "\n".join(lines)

    def _get_missing_requirements(self, skill_meta: dict) -> str:
        """Get a description of missing requirements."""
        missing = []
        requires = skill_meta.get("requires", {})
        for b in requires.get("bins", []):
            if not shutil.which(b):
                missing.append(f"CLI: {b}")
        for env in requires.get("env", []):
            if not os.environ.get(env):
                missing.append(f"ENV: {env}")
        return ", ".join(missing)

    def _get_skill_description(self, name: str) -> str:
        """Get the description of a skill from its frontmatter."""
        meta = self.get_skill_metadata(name)
        if meta and meta.get("description"):
            return meta["description"]
        return name  # Fallback to skill name

    def _strip_frontmatter(self, content: str) -> str:
        """Remove YAML frontmatter from markdown content."""
        if content.startswith("---"):
            match = re.match(r"^---\n.*?\n---\n", content, re.DOTALL)
            if match:
                return content[match.end() :].strip()
        return content

    def _parse_sarathy_metadata(self, raw: str) -> dict:
        """Parse skill metadata JSON from frontmatter (supports sarathy and openclaw keys)."""
        try:
            data = json.loads(raw)
            return data.get("sarathy", data.get("openclaw", {})) if isinstance(data, dict) else {}
        except (json.JSONDecodeError, TypeError):
            return {}

    def _check_requirements(self, skill_meta: dict) -> bool:
        """Check if skill requirements are met (bins, env vars)."""
        requires = skill_meta.get("requires", {})
        for b in requires.get("bins", []):
            if not shutil.which(b):
                return False
        for env in requires.get("env", []):
            if not os.environ.get(env):
                return False
        return True

    def _get_skill_meta(self, name: str) -> dict:
        """Get sarathy metadata for a skill (cached in frontmatter)."""
        meta = self.get_skill_metadata(name) or {}
        return self._parse_sarathy_metadata(meta.get("metadata", ""))

    def get_always_skills(self) -> list[str]:
        """Get skills marked as always=true that meet requirements."""
        result = []
        for s in self.list_skills(filter_unavailable=True):
            meta = self.get_skill_metadata(s["name"]) or {}
            skill_meta = self._parse_sarathy_metadata(meta.get("metadata", ""))
            if skill_meta.get("always") or meta.get("always"):
                result.append(s["name"])
        return result

    def get_skill_metadata(self, name: str) -> dict | None:
        """
        Get metadata from a skill's frontmatter.

        Args:
            name: Skill name.

        Returns:
            Metadata dict or None.
        """
        content = self.load_skill(name)
        if not content:
            return None

        if content.startswith("---"):
            match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
            if match:
                # Simple YAML parsing
                metadata = {}
                for line in match.group(1).split("\n"):
                    if ":" in line:
                        key, value = line.split(":", 1)
                        metadata[key.strip()] = value.strip().strip("\"'")
                return metadata

        return None


class SkillManager:
    """
    Manages skills with hot-reload capability using watchfiles.

    Watches skill directories for changes and automatically reloads
    skills when SKILL.md files are added, modified, or deleted.
    """

    def __init__(self, workspace: Path):
        self.workspace = workspace
        self.workspace_skills = workspace / "skills"
        self.global_skills = Path.home() / ".sarathy" / "skills"
        self.builtin_skills = BUILTIN_SKILLS_DIR

        self._skills: dict[str, SkillInfo] = {}
        self._watch_task: asyncio.Task | None = None
        self._stop_event: asyncio.Event | None = None
        self._reload_callbacks: list[Callable[[], Awaitable[None]]] = []

        # Initial load
        self._load_all_skills()

    def _load_all_skills(self):
        """Load all skills from all directories."""
        # Load global skills
        if self.global_skills.exists():
            self._load_skills_from_dir(self.global_skills, "global")

        # Load workspace skills (override global)
        if self.workspace_skills.exists():
            self._load_skills_from_dir(self.workspace_skills, "workspace")

        # Load built-in skills (lowest priority)
        if self.builtin_skills.exists():
            self._load_skills_from_dir(self.builtin_skills, "builtin")

    def _load_skills_from_dir(self, skills_dir: Path, source: str):
        """Load all skills from a directory."""
        for skill_dir in skills_dir.iterdir():
            if not skill_dir.is_dir():
                continue

            skill_file = skill_dir / "SKILL.md"
            if not skill_file.exists():
                continue

            try:
                content = skill_file.read_text(encoding="utf-8")
                commands = self._parse_commands(content, skill_dir.name)

                self._skills[skill_dir.name] = SkillInfo(
                    name=skill_dir.name,
                    path=skill_file,
                    source=source,
                    content=content,
                    commands=commands,
                )
                logger.debug(f"Loaded skill: {skill_dir.name} from {source}")
            except Exception as e:
                logger.warning(f"Failed to load skill {skill_dir.name}: {e}")

    def _parse_commands(self, content: str, skill_name: str) -> list[SkillCommand]:
        """Parse commands from skill frontmatter."""
        commands = []

        # Extract YAML frontmatter - match from --- to next ---
        if not content.startswith("---"):
            return commands

        # Find the closing ---
        lines = content.split("\n")
        frontmatter_lines = []
        in_frontmatter = False
        for i, line in enumerate(lines):
            if line.strip() == "---" and i > 0:
                break
            frontmatter_lines.append(line)

        frontmatter = "\n".join(frontmatter_lines[1:])  # Skip first ---

        # Try to parse as YAML
        try:
            import yaml

            data = yaml.safe_load(frontmatter) or {}
        except Exception:
            # Fallback: simple parsing
            data = {}

        # Look for commands section
        commands_data = data.get("commands", [])
        if not commands_data:
            return commands

        for cmd in commands_data:
            if isinstance(cmd, dict):
                commands.append(
                    SkillCommand(
                        name=cmd.get("name", ""),
                        description=cmd.get("description", ""),
                        help_text=cmd.get("help", ""),
                        skill_name=skill_name,
                    )
                )

        return commands

    async def start_watching(self):
        """Start watching for file changes."""
        if self._watch_task is not None:
            return

        self._stop_event = asyncio.Event()
        self._watch_task = asyncio.create_task(self._watch_loop())
        logger.info("Skill file watcher started")

    async def stop_watching(self):
        """Stop watching for file changes."""
        if self._watch_task is None:
            return

        self._stop_event.set()
        await self._watch_task
        self._watch_task = None
        self._stop_event = None
        logger.info("Skill file watcher stopped")

    async def _watch_loop(self):
        """Main watch loop using watchfiles."""
        try:
            from watchfiles import awatch

            watch_dirs = []
            if self.workspace_skills.exists():
                watch_dirs.append(self.workspace_skills)
            if self.global_skills.exists():
                watch_dirs.append(self.global_skills)

            if not watch_dirs:
                return

            async for changes in awatch(*watch_dirs, debounce=500, stop_event=self._stop_event):
                for change_type, path in changes:
                    if not path.endswith("SKILL.md"):
                        continue

                    logger.debug(f"Skill file changed: {change_type} {path}")
                    await self._handle_file_change(change_type, path)

                    # Notify callbacks
                    for callback in self._reload_callbacks:
                        try:
                            await callback()
                        except Exception as e:
                            logger.error(f"Reload callback failed: {e}")
        except Exception as e:
            logger.error(f"Skill watcher error: {e}")

    async def _handle_file_change(self, change_type: str, path: str):
        """Handle a file change event."""
        path_obj = Path(path)
        skill_name = path_obj.parent.name

        if change_type == "deleted":
            if skill_name in self._skills:
                del self._skills[skill_name]
                logger.info(f"Skill unloaded: {skill_name}")
        else:
            # Reload the skill
            if path_obj.exists():
                try:
                    content = path_obj.read_text(encoding="utf-8")
                    source = "workspace" if self.workspace_skills in path_obj.parents else "global"
                    commands = self._parse_commands(content, skill_name)

                    self._skills[skill_name] = SkillInfo(
                        name=skill_name,
                        path=path_obj,
                        source=source,
                        content=content,
                        commands=commands,
                    )
                    logger.info(f"Skill reloaded: {skill_name}")
                except Exception as e:
                    logger.warning(f"Failed to reload skill {skill_name}: {e}")

    def on_reload(self, callback: Callable[[], Awaitable[None]]):
        """Register a callback to be called when skills are reloaded."""
        self._reload_callbacks.append(callback)

    def get_skill(self, name: str) -> SkillInfo | None:
        """Get a skill by name."""
        return self._skills.get(name)

    def get_all_skills(self) -> list[SkillInfo]:
        """Get all loaded skills."""
        return list(self._skills.values())

    def get_commands(self) -> list[SkillCommand]:
        """Get all commands from all skills."""
        commands = []
        for skill in self._skills.values():
            commands.extend(skill.commands)
        return commands

    def get_command(self, name: str) -> SkillCommand | None:
        """Get a command by name."""
        for skill in self._skills.values():
            for cmd in skill.commands:
                if cmd.name == name:
                    return cmd
        return None

    def get_skill_by_command(self, command_name: str) -> SkillInfo | None:
        """Get the skill that provides a command."""
        for skill in self._skills.values():
            for cmd in skill.commands:
                if cmd.name == command_name:
                    return skill
        return None

    def list_skills(self) -> list[dict[str, str]]:
        """List all skills (for backward compatibility)."""
        result = []
        for skill in self._skills.values():
            result.append(
                {
                    "name": skill.name,
                    "path": str(skill.path),
                    "source": skill.source,
                }
            )
        return result

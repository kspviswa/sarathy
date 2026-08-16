"""Skill management tool for creating, updating, and managing reusable skills."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any

from sarathy.agent.tools.base import Tool


def _slugify(name: str) -> str:
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9\s-]", "", slug)
    slug = re.sub(r"[\s]+", "-", slug)
    return slug[:64].strip("-")


class SkillManageTool(Tool):
    """Create, update, and manage reusable skill files."""

    def __init__(self, workspace: Path):
        self._skills_dir = workspace / "skills"
        self._skills_dir.mkdir(parents=True, exist_ok=True)

    @property
    def name(self) -> str:
        return "skill_manage"

    @property
    def description(self) -> str:
        return (
            "Manage reusable skills. Skills capture how to do a class of task — "
            "workflows, procedures, and conventions that recur. Create skills for "
            "multi-step workflows (5+ steps), user corrections about approach, "
            "or non-obvious patterns. Name skills at the class level, not after "
            "specific sessions or errors."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "edit", "patch", "list", "view", "delete"],
                    "description": "Operation to perform",
                },
                "name": {
                    "type": "string",
                    "description": "Skill name (will be slugified for directory)",
                },
                "description": {
                    "type": "string",
                    "description": "One-line description of what this skill does",
                },
                "content": {
                    "type": "string",
                    "description": "Full SKILL.md content (for create/edit)",
                },
                "old_string": {
                    "type": "string",
                    "description": "Text to find (for patch action)",
                },
                "new_string": {
                    "type": "string",
                    "description": "Replacement text (for patch action)",
                },
            },
            "required": ["action"],
        }

    async def execute(self, **kwargs: Any) -> str:
        action = kwargs.get("action", "")

        if action == "list":
            return self._list_skills()

        if action == "view":
            name = kwargs.get("name", "")
            if not name:
                return "Error: 'name' is required for view."
            return self._view_skill(name)

        if action == "create":
            return self._create_skill(
                kwargs.get("name", ""),
                kwargs.get("description", ""),
                kwargs.get("content", ""),
            )

        if action == "edit":
            return self._edit_skill(
                kwargs.get("name", ""),
                kwargs.get("content", ""),
            )

        if action == "patch":
            return self._patch_skill(
                kwargs.get("name", ""),
                kwargs.get("old_string", ""),
                kwargs.get("new_string", ""),
            )

        if action == "delete":
            return self._delete_skill(kwargs.get("name", ""))

        return f"Error: unknown action '{action}'."

    def _skill_path(self, name: str) -> Path:
        return self._skills_dir / _slugify(name)

    def _skill_file(self, name: str) -> Path:
        return self._skill_path(name) / "SKILL.md"

    def _list_skills(self) -> str:
        skills = []
        if not self._skills_dir.exists():
            return "No skills found."
        for d in sorted(self._skills_dir.iterdir()):
            if d.is_dir():
                skill_file = d / "SKILL.md"
                if skill_file.exists():
                    desc = self._extract_description(skill_file)
                    skills.append(f"- **{d.name}**: {desc}" if desc else f"- **{d.name}**")
        return "\n".join(skills) if skills else "No skills found."

    def _view_skill(self, name: str) -> str:
        skill_file = self._skill_file(name)
        if not skill_file.exists():
            return f"Skill '{name}' not found."
        return skill_file.read_text(encoding="utf-8")

    def _create_skill(self, name: str, description: str, content: str) -> str:
        if not name:
            return "Error: 'name' is required for create."
        skill_file = self._skill_file(name)
        if skill_file.exists():
            return f"Skill '{name}' already exists. Use 'edit' or 'patch' to modify."

        if not content:
            content = self._default_skill_md(name, description)

        skill_file.parent.mkdir(parents=True, exist_ok=True)
        skill_file.write_text(content, encoding="utf-8")
        return f"Created skill '{_slugify(name)}'."

    def _edit_skill(self, name: str, content: str) -> str:
        if not name:
            return "Error: 'name' is required for edit."
        if not content:
            return "Error: 'content' is required for edit."
        skill_file = self._skill_file(name)
        if not skill_file.exists():
            return f"Skill '{name}' not found. Use 'create' first."
        skill_file.write_text(content, encoding="utf-8")
        return f"Updated skill '{_slugify(name)}'."

    def _patch_skill(self, name: str, old_string: str, new_string: str) -> str:
        if not name:
            return "Error: 'name' is required for patch."
        if not old_string:
            return "Error: 'old_string' is required for patch."
        skill_file = self._skill_file(name)
        if not skill_file.exists():
            return f"Skill '{name}' not found."
        current = skill_file.read_text(encoding="utf-8")
        if old_string not in current:
            return f"Error: old_string not found in skill '{name}'."
        updated = current.replace(old_string, new_string, 1)
        skill_file.write_text(updated, encoding="utf-8")
        return f"Patched skill '{_slugify(name)}'."

    def _delete_skill(self, name: str) -> str:
        if not name:
            return "Error: 'name' is required for delete."
        skill_path = self._skill_path(name)
        if not skill_path.exists():
            return f"Skill '{name}' not found."
        import shutil

        shutil.rmtree(skill_path)
        return f"Deleted skill '{_slugify(name)}'."

    def _extract_description(self, skill_file: Path) -> str:
        try:
            content = skill_file.read_text(encoding="utf-8")
            if content.startswith("---"):
                end = content.find("---", 3)
                if end > 0:
                    frontmatter = content[3:end]
                    for line in frontmatter.splitlines():
                        if line.strip().startswith("description:"):
                            return line.split(":", 1)[1].strip().strip('"').strip("'")
            first_line = content.splitlines()[0] if content.strip() else ""
            if first_line.startswith("#"):
                return first_line.lstrip("#").strip()
        except Exception:
            pass
        return ""

    def _default_skill_md(self, name: str, description: str) -> str:
        slug = _slugify(name)
        desc_line = f"{description}" if description else f"How to {name}"
        return (
            f"---\n"
            f"name: {slug}\n"
            f"description: {desc_line}\n"
            f"version: 1.0.0\n"
            f"---\n\n"
            f"# {name}\n\n"
            f"## Steps\n\n"
            f"1. TODO\n\n"
            f"## Pitfalls\n\n"
            f"- None documented yet\n"
        )

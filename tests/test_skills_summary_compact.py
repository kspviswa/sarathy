"""Tests for the compact skills summary (job 68 §3A)."""

from __future__ import annotations

import json
from pathlib import Path

from sarathy.agent.skills import SkillsLoader


def _write_skill(
    workspace: Path,
    name: str,
    *,
    description: str | None = None,
    category: str | None = None,
    metadata: dict | None = None,
    body: str = "# Skill\n\nBody text.\n",
) -> None:
    """Create a skill directory with a minimal SKILL.md frontmatter."""
    skill_dir = workspace / "skills" / name
    skill_dir.mkdir(parents=True, exist_ok=True)
    lines = ["---", f"name: {name}"]
    if description:
        lines.append(f"description: {description}")
    if category:
        lines.append(f"category: {category}")
    if metadata:
        lines.append(f"metadata: {json.dumps(metadata)}")
    lines.append("---")
    lines.append(body)
    (skill_dir / "SKILL.md").write_text("\n".join(lines), encoding="utf-8")


def _load(tmp_path: Path) -> SkillsLoader:
    # Isolate from the packaged builtin skills (only workspace skills matter).
    return SkillsLoader(tmp_path, builtin_skills_dir=tmp_path / "no-builtin")


def test_groups_by_frontmatter_category(tmp_path) -> None:
    workspace = tmp_path
    _write_skill(workspace, "alpha-a", description="Alpha A does things.", category="mycat")
    _write_skill(workspace, "alpha-b", description="Alpha B does more.", category="mycat")
    _write_skill(workspace, "beta-c", description="Beta C unrelated.", category="mycat")

    summary = _load(workspace).build_skills_summary()
    assert '<skillCategory name="mycat" count="3"' in summary
    assert 'available="3"' in summary
    for member in ("alpha-a", "alpha-b", "beta-c"):
        assert member in summary


def test_prefix_fallback_when_no_category(tmp_path) -> None:
    workspace = tmp_path
    _write_skill(workspace, "decode-daily-curation", body="# D\n")
    _write_skill(workspace, "decode-other-thing", body="# D\n")
    _write_skill(workspace, "quarto-render-simple", body="# Q\n")
    _write_skill(workspace, "memory", body="# M\n")

    summary = _load(workspace).build_skills_summary()
    assert '<skillCategory name="decode" count="2" available="2"' in summary
    assert '<skillCategory name="quarto" count="1"' in summary
    assert '<skillCategory name="other" count="1"' in summary
    assert "decode-daily-curation, decode-other-thing" in summary
    assert "memory" in summary


def test_no_per_skill_location_or_description_elements(tmp_path) -> None:
    workspace = tmp_path
    _write_skill(workspace, "web-fetch-page", description="Fetch a page.", category="web")
    summary = _load(workspace).build_skills_summary()

    assert "<location>" not in summary
    assert "<description>" not in summary
    # The compact block carries the category description as an attribute.
    assert 'description="Fetch a page."' in summary


def test_description_one_line_and_capped_at_120(tmp_path) -> None:
    workspace = tmp_path
    long = (
        "This is the very first sentence of a long-winded description that keeps going "
        "and going across many words without end until it finally crosses the 120 char "
        "boundary that the summary must enforce.\n"
        "A second sentence that must never appear.\n> A quote line too."
    )
    _write_skill(workspace, "long-desc", description=long, category="docs")
    summary = _load(workspace).build_skills_summary()

    block = next(line for line in summary.splitlines() if 'name="docs"' in line)
    assert "description=" in block
    desc = block.split('description="', 1)[1].split('">', 1)[0]
    assert len(desc) <= 120
    assert "\n" not in desc
    assert "first sentence" in desc
    assert "second sentence" not in desc


def test_availability_counts_and_false_flag(tmp_path) -> None:
    workspace = tmp_path
    block = {"sarathy": {"requires": {"bins": ["definitely-not-installed-bin-xyz"]}}}
    _write_skill(workspace, "build-partial", description="Works here.", category="build")
    _write_skill(workspace, "build-broken", description="Needs deps.", category="build", metadata=block)
    _write_skill(workspace, "doc-only", description="Docs only.", category="docs", metadata=block)

    summary = _load(workspace).build_skills_summary()
    assert '<skillCategory name="build" count="2" available="1"' in summary
    assert '<skillCategory name="docs" count="1" available="false"' in summary


def test_members_comma_separated_and_bounded_output(tmp_path) -> None:
    workspace = tmp_path
    for i in range(25):
        _write_skill(
            workspace,
            f"jobs-{i:03d}",
            description=f"Job skill number {i} for the jobs family.",
            category="jobs",
        )
    summary = _load(workspace).build_skills_summary()

    assert '<skillCategory name="jobs" count="25" available="25"' in summary
    assert "jobs-000, jobs-001" in summary
    assert "jobs-024" in summary
    assert len(summary) < 5_000

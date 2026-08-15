"""Memory (MEMORY.md) and MemoryArchivist behavior."""

from __future__ import annotations

from pathlib import Path

from sarathy.engine.memory import Memory, MemoryArchivist


def test_memory_read_empty(tmp_path: Path) -> None:
    mem = Memory(tmp_path)
    assert mem.read() == ""
    assert mem.context_block() == ""


def test_memory_write_and_read(tmp_path: Path) -> None:
    mem = Memory(tmp_path)
    mem.write("# lessons\n- be kind")
    assert "be kind" in mem.read()


def test_add_facts_appends_deduped(tmp_path: Path) -> None:
    mem = Memory(tmp_path)
    assert mem.add_facts(["  user likes coffee ", "user likes coffee", "(nothing)", ""]) == 1
    content = mem.read()
    assert content.count("user likes coffee") == 1
    assert "(nothing)" not in content


def test_add_facts_duplicate_returns_zero(tmp_path: Path) -> None:
    mem = Memory(tmp_path)
    assert mem.add_facts(["tea over coffee"]) == 1
    assert mem.add_facts(["tea over coffee"]) == 0


def test_enforce_max_size_keeps_hard_lessons(tmp_path: Path) -> None:
    mem = Memory(tmp_path, max_size=200)
    big_section = "## 2026-08-14\n" + "\n".join(f"- note {i}" for i in range(200))
    mem.write("## HARD LESSONS\nnever panic\n\n" + big_section)
    out = mem.enforce_max_size(mem.read())
    assert "HARD LESSONS" in out
    assert len(out) <= 230


def test_enforce_max_size_drops_oldest_first(tmp_path: Path) -> None:
    mem = Memory(tmp_path, max_size=200)
    old = "## 2026-08-01\n" + "\n".join(f"- old detail {i}" for i in range(30))
    new = "## 2026-08-14\n" + "\n".join(f"- new note {i}" for i in range(30))
    out = mem.enforce_max_size(old + "\n\n" + new)
    assert len(out) <= 200
    assert "new note" in out
    assert "old detail" not in out


def test_archivist_is_running_when_enabled() -> None:
    arch = MemoryArchivist(
        memory=Memory(Path("/tmp/x")), provider=None, model="m", interval_s=9999
    )
    assert arch.enabled is True


async def test_consolidate_returns_zero_on_empty_excerpt(tmp_path: Path) -> None:
    arch = MemoryArchivist(
        memory=Memory(tmp_path), provider=None, model="m", interval_s=9999
    )
    assert await arch.consolidate("") == 0
    assert await arch.consolidate("   ") == 0

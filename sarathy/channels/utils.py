"""Utility functions for channel message processing."""

from __future__ import annotations

import re

from rich.console import Console
from rich.table import Table


def detect_and_convert_tables(text: str) -> str:
    """
    Detect markdown tables in text and convert them to ASCII tables wrapped in code blocks.

    Args:
        text: Input text potentially containing markdown tables

    Returns:
        Text with markdown tables converted to ASCII tables in code blocks
    """
    if not text:
        return text

    table_pattern = re.compile(
        r"(\|(?:[^\n|]+\|)+)\n(\|(?:\s*[-:]+\s*\|)+)\n((?:\|(?:[^\n|]+\|)+\n?)+)",
        re.MULTILINE,
    )

    def convert_match(match: re.Match) -> str:
        header_line = match.group(1)
        _ = match.group(2)  # separator line (unused but needed for regex group)
        data_lines = match.group(3).strip().split("\n")

        headers = [cell.strip() for cell in header_line.strip("|").split("|")]
        rows = []
        for line in data_lines:
            row = [cell.strip() for cell in line.strip("|").split("|")]
            if row and any(cell for cell in row):
                rows.append(row)

        if not headers or not rows:
            return match.group(0)

        ascii_table = _build_ascii_table(headers, rows)
        return f"```\n{ascii_table}\n```"

    return table_pattern.sub(convert_match, text)


def _build_ascii_table(headers: list[str], rows: list[list[str]]) -> str:
    """
    Build an ASCII table using rich library.

    Args:
        headers: List of column headers
        rows: List of data rows

    Returns:
        ASCII formatted table as string
    """
    table = Table(show_header=True, header_style="bold", box=None)

    for header in headers:
        table.add_column(header)

    for row in rows:
        table.add_row(*row)

    console = Console(force_terminal=False, width=120, no_color=True)
    with console.capture() as capture:
        console.print(table)

    return capture.get()

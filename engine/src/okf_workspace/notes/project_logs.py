"""Append-only project journals shared by direct entries and Capture promotion."""

from __future__ import annotations

import re

_DATES = re.compile(r"(?m)^## (\d{4}-\d{2}-\d{2})[ \t]*\r?$")


def render_project_log_append(text: str, heading: str, entry: str) -> str:
    """Preserve existing history verbatim and append at the end of the journal.

    Legacy descending history is never reordered. A new date section is appended
    when the last section is not today's date, even if that date occurred earlier.
    """

    content = entry.strip()
    if not content:
        raise ValueError("project log entry cannot be empty")
    dates = list(_DATES.finditer(text))
    same_date = bool(dates and dates[-1].group(0).strip() == heading)
    addition = f"- {content}" if same_date else f"{heading}\n\n- {content}"
    return f"{text.rstrip()}\n\n{addition}\n"


def latest_project_log_section(text: str) -> str:
    """Find the latest day's last entry, supporting preserved descending history."""

    headings = list(_DATES.finditer(text))
    if not headings:
        return text
    position = max(range(len(headings)), key=lambda index: (headings[index].group(1), index))
    heading = headings[position]
    end = headings[position + 1].start() if position + 1 < len(headings) else len(text)
    section = text[heading.end() : end]
    entries = list(re.finditer(r"(?m)^- \S", section))
    if entries:
        section = section[entries[-1].start() :]
    return f"{heading.group(0)}\n\n{section.strip()}"

"""Deterministic helpers shared by future user-invoked AI organization."""

from __future__ import annotations

import re


class ManagedRegionError(ValueError):
    """Raised when a named AI-managed region is missing or ambiguous."""


def replace_managed_region(text: str, name: str, replacement: str) -> str:
    start = f'<!-- ai:auto:start name="{name}" -->'
    end = f'<!-- ai:auto:end name="{name}" -->'
    if text.count(start) != 1 or text.count(end) != 1:
        raise ManagedRegionError(f"managed region must occur exactly once: {name}")
    before, remainder = text.split(start, 1)
    _, after = remainder.split(end, 1)
    body = replacement.strip()
    return f"{before}{start}\n{body}\n{end}{after}"


class HeadingSectionError(ValueError):
    """Raised when a requested Markdown heading is missing or ambiguous."""


_HEADING = re.compile(r"^(#{1,6})[ \t]+(.+?)[ \t]*$")
_FENCE = re.compile(r"^[ \t]*(`{3,}|~{3,})")


def _heading_bounds(text: str, heading: str) -> tuple[int, int, int]:
    requested = heading.strip().lstrip("#").strip().casefold()
    if not requested:
        raise HeadingSectionError("heading must not be empty")
    lines = text.splitlines()
    matches: list[tuple[int, int]] = []
    fence_character: str | None = None
    fence_size = 0
    for index, line in enumerate(lines):
        fence = _FENCE.match(line)
        if fence is not None:
            marker = fence.group(1)
            if fence_character is None:
                fence_character = marker[0]
                fence_size = len(marker)
            elif marker[0] == fence_character and len(marker) >= fence_size:
                fence_character = None
                fence_size = 0
            continue
        if fence_character is not None:
            continue
        match = _HEADING.match(line)
        if match is not None and match.group(2).strip().casefold() == requested:
            matches.append((index, len(match.group(1))))
    if len(matches) != 1:
        raise HeadingSectionError(f"heading must occur exactly once outside code fences: {heading}")
    start, level = matches[0]
    end = len(lines)
    fence_character = None
    fence_size = 0
    for index in range(start + 1, len(lines)):
        line = lines[index]
        fence = _FENCE.match(line)
        if fence is not None:
            marker = fence.group(1)
            if fence_character is None:
                fence_character = marker[0]
                fence_size = len(marker)
            elif marker[0] == fence_character and len(marker) >= fence_size:
                fence_character = None
                fence_size = 0
            continue
        if fence_character is not None:
            continue
        match = _HEADING.match(line)
        if match is not None and len(match.group(1)) <= level:
            end = index
            break
    return start, end, level


def read_heading_section(text: str, heading: str) -> str:
    """Read one exact heading body without crossing a peer or parent heading."""

    start, end, _level = _heading_bounds(text, heading)
    return "\n".join(text.splitlines()[start + 1 : end]).strip()


def replace_heading_section(text: str, heading: str, replacement: str) -> str:
    """Replace one exact heading body while preserving the rest of the document."""

    lines = text.splitlines()
    start, end, _level = _heading_bounds(text, heading)
    body = replacement.strip()
    updated = [*lines[: start + 1], ""]
    if body:
        updated.extend(body.splitlines())
        updated.append("")
    updated.extend(lines[end:])
    while len(updated) >= 2 and updated[-1] == "" and updated[-2] == "":
        updated.pop()
    return "\n".join(updated).rstrip() + "\n"

"""Collect open Markdown tasks without creating a second task authority."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

_TASK = re.compile(r"^\s*-\s+\[ \]\s+(.+?)\s*$")
_FORMAL_TASK = re.compile(r"(?:^|\s)#task(?:\s|$)", re.IGNORECASE)
_SKIPPED_DIRECTORIES = {".agents", ".claudian", ".git", ".obsidian", ".trash"}
_SKIPPED_SYSTEM_SECTIONS = {"contracts", "reports", "templates", "views"}


@dataclass(frozen=True, slots=True)
class TaskItem:
    path: str
    line: int
    text: str


def _tasks_in_file(path: Path, vault: Path) -> list[TaskItem]:
    relative = path.relative_to(vault).as_posix()
    tasks: list[TaskItem] = []
    in_fence = False
    fence_marker: str | None = None
    for number, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        stripped = line.lstrip()
        marker = stripped[:3]
        if marker in {"```", "~~~"}:
            if not in_fence:
                in_fence = True
                fence_marker = marker
            elif marker == fence_marker:
                in_fence = False
                fence_marker = None
            continue
        if in_fence:
            continue
        match = _TASK.match(line)
        if match and _FORMAL_TASK.search(match.group(1)):
            visible = _FORMAL_TASK.sub(" ", match.group(1)).strip()
            tasks.append(TaskItem(path=relative, line=number, text=visible))
    return tasks


def collect_tasks(vault: Path) -> list[TaskItem]:
    vault = vault.resolve()
    items: list[TaskItem] = []
    for path in sorted(vault.rglob("*.md")):
        # index.md is a derived human navigation page.  In particular, its
        # task section mirrors tasks from authoritative notes and must never
        # become a task source itself.
        if path.name == "index.md":
            continue
        relative = path.relative_to(vault)
        if path.name == "AGENTS.md" and len(relative.parts) == 1:
            continue
        if any(part in _SKIPPED_DIRECTORIES for part in relative.parts):
            continue
        if (
            len(relative.parts) >= 2
            and relative.parts[0] == "system"
            and relative.parts[1] in _SKIPPED_SYSTEM_SECTIONS
        ):
            continue
        items.extend(_tasks_in_file(path, vault))
    return items


def render_task_projection(tasks: list[TaskItem]) -> str:
    if not tasks:
        return "当前没有未完成任务。"
    return "\n".join(
        f"- [ ] {item.text} — [{item.path}](/{item.path}#L{item.line})" for item in tasks
    )

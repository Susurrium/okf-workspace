"""Collect open Markdown tasks without creating a second task authority."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import cast

from markdown_it import MarkdownIt

from okf_workspace.okf.document_role import DocumentRole, document_role, is_workbench_backup
from okf_workspace.okf.frontmatter import FrontmatterError, read_document

_TASK = re.compile(r"^\s*[-*+]\s+\[(.)\]\s+(.+?)\s*$")
_MARKDOWN = MarkdownIt("commonmark")
_TASK_METADATA = [
    re.compile(r"\s*⏰\s*\d{4}-\d{2}-\d{2}(?:\s+\d{2}:\d{2})?"),
    re.compile(r"\s*\[(?:due|start|end|scheduled|completion|priority)::[^\]]+\]", re.IGNORECASE),
    re.compile(r"\s*[📅🛫🛬⏳✅]\s*\d{4}-\d{2}-\d{2}"),
    re.compile(r"\s*<!--collapsed-->\s*$"),
    re.compile(r"\s+\^[a-zA-Z0-9-]+\s*$"),
    re.compile(
        r"\s*\[(?:okf-(?:start|due|scheduled|completion)-time|"
        r"repeat|id|dependsOn|onCompletion|created|cancelled|project|course)::[^\]]+\]",
        re.IGNORECASE,
    ),
    re.compile(r"\s*[\u2795❌]\s*\d{4}-\d{2}-\d{2}"),
    re.compile(r"\s*[🔺⏫🔼🔽⏬]"),
    re.compile(r"\s*(?:🆔|⛔)\s*[a-zA-Z0-9_, -]+"),
    re.compile(r"\s*🔁\s*[a-zA-Z0-9, !]+"),
    re.compile(r"\s*🏁\s*[a-zA-Z]+"),
]
_SKIPPED_DIRECTORIES = {".agents", ".claudian", ".git", ".obsidian", ".trash"}
_SKIPPED_SYSTEM_SECTIONS = {"contracts", "reports", "templates", "views"}


@dataclass(frozen=True, slots=True)
class TaskItem:
    path: str
    line: int
    text: str


def _tasks_in_file(
    path: Path, vault: Path, statuses: dict[str, str], global_filter: str
) -> list[TaskItem]:
    relative = path.relative_to(vault).as_posix()
    lines = path.read_text(encoding="utf-8").splitlines()
    if not any(
        (match := _TASK.match(line)) and global_filter in match.group(2) for line in lines
    ):
        return []
    yaml_end = -1
    artifact_type = ""
    if lines and lines[0].strip() == "---":
        for index, line in enumerate(lines[1:], start=1):
            if line.strip() == "---":
                yaml_end = index
                break
        document = read_document(path)
        if document_role(document) is not DocumentRole.ARTIFACT:
            return []
        artifact_type = document.type.lower()
    excludes_formal_tasks = artifact_type in {"source", "source text", "digest"}
    tasks: list[TaskItem] = []
    ignored: set[int] = set()
    for token in _MARKDOWN.parse("\n".join(lines[yaml_end + 1 :])):
        if token.type in {"fence", "code_block"} and token.map:
            ignored.update(range(token.map[0] + yaml_end + 1, token.map[1] + yaml_end + 1))
    for number, line in enumerate(lines, start=1):
        if number - 1 <= yaml_end:
            continue
        if number - 1 in ignored:
            continue
        match = _TASK.match(line)
        if (
            match
            and statuses.get(match.group(1), "TODO") not in {"DONE", "CANCELLED", "NON_TASK"}
            and not excludes_formal_tasks
            and global_filter in match.group(2)
        ):
            visible = (
                match.group(2).replace(global_filter, "", 1).strip()
                if global_filter
                else match.group(2)
            )
            for metadata in _TASK_METADATA:
                visible = metadata.sub("", visible).strip()
            visible = re.sub(r"\s+", " ", visible)
            tasks.append(TaskItem(path=relative, line=number, text=visible))
    return tasks


def collect_tasks(vault: Path) -> list[TaskItem]:
    vault = vault.resolve()
    statuses = {" ": "TODO", "x": "DONE", "X": "DONE", "-": "CANCELLED", "/": "IN_PROGRESS"}
    global_filter = "#task"
    settings_view = vault / "system" / "views" / "Tasks.md"
    if settings_view.is_file():
        settings = read_document(settings_view).frontmatter
        projection: object = settings.get("task_projection")
        if projection is not None:
            if not isinstance(projection, dict):
                raise ValueError("Unsupported task_projection configuration")
            projection_fields = cast(dict[str, object], projection)
            if projection_fields.get("version") != 1:
                raise ValueError("Unsupported task_projection configuration")
            value = projection_fields.get("global_filter")
            if not isinstance(value, str):
                raise ValueError("task_projection.global_filter must be a string")
            global_filter = value
            if projection_fields.get("global_query"):
                raise ValueError(
                    "Engine task projection cannot evaluate the Tasks global query; "
                    "use Dashboard Tasks views"
                )
        configured: object = settings.get("task_statuses")
        if configured is not None:
            if not isinstance(configured, dict):
                raise ValueError("task_statuses must map checkbox symbols to status types")
            for symbol, state in cast(dict[object, object], configured).items():
                if (
                    not isinstance(symbol, str)
                    or len(symbol) != 1
                    or not isinstance(state, str)
                    or state
                    not in {"TODO", "DONE", "IN_PROGRESS", "ON_HOLD", "CANCELLED", "NON_TASK"}
                ):
                    raise ValueError("Invalid task_statuses entry")
                statuses[symbol] = state
    items: list[TaskItem] = []
    for path in sorted(vault.rglob("*.md")):
        # index.md is a derived human navigation page.  In particular, its
        # task section mirrors tasks from authoritative notes and must never
        # become a task source itself.
        if path.name == "index.md":
            if path == vault / "index.md":
                continue
            try:
                document = read_document(path)
            except (FrontmatterError, OSError):
                continue
            if document_role(document) is not DocumentRole.WORKBENCH:
                continue
        relative = path.relative_to(vault)
        if is_workbench_backup(relative.as_posix()):
            continue
        if path.name == "AGENTS.md" and len(relative.parts) == 1:
            continue
        if any(part.startswith(".") or part in _SKIPPED_DIRECTORIES for part in relative.parts):
            continue
        if (
            len(relative.parts) >= 2
            and relative.parts[0] == "system"
            and relative.parts[1] in _SKIPPED_SYSTEM_SECTIONS
        ):
            continue
        items.extend(_tasks_in_file(path, vault, statuses, global_filter))
    return items


def render_task_projection(tasks: list[TaskItem]) -> str:
    if not tasks:
        return "当前没有未完成任务。"
    return "\n".join(
        f"- [ ] {item.text} — [{item.path}](/{item.path}#L{item.line})" for item in tasks
    )

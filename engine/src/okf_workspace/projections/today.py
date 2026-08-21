"""Build the Today data projection without writing a second authority."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date
from pathlib import Path

from okf_workspace.okf.frontmatter import FrontmatterError, read_document

from .tasks import collect_tasks


@dataclass(frozen=True, slots=True)
class TodaySnapshot:
    date: date
    daily_path: str
    daily_exists: bool
    open_tasks: int
    open_captures: int
    active_projects: tuple[str, ...]


def build_today_snapshot(vault: Path, target_date: date | None = None) -> TodaySnapshot:
    vault = vault.resolve()
    value = target_date or date.today()
    daily_path = f"life/daily/{value:%Y}/{value:%m}/{value}.md"

    open_captures = 0
    for path in (vault / "inbox" / "captures").rglob("*.md"):
        try:
            if read_document(path).frontmatter.get("capture_status") == "open":
                open_captures += 1
        except FrontmatterError:
            continue

    active_projects: list[str] = []
    for path in (vault / "projects").glob("*/project.md"):
        try:
            document = read_document(path)
        except FrontmatterError:
            continue
        if document.frontmatter.get("project_status") == "active":
            active_projects.append(path.relative_to(vault).as_posix())

    return TodaySnapshot(
        date=value,
        daily_path=daily_path,
        daily_exists=(vault / daily_path).is_file(),
        open_tasks=len(collect_tasks(vault)),
        open_captures=open_captures,
        active_projects=tuple(sorted(active_projects)),
    )

"""Create canonical OKF concepts at their authoritative paths."""

from __future__ import annotations

import calendar
import hashlib
from collections.abc import Callable, Sequence
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any, Literal

from okf_workspace.ingestion import DIRECT_ENTRY
from okf_workspace.okf.artifacts import render_artifact_body
from okf_workspace.okf.file_io import atomic_write_bytes, document_lock
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document
from okf_workspace.okf.paths import resolve_bundle_path, slugify
from okf_workspace.okf.project_category import normalize_project_category
from okf_workspace.okf.relations import explicit_context_fields, inherited_context_fields

from .organize import replace_managed_region
from .project_logs import render_project_log_append

Clock = Callable[[], datetime]
ReviewPeriod = Literal["weekly", "monthly", "yearly"]


def _system_clock() -> datetime:
    return datetime.now().astimezone()


def _iso(moment: datetime) -> str:
    return moment.isoformat(timespec="seconds")


def _source_entries(paths: Sequence[str]) -> list[dict[str, str]]:
    return [{"resource": path if path.startswith("/") else f"/{path}"} for path in paths]


def _description(content: str, fallback: str) -> str:
    visible = next(
        (
            line.strip()
            for line in content.splitlines()
            if line.strip() and not line.lstrip().startswith(("#", "<!--"))
        ),
        "",
    )
    return (visible or fallback).strip()[:200]


def _without_repeated_title(title: str, content: str) -> str:
    """Keep a title-derived first line from appearing again below the H1."""

    lines = content.strip().splitlines()
    if lines and lines[0].strip() == title.strip():
        lines = lines[1:]
    return "\n".join(lines).strip()


class NoteService:
    def __init__(self, vault: Path, *, clock: Clock = _system_clock) -> None:
        self.vault = vault.resolve()
        self.clock = clock

    def _create(
        self,
        relative: Path,
        *,
        note_type: str,
        title: str,
        body: str,
        status: str | None = None,
        fields: dict[str, Any] | None = None,
    ) -> Path:
        moment = self.clock()
        frontmatter: dict[str, Any] = {
            "type": note_type,
            "title": title,
            "created_at": _iso(moment),
        }
        if status and status != "stable":
            frontmatter["status"] = status
        if fields:
            frontmatter.update(fields)
        path = self.vault / relative
        write_document(
            path,
            OkfDocument(frontmatter=frontmatter, body=body),
            create_only=True,
        )
        return path

    def create_capture(
        self,
        title: str,
        content: str,
        *,
        course: str | None = None,
        project: str | None = None,
    ) -> Path:
        moment = self.clock()
        filename = f"{moment:%Y-%m-%d-%H%M%S}-{slugify(title)}.md"
        relative = Path("inbox") / "captures" / f"{moment:%Y}" / f"{moment:%m}" / filename
        fields: dict[str, Any] = {
            "ingested_via": DIRECT_ENTRY,
            **explicit_context_fields(self.vault, course=course, project=project),
        }
        body_content = _without_repeated_title(title, content)
        return self._create(
            relative,
            note_type="Capture",
            title=title,
            body=render_artifact_body(
                self.vault,
                "capture",
                title=title,
                content=body_content,
            ),
            fields=fields,
        )

    def create_daily(self, target_date: date | None = None, *, content: str = "") -> Path:
        value = target_date or self.clock().date()
        relative = Path("life") / "daily" / f"{value:%Y}" / f"{value:%m}" / f"{value}.md"
        path = self.vault / relative
        if path.exists():
            return path
        user_content = content.strip()
        body = render_artifact_body(self.vault, "daily", date=str(value), content=user_content)
        return self._create(
            relative,
            note_type="Daily",
            title=str(value),
            body=body,
            fields={"date": str(value)},
        )

    def append_daily_capture(
        self,
        content: str,
        target_date: date | None = None,
    ) -> Path:
        """Append a timestamped thought to the human-owned daily scratch section."""

        entry = content.strip()
        if not entry:
            raise ValueError("daily capture cannot be empty")
        path = self.create_daily(target_date)
        document = read_document(path)
        heading = "## 随手记录"
        position = document.body.find(heading)
        if position < 0:
            raise ValueError(f"Daily is missing the scratch section: {path}")
        content_start = position + len(heading)
        next_heading = document.body.find("\n## ", content_start)
        insertion = next_heading if next_heading >= 0 else len(document.body)
        stamp = self.clock().strftime("%H:%M")
        prefix = document.body[:insertion].rstrip()
        suffix = document.body[insertion:].lstrip("\n")
        document.body = f"{prefix}\n\n- **{stamp}** {entry}\n\n{suffix}"
        write_document(path, document)
        return path

    def create_reflection(self, title: str, content: str) -> Path:
        slug = slugify(title)
        body = render_artifact_body(
            self.vault,
            "reflection",
            title=title,
            content=_without_repeated_title(title, content),
        )
        suffix = 1
        while True:
            filename = f"{slug}.md" if suffix == 1 else f"{slug}-{suffix}.md"
            relative = Path("life") / "reflections" / filename
            try:
                return self._create(
                    relative,
                    note_type="Reflection",
                    title=title,
                    body=body,
                )
            except FileExistsError:
                suffix += 1

    def create_review(
        self,
        period: ReviewPeriod,
        target_date: date | None = None,
    ) -> Path:
        """Create or reopen the current human-authored periodic Review."""

        value = target_date or self.clock().date()
        if period == "weekly":
            iso = value.isocalendar()
            key = f"{iso.year}-W{iso.week:02d}"
            title = f"{key} 每周复盘"
            start = value - timedelta(days=value.weekday())
            end = start + timedelta(days=6)
        elif period == "monthly":
            key = f"{value:%Y-%m}"
            title = f"{key} 每月复盘"
            start = value.replace(day=1)
            end = value.replace(day=calendar.monthrange(value.year, value.month)[1])
        elif period == "yearly":
            key = f"{value:%Y}"
            title = f"{key} 每年复盘"
            start = value.replace(month=1, day=1)
            end = value.replace(month=12, day=31)
        else:
            raise ValueError(f"unsupported review period: {period}")

        relative = Path("life") / "reviews" / period / f"{key}.md"
        path = self.vault / relative
        if path.is_file():
            return path
        return self._create(
            relative,
            note_type="Review",
            title=title,
            body=render_artifact_body(
                self.vault,
                "review",
                title=title,
                period_range=f"{start} — {end}",
            ),
        )

    def create_course(self, slug: str, title: str) -> Path:
        course_slug = slugify(slug)
        root = self.vault / "learning" / "courses" / course_slug
        if root.exists():
            raise FileExistsError(root)
        return self._create(
            Path("learning") / "courses" / course_slug / "course.md",
            note_type="Course",
            title=title,
            body=render_artifact_body(self.vault, "course", title=title),
            fields={"course_status": "active"},
        )

    def create_lesson(
        self,
        course_slug: str,
        title: str,
        *,
        lesson_date: date | None = None,
        human_notes: str = "",
        ai_notes: str = "",
    ) -> Path:
        course = slugify(course_slug)
        course_home = self.vault / "learning" / "courses" / course / "course.md"
        if not course_home.is_file():
            raise FileNotFoundError(course_home)
        value = lesson_date or self.clock().date()
        relative = (
            Path("learning") / "courses" / course / "lessons" / f"{value}-{slugify(title)}.md"
        )
        body = render_artifact_body(
            self.vault,
            "lesson",
            title=title,
            human_notes=human_notes.strip(),
            ai_notes=ai_notes.strip(),
        )
        return self._create(
            relative,
            note_type="Lesson",
            title=title,
            body=body,
            fields={
                "course": f"/learning/courses/{course}/course.md",
                "lesson_at": str(value),
            },
        )

    def create_project(self, slug: str, title: str, *, category: str | None = None) -> Path:
        category = normalize_project_category(category)
        project_slug = slugify(slug)
        root = self.vault / "projects" / project_slug
        if root.exists():
            raise FileExistsError(root)
        root.mkdir(parents=True)
        (root / "log.md").write_text(
            render_artifact_body(self.vault, "project-log", title=title),
            encoding="utf-8",
            newline="\n",
        )
        return self._create(
            Path("projects") / project_slug / "project.md",
            note_type="Project",
            title=title,
            body=render_artifact_body(self.vault, "project", title=title),
            fields={
                "project_status": "active",
                **({"project_category": category} if category else {}),
            },
        )

    def set_project_category(
        self, slug: str, category: str | None, *, expected: str | None = None,
        check_expected: bool = False,
    ) -> Path:
        category = normalize_project_category(category)
        if not slug or slug in {".", ".."} or any(char in slug for char in "/\\:"):
            raise ValueError("项目目录名必须是单个 Vault 目录名称")
        path = resolve_bundle_path(self.vault, f"projects/{slug}/project.md")
        with document_lock(path):
            before = path.read_bytes()
            document = read_document(path)
            if document.type != "Project":
                raise ValueError("目标笔记不是 Project")
            current = normalize_project_category(document.frontmatter.get("project_category"))
            if document.frontmatter.get("project_category") == category and (
                category is not None or "project_category" not in document.frontmatter
            ):
                return path
            if check_expected and current != normalize_project_category(expected):
                raise ValueError("项目类别已经变化，请重新读取后操作")
            if category is None:
                document.frontmatter.pop("project_category", None)
            else:
                document.frontmatter["project_category"] = category
            write_document(path, document, expected_sha256=hashlib.sha256(before).hexdigest())
        return path

    def append_project_log(self, project_slug: str, content: str) -> Path:
        slug = slugify(project_slug)
        log = self.vault / "projects" / slug / "log.md"
        if not log.is_file():
            raise FileNotFoundError(log)
        heading = f"## {self.clock().date()}"
        with document_lock(log):
            before = log.read_bytes()
            text = render_project_log_append(before.decode("utf-8"), heading, content)
            atomic_write_bytes(
                log, text.encode("utf-8"), expected_sha256=hashlib.sha256(before).hexdigest()
            )
        return log

    def create_decision(
        self,
        project_slug: str,
        title: str,
        *,
        context: str,
        decision: str,
    ) -> Path:
        slug = slugify(project_slug)
        project_home = self.vault / "projects" / slug / "project.md"
        if not project_home.is_file():
            raise FileNotFoundError(project_home)
        value = self.clock().date()
        return self._create(
            Path("projects") / slug / "decisions" / f"{value}-{slugify(title)}.md",
            note_type="Decision",
            title=title,
            body=render_artifact_body(
                self.vault,
                "decision",
                title=title,
                context=context.strip(),
                decision=decision.strip(),
            ),
            fields={
                "project": f"/projects/{slug}/project.md",
                "decided_at": str(value),
            },
        )

    def create_wiki(
        self,
        title: str,
        content: str,
        *,
        sources: Sequence[str] = (),
        studied_at: datetime | None = None,
        aliases: Sequence[str] = (),
        tags: Sequence[str] = (),
        description: str | None = None,
        stale_after: date | None = None,
        status: str | None = None,
        course: str | None = None,
        project: str | None = None,
    ) -> Path:
        fields: dict[str, Any] = {
            "description": (description or _description(content, title)).strip()
        }
        normalized_aliases = list(
            dict.fromkeys(value.strip() for value in aliases if value.strip())
        )
        normalized_tags = list(dict.fromkeys(value.strip() for value in tags if value.strip()))
        if normalized_aliases:
            fields["aliases"] = normalized_aliases
        if normalized_tags:
            fields["tags"] = normalized_tags
        if sources:
            fields["sources"] = _source_entries(sources)
        explicit_context = explicit_context_fields(
            self.vault,
            course=course,
            project=project,
        )
        fields.update(
            inherited_context_fields(
                self.vault,
                sources,
                current=explicit_context,
            )
        )
        if studied_at:
            fields["studied_at"] = _iso(studied_at)
        if stale_after:
            fields["stale_after"] = str(stale_after)
        return self._create(
            Path("knowledge") / "wiki" / f"{slugify(title)}.md",
            note_type="Wiki",
            title=title,
            body=render_artifact_body(
                self.vault,
                "wiki",
                title=title,
                content=content.strip(),
            ),
            status=status,
            fields=fields,
        )

    def create_study_guide(
        self,
        title: str,
        content: str,
        *,
        sources: Sequence[str] = (),
        course: str | None = None,
        project: str | None = None,
        ai_material: str = "",
    ) -> Path:
        fields: dict[str, Any] = {}
        if sources:
            fields["sources"] = _source_entries(sources)
        explicit_context = explicit_context_fields(
            self.vault,
            course=course,
            project=project,
        )
        context = inherited_context_fields(
            self.vault,
            sources,
            current=explicit_context,
        )
        fields.update(context)
        relative = Path("learning") / "guides" / f"{slugify(title)}.md"
        course_reference = context.get("course")
        if course_reference is not None:
            course_home = Path(course_reference.removeprefix("/"))
            relative = course_home.parent / "guides" / f"{slugify(title)}.md"
        body = render_artifact_body(
            self.vault, "study-guide", title=title, content=content.strip()
        )
        if ai_material:
            body = replace_managed_region(body, "study-material", ai_material)
        return self._create(
            relative,
            note_type="Study Guide",
            title=title,
            body=body,
            fields=fields,
        )

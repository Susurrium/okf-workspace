"""Create canonical OKF concepts at their authoritative paths."""

from __future__ import annotations

from collections.abc import Callable, Sequence
from datetime import date, datetime
from pathlib import Path
from typing import Any

from okf_workspace.ingestion import DIRECT_ENTRY
from okf_workspace.okf.artifacts import render_artifact_body
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document
from okf_workspace.okf.paths import slugify
from okf_workspace.okf.relations import explicit_context_fields, inherited_context_fields

Clock = Callable[[], datetime]


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
            "capture_status": "open",
            "ingested_via": DIRECT_ENTRY,
            **explicit_context_fields(self.vault, course=course, project=project),
        }
        return self._create(
            relative,
            note_type="Capture",
            title=title,
            body=render_artifact_body(self.vault, "capture", title=title, content=content.strip()),
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
        moment = self.clock()
        relative = Path("life") / "reflections" / f"{moment:%Y-%m-%d}-{slugify(title)}.md"
        return self._create(
            relative,
            note_type="Reflection",
            title=title,
            body=render_artifact_body(
                self.vault, "reflection", title=title, content=content.strip()
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
            Path("learning")
            / "courses"
            / course
            / "lessons"
            / f"{value}-{slugify(title)}.md"
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

    def create_project(self, slug: str, title: str) -> Path:
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
            fields={"project_status": "active"},
        )

    def append_project_log(self, project_slug: str, content: str) -> Path:
        slug = slugify(project_slug)
        log = self.vault / "projects" / slug / "log.md"
        if not log.is_file():
            raise FileNotFoundError(log)
        heading = f"## {self.clock().date()}"
        text = log.read_text(encoding="utf-8")
        entry = content.strip()
        if heading in text:
            text = text.replace(heading, f"{heading}\n\n- {entry}", 1)
        else:
            first_line, _, remainder = text.partition("\n")
            prefix = first_line if first_line.startswith("# ") else "# 项目日志"
            existing = remainder.lstrip() if first_line.startswith("# ") else text.lstrip()
            intro, separator, history = existing.partition("\n")
            if intro.startswith("该文件按时间记录"):
                tail = history.lstrip() if separator else ""
                text = f"{prefix}\n\n{intro}\n\n{heading}\n\n- {entry}"
                if tail:
                    text = f"{text}\n\n{tail}"
            else:
                text = f"{prefix}\n\n{heading}\n\n- {entry}"
                if existing:
                    text = f"{text}\n\n{existing}"
        log.write_text(text, encoding="utf-8", newline="\n")
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
        return self._create(
            relative,
            note_type="Study Guide",
            title=title,
            body=render_artifact_body(
                self.vault, "study-guide", title=title, content=content.strip()
            ),
            fields=fields,
        )

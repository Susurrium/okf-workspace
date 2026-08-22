"""Rebuildable note catalog sourced directly from real Markdown files."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime
from pathlib import Path
from typing import cast

from okf_workspace.okf.frontmatter import FrontmatterError, read_document
from okf_workspace.okf.relations import inherited_context_fields

_SKIP = {".agents", ".claudian", ".git", ".obsidian", ".trash"}
_SKIPPED_SYSTEM_SECTIONS = {"contracts", "reports", "templates", "views"}
_MARKDOWN = re.compile(r"[#>*_`\[\]()-]+")


@dataclass(frozen=True, slots=True)
class NoteSummary:
    path: str
    title: str
    note_type: str
    status: str
    studied_at: str | None
    material_ready: bool
    ai_unverified: bool
    project_status: str | None
    course_status: str | None
    capture_status: str | None
    purpose: str | None
    ingested_via: str | None
    resource: str | None
    kind: str | None
    course: str | None
    project: str | None
    created_at: str | None
    modified_at: str
    stale_after: str | None
    stale: bool
    topics: tuple[str, ...]
    source_paths: tuple[str, ...]
    excerpt: str


def _string(value: object) -> str | None:
    return value if isinstance(value, str) and value.strip() else None


def _strings(value: object) -> tuple[str, ...]:
    if isinstance(value, str):
        return tuple(item.strip() for item in value.split(",") if item.strip())
    if isinstance(value, list):
        return tuple(
            item.strip()
            for item in cast(list[object], value)
            if isinstance(item, str) and item.strip()
        )
    return ()


def _excerpt(body: str) -> str:
    visible = " ".join(
        line.strip()
        for line in body.splitlines()
        if line.strip() and not line.strip().startswith("<!--")
    )
    return _MARKDOWN.sub(" ", visible).strip()[:220]


def _source_paths(value: object) -> tuple[str, ...]:
    if not isinstance(value, list):
        return ()
    paths: list[str] = []
    for item in cast(list[object], value):
        if not isinstance(item, Mapping):
            continue
        source = cast(Mapping[object, object], item)
        resource = source.get("resource")
        if isinstance(resource, str) and resource.startswith("/"):
            paths.append(resource.lstrip("/"))
    return tuple(dict.fromkeys(paths))


def _material_ready(body: str) -> bool:
    match = re.search(
        r'<!-- ai:auto:start name="study-material" -->(.*?)'
        r'<!-- ai:auto:end name="study-material" -->',
        body,
        re.DOTALL,
    )
    if match is None:
        return False
    content = match.group(1).strip()
    return bool(content) and "等待 Codex" not in content and "等待生成" not in content


def _moment(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _ai_unverified(frontmatter: Mapping[str, object]) -> bool:
    generated = frontmatter.get("generated")
    if not isinstance(generated, Mapping):
        return False
    generated_event = cast(Mapping[object, object], generated)
    generated_at = _moment(generated_event.get("at"))
    verified = frontmatter.get("verified")
    events: list[object] = (
        cast(list[object], verified) if isinstance(verified, list) else [verified]
    )
    for event in events:
        if not isinstance(event, Mapping):
            continue
        verification = cast(Mapping[object, object], event)
        actor = verification.get("by")
        verified_at = _moment(verification.get("at"))
        if (
            isinstance(actor, str)
            and actor.startswith("human:")
            and (generated_at is None or verified_at is None or verified_at >= generated_at)
        ):
            return False
    return True


def scan_notes(
    vault: Path,
    *,
    include_self: bool = False,
    today: date | None = None,
) -> tuple[NoteSummary, ...]:
    root = vault.resolve()
    current = today or date.today()
    notes: list[NoteSummary] = []
    for path in sorted(root.rglob("*.md")):
        relative_path = path.relative_to(root)
        if path.name in {"index.md", "log.md"}:
            continue
        if any(part in _SKIP for part in relative_path.parts):
            continue
        if relative_path.parts and relative_path.parts[0] == "archive":
            continue
        if relative_path.as_posix() == "AGENTS.md":
            continue
        if (
            len(relative_path.parts) >= 2
            and relative_path.parts[0] == "system"
            and relative_path.parts[1] in _SKIPPED_SYSTEM_SECTIONS
        ):
            continue
        if not include_self and relative_path.parts and relative_path.parts[0] == "self":
            continue
        try:
            document = read_document(path)
        except (FrontmatterError, OSError):
            continue
        linked_sources = _source_paths(document.frontmatter.get("sources"))
        context: Mapping[str, object] = document.frontmatter
        if document.type == "Study Guide" and (
            not _string(document.frontmatter.get("course"))
            or not _string(document.frontmatter.get("project"))
        ):
            context = inherited_context_fields(
                root,
                linked_sources,
                current=document.frontmatter,
            )
        stale_after = _string(document.frontmatter.get("stale_after"))
        try:
            stale = stale_after is not None and date.fromisoformat(stale_after) <= current
        except ValueError:
            stale = True
        notes.append(
            NoteSummary(
                path=relative_path.as_posix(),
                title=_string(document.frontmatter.get("title")) or path.stem,
                note_type=document.type,
                status=_string(document.frontmatter.get("status")) or "stable",
                studied_at=_string(document.frontmatter.get("studied_at")),
                material_ready=_material_ready(document.body),
                ai_unverified=_ai_unverified(dict(document.frontmatter)),
                project_status=_string(document.frontmatter.get("project_status")),
                course_status=_string(document.frontmatter.get("course_status")),
                # Capture has no durable state machine. Its presence in Inbox means
                # pending; this projection keeps the legacy response shape for UI
                # clients while the Markdown omits capture_status.
                capture_status=(
                    _string(document.frontmatter.get("capture_status"))
                    or (
                        "open"
                        if document.type == "Capture"
                        and relative_path.parts[:2] == ("inbox", "captures")
                        else None
                    )
                ),
                purpose=_string(document.frontmatter.get("purpose")),
                ingested_via=_string(document.frontmatter.get("ingested_via")),
                resource=_string(document.frontmatter.get("resource")),
                kind=_string(document.frontmatter.get("kind")),
                course=_string(context.get("course")),
                project=_string(context.get("project")),
                created_at=_string(document.frontmatter.get("created_at")),
                modified_at=datetime.fromtimestamp(path.stat().st_mtime)
                .astimezone()
                .isoformat(timespec="seconds"),
                stale_after=stale_after,
                stale=stale,
                topics=_strings(
                    document.frontmatter.get("topics", document.frontmatter.get("tags"))
                ),
                source_paths=linked_sources,
                excerpt=_excerpt(document.body),
            )
        )
    return tuple(notes)

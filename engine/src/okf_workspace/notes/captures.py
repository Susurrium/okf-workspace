"""Explicitly process a Capture while preserving its original text."""

from __future__ import annotations

import os
from datetime import datetime
from pathlib import Path
from typing import Literal

from okf_workspace.git import create_checkpoint
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document
from okf_workspace.okf.paths import resolve_bundle_path

from .create import NoteService

CaptureDestination = Literal[
    "reflection",
    "wiki",
    "study-guide",
    "lesson",
    "project-log",
]


def _capture_archive_path(vault: Path, source: Path) -> Path:
    parts = source.relative_to(vault).parts
    year = parts[-3] if len(parts) >= 3 else f"{datetime.now():%Y}"
    month = parts[-2] if len(parts) >= 2 else f"{datetime.now():%m}"
    return vault / "archive" / "captures" / year / month / source.name


def recommend_capture_destination(vault: Path, relative: str) -> dict[str, str]:
    source = resolve_bundle_path(vault.resolve(), relative)
    document = read_document(source)
    if document.type != "Capture":
        raise ValueError(f"not a Capture: {relative}")
    if document.frontmatter.get("ingested_via") == "web-clip":
        raise ValueError("Web Capture must be published as Source + Source Text")
    text = f"{document.frontmatter.get('title', '')}\n{document.body}"
    rules: tuple[tuple[tuple[str, ...], CaptureDestination, str], ...] = (
        (("课堂", "老师", "课程"), "lesson", "内容像课堂原始记录"),
        (("项目", "进度", "下一步"), "project-log", "内容与项目进展或行动有关"),
        (("感受", "反思", "心情", "意识到"), "reflection", "内容以个人感受和反思为主"),
        (("学习", "理解", "概念"), "study-guide", "内容适合进入学习流程"),
        (("配置", "清单", "地址", "步骤", "指南"), "wiki", "内容适合作为以后查用的 Wiki"),
    )
    for markers, destination, reason in rules:
        if any(marker in text for marker in markers):
            return {"destination": destination, "reason": reason}
    return {
        "destination": "wiki",
        "reason": "内容包含可继续提炼的想法，默认创建 Wiki 草稿",
    }


def _content(document_body: str) -> str:
    lines = document_body.strip().splitlines()
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
    return "\n".join(lines).strip()


def process_capture(
    vault: Path,
    relative: str,
    *,
    destination: CaptureDestination,
    title: str | None = None,
    project: str | None = None,
    course: str | None = None,
) -> tuple[Path, Path]:
    vault = vault.resolve()
    source = resolve_bundle_path(vault, relative)
    document = read_document(source)
    if document.type != "Capture":
        raise ValueError(f"not a Capture: {relative}")
    if document.frontmatter.get("capture_status") != "open":
        raise ValueError(f"Capture is already processed: {relative}")
    if document.frontmatter.get("ingested_via") == "web-clip":
        raise ValueError("Web Capture must be published as Source + Source Text")
    original_title = document.frontmatter.get("title")
    resolved_title = title or (original_title if isinstance(original_title, str) else source.stem)
    body = _content(document.body)
    archived = _capture_archive_path(vault, source)
    archived_relative = archived.relative_to(vault).as_posix()
    captured_course = document.frontmatter.get("course")
    captured_project = document.frontmatter.get("project")
    context_course = course or (
        captured_course if isinstance(captured_course, str) else None
    )
    context_project = project or (
        captured_project if isinstance(captured_project, str) else None
    )
    if destination == "project-log" and not project:
        raise ValueError("--project is required for project-log")
    if destination == "lesson" and not course:
        raise ValueError("--course is required for lesson")
    service = NoteService(vault)
    create_checkpoint(vault, "checkpoint before organizing Capture")

    if destination == "reflection":
        target = service.create_reflection(resolved_title, body)
        target_document = read_document(target)
        target_document.frontmatter["sources"] = [
            {"id": "capture", "resource": f"/{archived_relative}"}
        ]
        write_document(target, target_document)
    elif destination == "wiki":
        target = service.create_wiki(
            resolved_title,
            body,
            sources=[archived_relative],
            course=context_course,
            project=context_project,
        )
    elif destination == "study-guide":
        target = service.create_study_guide(
            resolved_title,
            body,
            sources=[archived_relative],
            course=context_course,
            project=context_project,
        )
    elif destination == "lesson":
        assert course is not None
        target = service.create_lesson(
            course,
            resolved_title,
            human_notes=body,
        )
    else:
        assert project is not None
        target = service.append_project_log(
            project,
            f"{resolved_title}\n\n{body}\n\n来源：[Capture](/{archived_relative})",
        )

    target_relative = target.relative_to(vault).as_posix()
    document.frontmatter["capture_status"] = "processed"
    document.frontmatter["processed_into"] = [f"/{target_relative}"]
    write_document(source, document)

    archived.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, archived)
    create_checkpoint(vault, f"organize: Capture to {destination}")
    return target, archived


def discard_capture(vault: Path, relative: str) -> Path:
    """Archive an explicitly discarded Capture without deleting its original text."""
    vault = vault.resolve()
    source = resolve_bundle_path(vault, relative)
    document = read_document(source)
    if document.type != "Capture" or document.frontmatter.get("capture_status") != "open":
        raise ValueError(f"not an open Capture: {relative}")
    archived = _capture_archive_path(vault, source)
    create_checkpoint(vault, "checkpoint before discarding Capture")
    document.frontmatter["capture_status"] = "discarded"
    write_document(source, document)
    archived.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, archived)
    create_checkpoint(vault, "capture: archive discarded note")
    return archived


def batch_discard_captures(vault: Path, relatives: list[str]) -> tuple[Path, ...]:
    """Mark selected open Captures discarded and archive them as one recoverable operation."""
    vault = vault.resolve()
    sources: list[tuple[Path, OkfDocument]] = []
    for relative in dict.fromkeys(relatives):
        source = resolve_bundle_path(vault, relative)
        document = read_document(source)
        if document.type != "Capture" or document.frontmatter.get("capture_status") != "open":
            raise ValueError(f"not an open Capture: {relative}")
        sources.append((source, document))
    if not sources:
        return ()
    create_checkpoint(vault, "checkpoint before batch discarding Captures")
    archived_paths: list[Path] = []
    for source, loaded in sources:
        document = loaded
        document.frontmatter["capture_status"] = "discarded"
        write_document(source, document)
        archived = _capture_archive_path(vault, source)
        archived.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, archived)
        archived_paths.append(archived)
    create_checkpoint(vault, "capture: batch archive discarded notes")
    return tuple(archived_paths)


def archive_processed_captures(vault: Path, relatives: list[str]) -> tuple[Path, ...]:
    """Archive processed Captures that still remain in Inbox after manual edits or imports."""
    vault = vault.resolve()
    sources: list[Path] = []
    for relative in dict.fromkeys(relatives):
        source = resolve_bundle_path(vault, relative)
        document = read_document(source)
        if document.type != "Capture" or document.frontmatter.get("capture_status") != "processed":
            raise ValueError(f"not a processed Capture: {relative}")
        sources.append(source)
    if not sources:
        return ()
    create_checkpoint(vault, "checkpoint before archiving processed Captures")
    archived_paths: list[Path] = []
    for source in sources:
        archived = _capture_archive_path(vault, source)
        archived.parent.mkdir(parents=True, exist_ok=True)
        os.replace(source, archived)
        archived_paths.append(archived)
    create_checkpoint(vault, "capture: archive processed notes")
    return tuple(archived_paths)

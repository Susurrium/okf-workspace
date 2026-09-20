"""Route short-lived Inbox Captures into one durable destination."""

from __future__ import annotations

import hashlib
import logging
import os
import threading
import time
import uuid
from collections.abc import Generator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Literal

from okf_workspace.git import GitCheckpointError, create_checkpoint
from okf_workspace.okf.file_io import atomic_write_bytes, document_lock
from okf_workspace.okf.frontmatter import OkfDocument, read_document
from okf_workspace.okf.paths import resolve_bundle_path
from okf_workspace.okf.relations import normalize_context_reference
from okf_workspace.sources import restore_file_bytes

from .create import NoteService
from .project_logs import render_project_log_append

CaptureDestination = Literal[
    "reflection",
    "wiki",
    "study-guide",
    "lesson",
    "project-log",
]

LOGGER = logging.getLogger(__name__)
_CAPTURE_WRITE_LOCK = threading.RLock()
_CAPTURE_LOCK = Path(".trash") / ".okf-capture-transaction.lock"
_CAPTURE_LOCK_TIMEOUT_SECONDS = 30.0


@dataclass(frozen=True, slots=True)
class _ProjectLogMutation:
    target: Path
    before: bytes
    after: bytes
    marker_id: str


@contextmanager
def _vault_capture_transaction_lock(vault: Path) -> Generator[None]:
    """Serialize a complete Capture transaction across local API/CLI processes."""

    lock_path = vault.resolve() / _CAPTURE_LOCK
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + _CAPTURE_LOCK_TIMEOUT_SECONDS
    with lock_path.open("a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise TimeoutError(
                        "another Capture transaction is still running after 30s"
                    ) from exc
                time.sleep(0.1)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _capture_source_path(vault: Path, relative: str) -> Path:
    source = resolve_bundle_path(vault.resolve(), relative)
    inbox = (vault.resolve() / "inbox" / "captures").resolve()
    if not source.is_relative_to(inbox):
        raise ValueError("only an Inbox Capture can use the Capture workflow")
    return source


def _post_checkpoint(vault: Path, message: str) -> None:
    try:
        create_checkpoint(vault, message)
    except GitCheckpointError as exc:
        # The Markdown mutation is already durable. A best-effort recovery
        # checkpoint must never turn that successful action into a retryable 500.
        LOGGER.warning("Capture action completed but Git checkpoint failed: %s", exc)


def _pending_capture(vault: Path, relative: str) -> tuple[Path, OkfDocument]:
    source = _capture_source_path(vault, relative)
    document = read_document(source)
    legacy_status = document.frontmatter.get("capture_status")
    if document.type != "Capture" or legacy_status not in {None, "open"}:
        raise ValueError(f"not a pending Capture: {relative}")
    return source, document


def _context_slug(vault: Path, field: Literal["course", "project"], value: str) -> str:
    reference = normalize_context_reference(vault, field, value)
    parts = Path(reference.removeprefix("/")).parts
    return parts[2] if field == "course" else parts[1]


def recommend_capture_destination(vault: Path, relative: str) -> dict[str, str]:
    _, document = _pending_capture(vault, relative)
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


def _content(document_body: str, title: str) -> str:
    lines = document_body.strip().splitlines()
    if lines and lines[0].startswith("# "):
        lines = lines[1:]
    while lines and not lines[0].strip():
        lines = lines[1:]
    if lines and lines[0].strip() == title.strip():
        lines = lines[1:]
    return "\n".join(lines).strip()


def _delete_capture(source: Path) -> None:
    source.unlink()


def _trash_target(vault: Path, source: Path) -> Path:
    relative = source.relative_to(vault)
    target = vault / ".trash" / relative
    suffix = 1
    while target.exists():
        suffix += 1
        target = target.with_stem(f"{source.stem}-{suffix}")
    return target


def _move_to_trash(vault: Path, source: Path) -> Path:
    target = _trash_target(vault, source)
    target.parent.mkdir(parents=True, exist_ok=True)
    os.replace(source, target)
    return target


def _project_log_markers(identity: str) -> tuple[str, str]:
    return (
        f'<!-- okf:capture-transaction:start id="{identity}" -->',
        f'<!-- okf:capture-transaction:end id="{identity}" -->',
    )


def _render_project_log_append(text: str, heading: str, entry: str) -> str:
    return render_project_log_append(text, heading, entry)


def _append_marked_project_log(
    target: Path,
    entry: str,
) -> _ProjectLogMutation:
    marker_id = uuid.uuid4().hex
    start, end = _project_log_markers(marker_id)
    heading = f"## {datetime.now().astimezone().date()}"
    marked_entry = f"{start}{entry.strip()}{end}"
    with document_lock(target):
        before = target.read_bytes()
        after = _render_project_log_append(before.decode("utf-8"), heading, marked_entry).encode(
            "utf-8"
        )
        atomic_write_bytes(target, after, expected_sha256=hashlib.sha256(before).hexdigest())
    return _ProjectLogMutation(target, before, after, marker_id)


def _remove_marked_project_entry(text: str, marker_id: str) -> str:
    start, end = _project_log_markers(marker_id)
    start_at = text.find(start)
    end_at = text.find(end, start_at + len(start)) if start_at >= 0 else -1
    if start_at < 0 or end_at < 0:
        return text
    line_start = text.rfind("\n", 0, start_at) + 1
    prefix = text[line_start:start_at]
    if prefix.strip() == "-":
        start_at = line_start
    end_at += len(end)
    if text[end_at : end_at + 2] == "\r\n":
        end_at += 2
    elif text[end_at : end_at + 1] == "\n":
        end_at += 1
    return text[:start_at] + text[end_at:]


def _rollback_project_log_mutation(mutation: _ProjectLogMutation) -> None:
    """Undo only this append while preserving unrelated edits made meanwhile."""

    with document_lock(mutation.target):
        _rollback_project_log_mutation_locked(mutation)


def _rollback_project_log_mutation_locked(mutation: _ProjectLogMutation) -> None:

    current = mutation.target.read_bytes()
    if current == mutation.after:
        atomic_write_bytes(
            mutation.target, mutation.before, expected_sha256=hashlib.sha256(current).hexdigest()
        )
        return
    rendered = current.decode("utf-8")
    updated = _remove_marked_project_entry(rendered, mutation.marker_id)
    if updated == rendered:
        raise RuntimeError("cannot safely locate this Capture's Project Log entry")
    atomic_write_bytes(
        mutation.target,
        updated.encode("utf-8"),
        expected_sha256=hashlib.sha256(current).hexdigest(),
    )


def _finalize_project_log_mutation(mutation: _ProjectLogMutation) -> None:
    """Remove transaction markers after the Capture has been consumed."""

    with document_lock(mutation.target):
        _finalize_project_log_mutation_locked(mutation)


def _finalize_project_log_mutation_locked(mutation: _ProjectLogMutation) -> None:

    before = mutation.target.read_bytes()
    current = before.decode("utf-8")
    start, end = _project_log_markers(mutation.marker_id)
    has_start = start in current
    has_end = end in current
    if not has_start and not has_end:
        return
    if has_start != has_end:
        raise RuntimeError("incomplete Capture transaction marker in Project Log")
    updated = current.replace(start, "", 1).replace(end, "", 1)
    atomic_write_bytes(
        mutation.target, updated.encode("utf-8"), expected_sha256=hashlib.sha256(before).hexdigest()
    )


def process_capture(
    vault: Path,
    relative: str,
    *,
    destination: CaptureDestination,
    title: str | None = None,
    project: str | None = None,
    course: str | None = None,
) -> Path:
    """Publish and consume one Capture as a serialized Vault transaction."""

    vault = vault.resolve()
    with _CAPTURE_WRITE_LOCK, _vault_capture_transaction_lock(vault):
        return _process_capture_locked(
            vault,
            relative,
            destination=destination,
            title=title,
            project=project,
            course=course,
        )


def _process_capture_locked(
    vault: Path,
    relative: str,
    *,
    destination: CaptureDestination,
    title: str | None = None,
    project: str | None = None,
    course: str | None = None,
) -> Path:
    """Create one durable target, then remove the successfully consumed Capture.

    The Capture remains untouched whenever target creation fails. If deleting the
    Capture itself fails, the target write is rolled back so the Inbox never shows a
    misleading duplicate.
    """

    vault = vault.resolve()
    source, document = _pending_capture(vault, relative)
    if document.frontmatter.get("ingested_via") == "web-clip":
        raise ValueError("Web Capture must be published as Source + Source Text")

    original_title = document.frontmatter.get("title")
    resolved_title = title or (
        original_title
        if isinstance(original_title, str) and original_title.strip()
        else source.stem
    )
    body = _content(document.body, resolved_title)
    captured_course = document.frontmatter.get("course")
    captured_project = document.frontmatter.get("project")
    context_course = course or (captured_course if isinstance(captured_course, str) else None)
    context_project = project or (captured_project if isinstance(captured_project, str) else None)
    if destination == "project-log" and context_project is None:
        raise ValueError("--project is required for project-log")
    if destination == "lesson" and context_course is None:
        raise ValueError("--course is required for lesson")

    service = NoteService(vault)
    create_checkpoint(vault, "checkpoint before organizing Capture")
    previous_target: bytes | None = None
    project_log_mutation: _ProjectLogMutation | None = None

    if destination == "reflection":
        target = service.create_reflection(resolved_title, body)
    elif destination == "wiki":
        target = service.create_wiki(
            resolved_title,
            body,
            course=context_course,
            project=context_project,
        )
    elif destination == "study-guide":
        target = service.create_study_guide(
            resolved_title,
            body,
            course=context_course,
            project=context_project,
        )
    elif destination == "lesson":
        assert context_course is not None
        target = service.create_lesson(
            _context_slug(vault, "course", context_course),
            resolved_title,
            human_notes=body,
        )
    else:
        assert context_project is not None
        project_slug = _context_slug(vault, "project", context_project)
        target = vault / "projects" / project_slug / "log.md"
        entry = resolved_title if not body else f"{resolved_title}\n\n{body}"
        project_log_mutation = _append_marked_project_log(target, entry)

    try:
        _delete_capture(source)
    except Exception:
        try:
            if project_log_mutation is not None:
                _rollback_project_log_mutation(project_log_mutation)
            else:
                restore_file_bytes(target, previous_target)
        except Exception as recovery_error:
            raise RuntimeError("Capture target rollback failed") from recovery_error
        raise
    if project_log_mutation is not None:
        try:
            _finalize_project_log_mutation(project_log_mutation)
        except Exception as exc:
            LOGGER.warning(
                "Capture was committed but Project Log marker cleanup failed: %s",
                exc,
            )
    _post_checkpoint(vault, f"organize: Capture to {destination}")
    return target


def discard_capture(vault: Path, relative: str) -> Path:
    """Remove a pending Capture from Inbox via Obsidian's local trash."""

    vault = vault.resolve()
    with _CAPTURE_WRITE_LOCK, _vault_capture_transaction_lock(vault):
        return _discard_capture_locked(vault, relative)


def _discard_capture_locked(vault: Path, relative: str) -> Path:
    vault = vault.resolve()
    source, _ = _pending_capture(vault, relative)
    create_checkpoint(vault, "checkpoint before discarding Capture")
    _move_to_trash(vault, source)
    _post_checkpoint(vault, "capture: discard note")
    return source


def batch_discard_captures(vault: Path, relatives: list[str]) -> tuple[Path, ...]:
    """Delete selected pending Captures as one validated operation."""

    vault = vault.resolve()
    with _CAPTURE_WRITE_LOCK, _vault_capture_transaction_lock(vault):
        return _batch_discard_captures_locked(vault, relatives)


def _batch_discard_captures_locked(vault: Path, relatives: list[str]) -> tuple[Path, ...]:
    vault = vault.resolve()
    sources = [_pending_capture(vault, relative)[0] for relative in dict.fromkeys(relatives)]
    if not sources:
        return ()
    create_checkpoint(vault, "checkpoint before batch discarding Captures")
    moved: list[tuple[Path, Path]] = []
    try:
        for source in sources:
            moved.append((source, _move_to_trash(vault, source)))
    except Exception:
        for source, trashed in reversed(moved):
            source.parent.mkdir(parents=True, exist_ok=True)
            os.replace(trashed, source)
        raise
    _post_checkpoint(vault, "capture: batch discard notes")
    return tuple(sources)

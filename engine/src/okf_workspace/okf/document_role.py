"""Identify Dashboard-owned Markdown independently of filenames and plugin state."""

from __future__ import annotations

from enum import Enum
from pathlib import Path, PurePosixPath

from .frontmatter import FrontmatterError, OkfDocument, parse_document


class DocumentRole(Enum):
    ARTIFACT = "artifact"
    WORKBENCH = "workbench"
    CONFLICT = "conflict"
    INVALID_WORKBENCH = "invalid-workbench"


def is_workbench_backup(relative: str) -> bool:
    return PurePosixPath(relative).parts[:1] == (".dashboard-backup",)


def document_role(document: OkfDocument) -> DocumentRole:
    fields = document.frontmatter
    marker = fields.get("dashboard")
    if marker is True:
        artifact_type = fields.get("type")
        if (
            artifact_type is not None
            and artifact_type != ""
            and (not isinstance(artifact_type, str) or artifact_type.strip())
        ):
            return DocumentRole.CONFLICT
        return DocumentRole.WORKBENCH
    if "dashboard" in fields and not isinstance(marker, bool):
        return DocumentRole.INVALID_WORKBENCH
    return DocumentRole.ARTIFACT


def workbench_issue(document: OkfDocument) -> tuple[str, str] | None:
    role = document_role(document)
    if role is DocumentRole.CONFLICT:
        return "document-role-conflict", "dashboard: true cannot also declare an Artifact type"
    if role is DocumentRole.INVALID_WORKBENCH:
        return "workbench-marker", "dashboard must be a YAML boolean, not a string or number"
    if role is DocumentRole.WORKBENCH and "workbench_schema" in document.frontmatter:
        schema = document.frontmatter["workbench_schema"]
        if not isinstance(schema, int) or isinstance(schema, bool) or schema < 1:
            return "workbench-schema", "workbench_schema must be a positive integer when present"
    return None


def protects_workbench_file(path: Path, vault: Path) -> bool:
    """Protect boards, conflicting identities and unreadable YAML from Artifact migrations.

    Plain Markdown without frontmatter remains available for ordinary link rewrites.
    This is a mutation policy, not an instruction to exclude live board tasks or backups.
    """
    if is_workbench_backup(path.relative_to(vault).as_posix()):
        return True
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return True
    try:
        document = parse_document(text, source=str(path))
    except FrontmatterError:
        return bool(text.splitlines() and text.splitlines()[0].strip() == "---")
    return document_role(document) is not DocumentRole.ARTIFACT

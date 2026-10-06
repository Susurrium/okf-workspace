"""Discover authoritative Markdown files without consulting runtime state."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path

from okf_workspace.okf.document_role import DocumentRole, document_role, is_workbench_backup
from okf_workspace.okf.frontmatter import FrontmatterError, parse_document

SKIPPED_DIRECTORIES = {".agents", ".claudian", ".git", ".obsidian", ".trash"}


def iter_markdown(vault: Path) -> Iterator[Path]:
    root = vault.resolve()
    for path in sorted(root.rglob("*.md")):
        if is_retrievable_markdown(path, root):
            yield path


def is_retrievable_markdown(path: Path, vault: Path) -> bool:
    relative = path.resolve().relative_to(vault.resolve())
    if relative.parts[:2] in {("inbox", "uploads"), ("sources", "originals")}:
        return False
    if any(part in SKIPPED_DIRECTORIES for part in relative.parts):
        return False
    if relative.parts and relative.parts[0] == "archive":
        return False
    if relative.as_posix() == "AGENTS.md" or is_workbench_backup(relative.as_posix()):
        return False
    if (
        len(relative.parts) >= 2
        and relative.parts[0] == "system"
        and relative.parts[1] in {"contracts", "reports", "templates", "views", "imports"}
    ):
        return False
    if path.name == "index.md" or not path.is_file():
        return False
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError):
        return False
    try:
        document = parse_document(text, source=str(path))
    except FrontmatterError:
        # Ordinary plain Markdown is readable; malformed YAML cannot establish
        # a safe document role and is diagnosed by validation instead.
        lines = text.splitlines()
        return not lines or lines[0].strip() != "---"
    return document_role(document) is DocumentRole.ARTIFACT


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

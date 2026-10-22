"""Discover authoritative Markdown files without consulting runtime state."""

from __future__ import annotations

import hashlib
import os
from collections.abc import Iterator
from pathlib import Path

from okf_workspace.okf.document_role import DocumentRole, document_role, is_workbench_backup
from okf_workspace.okf.frontmatter import FrontmatterError, parse_document

SKIPPED_DIRECTORIES = {".agents", ".claudian", ".git", ".obsidian", ".trash"}


def is_candidate_path(relative: Path) -> bool:
    if relative.parts[:2] in {("inbox", "uploads"), ("sources", "originals")}:
        return False
    if any(part in SKIPPED_DIRECTORIES for part in relative.parts):
        return False
    if relative.parts and relative.parts[0] == "archive":
        return False
    if relative.as_posix() == "AGENTS.md" or is_workbench_backup(relative.as_posix()):
        return False
    if relative.parts[:2] in {
        ("system", section) for section in ("contracts", "reports", "templates", "views", "imports")
    }:
        return False
    return relative.name != "index.md"


def iter_markdown_candidates(vault: Path) -> Iterator[Path]:
    for _relative, path in iter_candidate_entries(vault):
        yield path


def iter_candidate_entries(vault: Path) -> Iterator[tuple[str, Path]]:
    root = vault.resolve()

    def fail(error: OSError) -> None:
        raise error

    for directory, folders, filenames in os.walk(root, onerror=fail, followlinks=False):
        base = Path(directory)
        relative_directory = Path(os.path.relpath(directory, root))
        folders[:] = [
            name
            for name in folders
            if is_candidate_path(relative_directory / name)
            and not (base / name).is_symlink()
            and not (base / name).is_junction()
        ]
        for name in sorted(filenames):
            path = base / name
            relative = relative_directory / name
            if (
                path.suffix.casefold() == ".md"
                and is_candidate_path(relative)
                and not path.is_symlink()
            ):
                yield relative.as_posix(), path


def iter_markdown(vault: Path) -> Iterator[Path]:
    root = vault.resolve()
    for path in sorted(iter_markdown_candidates(root)):
        if is_retrievable_markdown(path, root):
            yield path


def is_retrievable_markdown(path: Path, vault: Path) -> bool:
    relative = path.resolve().relative_to(vault.resolve())
    if not is_candidate_path(relative) or not path.is_file():
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

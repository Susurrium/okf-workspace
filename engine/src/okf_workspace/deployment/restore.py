"""Verify a restored Vault and content-addressed Original Store."""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from okf_workspace.okf.frontmatter import FrontmatterError, read_document

_ORIGINAL_RESOURCE = re.compile(r"^okf-original://sha256/([0-9a-f]{64})/")


@dataclass(frozen=True, slots=True)
class RestoreVerification:
    valid: bool
    markdown_files: int
    readable_files: int
    original_references: int
    resolved_originals: int
    errors: tuple[str, ...]


def _original_exists(originals: Path, digest: str) -> bool:
    directory = originals / "sha256" / digest[:2] / digest
    return directory.is_dir() and any(
        path.name.startswith("original.") and path.is_file() for path in directory.iterdir()
    )


def verify_restored_data(vault: Path, originals: Path) -> RestoreVerification:
    root = vault.resolve()
    original_root = originals.resolve()
    errors: list[str] = []
    markdown = sorted(root.rglob("*.md")) if root.is_dir() else []
    if not markdown:
        errors.append("restored Vault contains no Markdown files")
    readable = 0
    references = 0
    resolved = 0
    for path in markdown:
        try:
            path.read_text(encoding="utf-8")
            readable += 1
        except (OSError, UnicodeError) as exc:
            errors.append(f"unreadable Markdown: {path.relative_to(root).as_posix()}: {exc}")
            continue
        try:
            document = read_document(path)
        except FrontmatterError:
            continue
        resource = document.frontmatter.get("resource")
        if not isinstance(resource, str):
            continue
        match = _ORIGINAL_RESOURCE.match(resource)
        if match is None:
            continue
        references += 1
        digest = match.group(1)
        if _original_exists(original_root, digest):
            resolved += 1
        else:
            errors.append(f"missing Original for {path.relative_to(root).as_posix()}: {digest}")
    return RestoreVerification(
        valid=not errors,
        markdown_files=len(markdown),
        readable_files=readable,
        original_references=references,
        resolved_originals=resolved,
        errors=tuple(errors),
    )

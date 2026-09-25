"""Verify a restored Vault and content-addressed Original Store."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote

from okf_workspace.okf.frontmatter import FrontmatterError, read_document

_ORIGINAL_RESOURCE = re.compile(r"^okf-original://sha256/([0-9a-f]{64})/([^/?#]+)$")


@dataclass(frozen=True, slots=True)
class RestoreVerification:
    valid: bool
    markdown_files: int
    readable_files: int
    original_references: int
    resolved_originals: int
    errors: tuple[str, ...]


def _original_error(originals: Path, digest: str, extension: str) -> str | None:
    directory = originals / "sha256" / digest[:2] / digest
    stored = directory / f"original{extension}"
    if stored.is_symlink() or not stored.is_file():
        return "missing Original"
    actual = hashlib.sha256()
    try:
        with stored.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                actual.update(block)
    except OSError:
        return "unreadable Original"
    return None if actual.hexdigest() == digest else "corrupt Original"


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
    original_errors: dict[tuple[str, str], str | None] = {}
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
        if not isinstance(resource, str) or not resource.startswith("okf-original://"):
            continue
        references += 1
        match = _ORIGINAL_RESOURCE.match(resource)
        if match is None:
            errors.append(f"invalid Original resource for {path.relative_to(root).as_posix()}")
            continue
        digest = match.group(1)
        filename = unquote(match.group(2))
        extension = Path(filename).suffix.casefold()
        if not extension or "/" in filename or "\\" in filename:
            errors.append(f"invalid Original resource for {path.relative_to(root).as_posix()}")
            continue
        key = (digest, extension)
        if key not in original_errors:
            original_errors[key] = _original_error(original_root, digest, extension)
        original_error = original_errors[key]
        if original_error is None:
            resolved += 1
        else:
            errors.append(
                f"{original_error} for {path.relative_to(root).as_posix()}: {digest}"
            )
    return RestoreVerification(
        valid=not errors,
        markdown_files=len(markdown),
        readable_files=readable,
        original_references=references,
        resolved_originals=resolved,
        errors=tuple(errors),
    )

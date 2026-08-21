"""Discover authoritative Markdown files without consulting runtime state."""

from __future__ import annotations

import hashlib
from collections.abc import Iterator
from pathlib import Path

SKIPPED_DIRECTORIES = {".agents", ".claudian", ".git", ".obsidian", ".trash"}


def iter_markdown(vault: Path) -> Iterator[Path]:
    root = vault.resolve()
    for path in sorted(root.rglob("*.md")):
        relative = path.relative_to(root)
        if any(part in SKIPPED_DIRECTORIES for part in relative.parts):
            continue
        if relative.as_posix() == "AGENTS.md":
            continue
        if (
            len(relative.parts) >= 2
            and relative.parts[0] == "system"
            and relative.parts[1]
            in {
                "contracts",
                "reports",
                "templates",
                "views",
            }
        ):
            continue
        # The root index is a human navigation projection, not an
        # authoritative knowledge source.  This also excludes any legacy
        # nested indexes until migration removes them.
        if path.name == "index.md":
            continue
        yield path


def file_hash(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

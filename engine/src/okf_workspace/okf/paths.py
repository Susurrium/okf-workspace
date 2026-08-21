"""Bundle-relative path and filename helpers."""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path, PurePosixPath


class UnsafeBundlePath(ValueError):
    """Raised for absolute or traversing paths."""


def normalize_bundle_path(value: str) -> PurePosixPath:
    candidate = value.replace("\\", "/").strip()
    if not candidate or candidate.startswith("/"):
        raise UnsafeBundlePath(f"bundle path must be non-empty and relative: {value!r}")
    path = PurePosixPath(candidate)
    if any(part in {"", ".", ".."} for part in path.parts):
        raise UnsafeBundlePath(f"bundle path cannot contain traversal: {value!r}")
    if ":" in path.parts[0]:
        raise UnsafeBundlePath(f"bundle path cannot contain a drive: {value!r}")
    return path


def resolve_bundle_path(vault: Path, value: str) -> Path:
    relative = normalize_bundle_path(value)
    resolved_vault = vault.resolve()
    resolved = resolved_vault.joinpath(*relative.parts).resolve()
    if resolved != resolved_vault and resolved_vault not in resolved.parents:
        raise UnsafeBundlePath(f"path escapes Vault: {value!r}")
    return resolved


def slugify(title: str, *, fallback: str = "note") -> str:
    normalized = unicodedata.normalize("NFKC", title).strip()
    normalized = re.sub(r"[^\w\u3400-\u9fff]+", "-", normalized, flags=re.UNICODE)
    normalized = re.sub(r"-{2,}", "-", normalized).strip("-_")
    return normalized or fallback

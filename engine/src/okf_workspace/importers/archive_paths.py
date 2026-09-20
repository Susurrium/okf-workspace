"""Portable parser-output paths, including Windows drive/ADS/device safety."""

from __future__ import annotations

from pathlib import Path, PurePosixPath, PureWindowsPath


class UnsafeParserArchive(ValueError):
    """A parser output path is unsafe on one of our supported filesystems."""


def safe_relative_path(value: str) -> PurePosixPath:
    normalized = value.replace("\\", "/")
    parts = normalized.split("/")
    if (
        PureWindowsPath(value).drive
        or normalized.startswith("/")
        or any(
            part in {"", ".", ".."}
            or part.endswith((" ", "."))
            or any(ord(char) < 32 or char in ':<>"|?*' for char in part)
            or PureWindowsPath(part).is_reserved()
            for part in parts
        )
    ):
        raise UnsafeParserArchive(f"unsafe parser output path: {value!r}")
    return PurePosixPath(*parts)


def contained_output_path(root: Path, relative: str) -> Path:
    safe = safe_relative_path(relative)
    target = root.joinpath(*safe.parts)
    try:
        target.resolve().relative_to(root.resolve())
    except ValueError as exc:
        raise UnsafeParserArchive(f"parser output escapes its directory: {relative!r}") from exc
    return target

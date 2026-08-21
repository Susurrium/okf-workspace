"""Safely normalize parser ZIP output into Markdown and asset bytes."""

from __future__ import annotations

import stat
import zipfile
from pathlib import Path, PurePosixPath

from .models import ParserExport, ParserName

MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
MAX_ARCHIVE_ENTRIES = 20_000
ASSET_SUFFIXES = {
    ".avif",
    ".bmp",
    ".gif",
    ".jpeg",
    ".jpg",
    ".png",
    ".svg",
    ".tif",
    ".tiff",
    ".webp",
}


class UnsafeParserArchive(ValueError):
    """Raised when a parser ZIP can escape or exhaust the conversion directory."""


def _safe_name(value: str) -> PurePosixPath:
    normalized = value.replace("\\", "/")
    path = PurePosixPath(normalized)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise UnsafeParserArchive(f"unsafe ZIP member: {value!r}")
    return path


def _is_symlink(info: zipfile.ZipInfo) -> bool:
    mode = (info.external_attr >> 16) & 0xFFFF
    return stat.S_ISLNK(mode)


def normalize_zip(
    archive: Path,
    *,
    parser: ParserName,
    parser_version: str,
) -> ParserExport:
    markdown_candidates: list[tuple[str, bytes]] = []
    assets: dict[str, bytes] = {}
    total = 0
    with zipfile.ZipFile(archive) as bundle:
        entries = bundle.infolist()
        if len(entries) > MAX_ARCHIVE_ENTRIES:
            raise UnsafeParserArchive("parser ZIP contains too many entries")
        for info in entries:
            if info.is_dir():
                continue
            if _is_symlink(info):
                raise UnsafeParserArchive(f"parser ZIP contains a symlink: {info.filename}")
            path = _safe_name(info.filename)
            total += info.file_size
            if total > MAX_ARCHIVE_BYTES:
                raise UnsafeParserArchive("parser ZIP expands beyond the size limit")
            data = bundle.read(info)
            normalized = path.as_posix()
            if path.suffix.casefold() == ".md":
                markdown_candidates.append((normalized, data))
            elif path.suffix.casefold() in ASSET_SUFFIXES:
                assets[normalized] = data
    if not markdown_candidates:
        raise ValueError("parser ZIP contains no Markdown")
    preferred = [item for item in markdown_candidates if item[0] == "document.md"]
    if not preferred:
        preferred = [
            item for item in markdown_candidates if item[0].casefold().endswith("_full.md")
        ]
    selected = max(preferred or markdown_candidates, key=lambda item: len(item[1]))
    try:
        markdown = selected[1].decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ValueError(f"parser Markdown is not UTF-8: {selected[0]}") from exc
    selected_parent = PurePosixPath(selected[0]).parent
    normalized_assets: dict[str, bytes] = {}
    for asset_path, data in assets.items():
        candidate = PurePosixPath(asset_path)
        try:
            relative = candidate.relative_to(selected_parent)
        except ValueError:
            relative = candidate
        normalized_assets[relative.as_posix()] = data
    return ParserExport(
        markdown=markdown,
        assets=normalized_assets,
        parser=parser,
        parser_version=parser_version,
    )

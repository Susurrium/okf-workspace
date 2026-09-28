"""Safely normalize parser ZIP output into Markdown and asset bytes."""

from __future__ import annotations

import hashlib
import json
import stat
import zipfile
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from typing import cast

from .archive_paths import UnsafeParserArchive, safe_relative_path
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


def _integer(value: object, *, name: str) -> int:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise ValueError(f"invalid MarkItDown manifest {name}")
    return value


def _markitdown_metadata(
    manifest_bytes: bytes | None,
    *,
    markdown: bytes,
    assets: Mapping[str, bytes],
) -> tuple[tuple[str, ...], int | None, int | None, str | None, str | None]:
    if manifest_bytes is None:
        return (), None, None, None, None
    try:
        loaded = cast(object, json.loads(manifest_bytes))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("MarkItDown result manifest is invalid JSON") from exc
    if not isinstance(loaded, dict):
        raise ValueError("MarkItDown result manifest is not an object")
    manifest = cast(Mapping[str, object], loaded)
    schema_value = manifest.get("schema")
    if not isinstance(schema_value, str):
        return (), None, None, None, None
    if schema_value == "markitdown-result/v2":
        profile = manifest.get("profile")
        return (), None, None, schema_value, profile if isinstance(profile, str) else None
    if schema_value != "markitdown-result/v3":
        raise ValueError(f"unsupported MarkItDown result schema: {schema_value}")

    input_value = manifest.get("input")
    output_value = manifest.get("output")
    if not isinstance(input_value, dict) or not isinstance(output_value, dict):
        raise ValueError("MarkItDown v3 manifest has no input/output contract")
    input_manifest = cast(Mapping[str, object], input_value)
    output_manifest = cast(Mapping[str, object], output_value)
    markdown_hash = output_manifest.get("markdown_sha256")
    markdown_bytes = output_manifest.get("markdown_bytes")
    if markdown_hash != hashlib.sha256(markdown).hexdigest() or markdown_bytes != len(markdown):
        raise ValueError("MarkItDown Markdown integrity check failed")

    assets_value = output_manifest.get("assets")
    if not isinstance(assets_value, list):
        raise ValueError("MarkItDown v3 manifest has no asset list")
    declared_assets: set[str] = set()
    for raw in cast(list[object], assets_value):
        if not isinstance(raw, dict):
            raise ValueError("MarkItDown asset metadata is not an object")
        item = cast(Mapping[str, object], raw)
        path = item.get("path")
        digest = item.get("sha256")
        mime_type = item.get("mime_type")
        size = item.get("size_bytes")
        if (
            not isinstance(path, str)
            or not isinstance(digest, str)
            or not isinstance(mime_type, str)
            or not isinstance(size, int)
            or isinstance(size, bool)
        ):
            raise ValueError("MarkItDown asset metadata is incomplete")
        safe = PurePosixPath(path)
        if (
            safe.is_absolute()
            or safe.parts[:1] != ("images",)
            or len(safe.parts) != 2
            or safe.stem != digest
            or len(digest) != 64
            or any(character not in "0123456789abcdef" for character in digest)
            or mime_type.casefold() == "image/svg+xml"
            or safe.suffix.casefold() == ".svg"
        ):
            raise ValueError("MarkItDown asset identity is invalid")
        if path in declared_assets:
            raise ValueError("MarkItDown asset manifest contains a duplicate path")
        data = assets.get(path)
        if (
            data is None
            or size != len(data)
            or digest != hashlib.sha256(data).hexdigest()
            or not mime_type.startswith("image/")
        ):
            raise ValueError(f"MarkItDown asset integrity check failed: {path}")
        declared_assets.add(path)
    if declared_assets != set(assets):
        raise ValueError("MarkItDown bundle assets do not match its manifest")

    embedded = _integer(
        input_manifest.get("embedded_image_references"),
        name="embedded image references",
    )
    external = _integer(
        input_manifest.get("external_image_references"),
        name="external image references",
    )
    output_references = _integer(
        output_manifest.get("image_references"),
        name="output image references",
    )
    warnings_value = manifest.get("warnings")
    if not isinstance(warnings_value, list):
        raise ValueError("MarkItDown v3 warnings are invalid")
    warning_items = cast(list[object], warnings_value)
    if not all(isinstance(value, str) for value in warning_items):
        raise ValueError("MarkItDown v3 warnings are invalid")
    profile = manifest.get("profile")
    return (
        tuple(cast(str, value) for value in warning_items),
        embedded + external,
        output_references,
        schema_value,
        profile if isinstance(profile, str) else None,
    )


def _safe_name(value: str) -> PurePosixPath:
    return safe_relative_path(value)


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
    markitdown_manifest: bytes | None = None
    total = 0
    seen: set[str] = set()
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
            identity = path.as_posix().casefold()
            if identity in seen:
                raise UnsafeParserArchive(f"duplicate parser ZIP path: {info.filename!r}")
            seen.add(identity)
            total += info.file_size
            if total > MAX_ARCHIVE_BYTES:
                raise UnsafeParserArchive("parser ZIP expands beyond the size limit")
            data = bundle.read(info)
            normalized = path.as_posix()
            if path.suffix.casefold() == ".md":
                markdown_candidates.append((normalized, data))
            elif parser is ParserName.MARKITDOWN and normalized == "manifest.json":
                markitdown_manifest = data
            elif path.suffix.casefold() in ASSET_SUFFIXES:
                if path.suffix.casefold() == ".svg":
                    raise ValueError("SVG assets are not safe to publish")
                assets[normalized] = data
    if not markdown_candidates:
        raise ValueError("parser ZIP contains no Markdown")
    preferred = [
        item for item in markdown_candidates
        if PurePosixPath(item[0]).name in {"document.md", "full.md"}
    ]
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
    warnings, expected_images, output_images, bundle_schema, profile = _markitdown_metadata(
        markitdown_manifest,
        markdown=selected[1],
        assets=assets,
    )
    return ParserExport(
        markdown=markdown,
        assets=normalized_assets,
        parser=parser,
        parser_version=parser_version,
        warnings=warnings,
        expected_image_references=expected_images,
        output_image_references=output_images,
        bundle_schema=bundle_schema,
        profile=profile,
    )

"""Narrow PDF/PPTX/DOCX conversion and deterministic result bundle construction."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import posixpath
import re
import sys
import tempfile
import zipfile
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Any, BinaryIO
from xml.etree import ElementTree

from . import __version__
from .constants import (
    BACKEND_NAME,
    DEFAULT_PROFILE,
    RESULT_CAPABILITIES,
    RESULT_SCHEMA,
    SUPPORTED_PROFILES,
)


class ConversionLimitError(RuntimeError):
    """Raised when a validated document or result exceeds a configured limit."""


class EncryptedPdfError(RuntimeError):
    """Raised when a PDF cannot be opened without a password."""


class UnsupportedEmbeddedImageError(ValueError):
    """Raised for decoded image formats that are unsafe or unusable in the Vault."""


@dataclass(frozen=True, slots=True)
class DocumentInspection:
    source_format: str
    unit_kind: str
    unit_count: int
    embedded_image_relationships: int = 0
    embedded_image_references: int = 0
    external_image_relationships: int = 0
    external_image_references: int = 0
    embedded_image_parts: int = 0


@dataclass(frozen=True, slots=True)
class ExtractedAsset:
    data: bytes
    mime_type: str


_RELATIONSHIP_NS = "http://schemas.openxmlformats.org/package/2006/relationships"
_DATA_IMAGE_URI = re.compile(
    r"data:(?P<mime>image/[A-Za-z0-9.+-]+);base64,(?P<payload>[A-Za-z0-9+/=]+)",
    re.IGNORECASE,
)


def _inspect_pdf(path: Path, *, max_units: int) -> DocumentInspection:
    from pypdf import PdfReader

    with path.open("rb") as handle:
        reader = PdfReader(handle, strict=True)
        if reader.is_encrypted:
            try:
                decrypted = reader.decrypt("")
            except Exception as exc:
                raise EncryptedPdfError("The PDF is encrypted.") from exc
            if not decrypted:
                raise EncryptedPdfError("The PDF is encrypted.")
        count = len(reader.pages)
    if count <= 0:
        raise ValueError("The PDF contains no pages.")
    if count > max_units:
        raise ConversionLimitError(f"The PDF exceeds the {max_units}-page limit.")
    return DocumentInspection("pdf", "page", count)


def _validated_ooxml_names(archive: zipfile.ZipFile, *, label: str) -> set[str]:
    infos = archive.infolist()
    if len(infos) > 20_000:
        raise ConversionLimitError(f"The {label} contains too many package entries.")
    names: set[str] = set()
    folded_names: set[str] = set()
    total_uncompressed = 0
    for info in infos:
        name = info.filename
        normalized = PurePosixPath(name.replace("\\", "/"))
        if (
            name.startswith(("/", "\\"))
            or "\\" in name
            or any(part in {"", ".", ".."} for part in normalized.parts)
            or info.flag_bits & 0x1
        ):
            raise ValueError(f"The {label} contains an unsafe package entry.")
        folded = name.casefold()
        if folded in folded_names:
            raise ValueError(f"The {label} contains duplicate package entries.")
        names.add(name)
        folded_names.add(folded)
        total_uncompressed += info.file_size
        if total_uncompressed > 512 * 1024 * 1024:
            raise ConversionLimitError(
                f"The {label} uncompressed package exceeds the safety limit."
            )
    return names


def _relationship_path(part: PurePosixPath) -> PurePosixPath:
    return part.parent / "_rels" / f"{part.name}.rels"


def _resolve_relationship_target(part: PurePosixPath, target: str) -> PurePosixPath:
    normalized = target.replace("\\", "/")
    if normalized.startswith("//"):
        raise ValueError("The OOXML document contains an unsafe image relationship.")
    joined = normalized[1:] if normalized.startswith("/") else f"{part.parent}/{normalized}"
    resolved = PurePosixPath(posixpath.normpath(joined))
    if resolved.is_absolute() or any(value in {"", ".", ".."} for value in resolved.parts):
        raise ValueError("The OOXML document contains an unsafe image relationship.")
    return resolved


def _image_relationship_counts(
    archive: zipfile.ZipFile,
    *,
    content_parts: list[PurePosixPath],
    names: set[str],
) -> tuple[int, int, int, int, int]:
    embedded_relationships = 0
    embedded_references = 0
    external_relationships = 0
    external_references = 0
    embedded_parts: set[str] = set()
    for part in content_parts:
        relationship_part = _relationship_path(part)
        if relationship_part.as_posix() not in names:
            continue
        try:
            content_root = ElementTree.fromstring(archive.read(part.as_posix()))
            relationship_root = ElementTree.fromstring(archive.read(relationship_part.as_posix()))
        except ElementTree.ParseError as exc:
            raise ValueError("The OOXML document contains malformed relationship XML.") from exc
        attribute_values = [value for node in content_root.iter() for value in node.attrib.values()]
        relationships = [
            node
            for node in relationship_root
            if node.tag
            in {
                f"{{{_RELATIONSHIP_NS}}}Relationship",
                "{http://purl.oclc.org/ooxml/package/relationships}Relationship",
            }
        ]
        for relationship in relationships:
            relation_type = relationship.attrib.get("Type", "")
            if not relation_type.casefold().endswith("/image"):
                continue
            relation_id = relationship.attrib.get("Id")
            target = relationship.attrib.get("Target")
            if not relation_id or not target:
                raise ValueError("The OOXML document contains an incomplete image relationship.")
            reference_count = attribute_values.count(relation_id)
            if reference_count == 0:
                continue
            if relationship.attrib.get("TargetMode", "").casefold() == "external":
                external_relationships += 1
                external_references += reference_count
                continue
            target_part = _resolve_relationship_target(part, target)
            if target_part.as_posix() not in names:
                raise ValueError("The OOXML document references a missing embedded image part.")
            embedded_relationships += 1
            embedded_references += reference_count
            embedded_parts.add(target_part.as_posix())
    return (
        embedded_relationships,
        embedded_references,
        external_relationships,
        external_references,
        len(embedded_parts),
    )


def _inspect_pptx(path: Path, *, max_units: int) -> DocumentInspection:
    """Validate a bounded, macro-free OOXML presentation and count its slides."""

    slide_pattern = re.compile(r"ppt/slides/slide[1-9][0-9]*\.xml\Z")
    try:
        with zipfile.ZipFile(path) as archive:
            names = _validated_ooxml_names(archive, label="PPTX")
            folded_names = {name.casefold() for name in names}
            required = {"[content_types].xml", "ppt/presentation.xml"}
            if not required.issubset(folded_names):
                raise ValueError("The PPTX is missing required OOXML presentation parts.")
            if "ppt/vbaproject.bin" in folded_names:
                raise ValueError("Macro-enabled PowerPoint input is unsupported.")
            slide_parts = [PurePosixPath(name) for name in names if slide_pattern.fullmatch(name)]
            count = len(slide_parts)
            image_counts = _image_relationship_counts(
                archive,
                content_parts=slide_parts,
                names=names,
            )
    except zipfile.BadZipFile as exc:
        raise ValueError("The uploaded file is not a readable PPTX package.") from exc
    if count <= 0:
        raise ValueError("The PPTX contains no slides.")
    if count > max_units:
        raise ConversionLimitError(f"The PPTX exceeds the {max_units}-slide limit.")
    return DocumentInspection("pptx", "slide", count, *image_counts)


def _inspect_docx(path: Path) -> DocumentInspection:
    """Validate the minimum bounded OOXML Word structure expected from the client."""

    try:
        with zipfile.ZipFile(path) as archive:
            names = _validated_ooxml_names(archive, label="DOCX")
            folded_names = {name.casefold() for name in names}
            required = {"[content_types].xml", "word/document.xml"}
            if not required.issubset(folded_names):
                raise ValueError("The DOCX is missing required OOXML Word parts.")
            if "word/vbaproject.bin" in folded_names:
                raise ValueError("Macro-enabled Word input is unsupported.")
            image_counts = _image_relationship_counts(
                archive,
                content_parts=[PurePosixPath("word/document.xml")],
                names=names,
            )
    except zipfile.BadZipFile as exc:
        raise ValueError("The uploaded file is not a readable DOCX package.") from exc
    return DocumentInspection("docx", "document", 1, *image_counts)


def _inspect_document(path: Path, *, max_units: int) -> DocumentInspection:
    if path.suffix.lower() == ".pdf":
        return _inspect_pdf(path, max_units=max_units)
    if path.suffix.lower() == ".pptx":
        return _inspect_pptx(path, max_units=max_units)
    if path.suffix.lower() == ".docx":
        return _inspect_docx(path)
    raise ValueError("Only PDF, PPTX, and DOCX parser inputs are supported.")


def _convert_stream(
    handle: BinaryIO,
    *,
    filename: str,
    source_format: str,
) -> str:
    """Call only the selected built-in converter with plugins disabled."""

    from markitdown import MarkItDown, StreamInfo
    from markitdown.converters import DocxConverter, PdfConverter, PptxConverter

    converter = MarkItDown(enable_builtins=False, enable_plugins=False)
    if source_format == "pdf":
        converter.register_converter(PdfConverter())
        mimetype = "application/pdf"
        extension = ".pdf"
    elif source_format == "pptx":
        converter.register_converter(PptxConverter())
        mimetype = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
        extension = ".pptx"
    else:
        converter.register_converter(DocxConverter())
        mimetype = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        extension = ".docx"
    stream_info = StreamInfo(
        mimetype=mimetype,
        extension=extension,
        filename=filename,
    )
    result = converter.convert_stream(
        handle,
        stream_info=stream_info,
        keep_data_uris=source_format in {"docx", "pptx"},
    )
    return str(result.text_content)


def _asset_type(mime_type: str, data: bytes) -> tuple[str, str]:
    normalized = mime_type.casefold()
    if normalized in {"image/jpeg", "image/jpg"} and data.startswith(b"\xff\xd8\xff"):
        return "image/jpeg", ".jpg"
    if normalized in {"image/png", "image/x-png"} and data.startswith(b"\x89PNG\r\n\x1a\n"):
        return "image/png", ".png"
    if normalized == "image/gif" and data.startswith((b"GIF87a", b"GIF89a")):
        return "image/gif", ".gif"
    if normalized == "image/bmp" and data.startswith(b"BM"):
        return "image/bmp", ".bmp"
    if normalized in {"image/tiff", "image/tif"} and data.startswith((b"II*\x00", b"MM\x00*")):
        return "image/tiff", ".tiff"
    if (
        normalized == "image/webp"
        and len(data) >= 12
        and data.startswith(b"RIFF")
        and data[8:12] == b"WEBP"
    ):
        return "image/webp", ".webp"
    if normalized == "image/avif" and len(data) >= 12 and data[4:12] == b"ftypavif":
        return "image/avif", ".avif"
    if normalized == "image/svg+xml":
        raise UnsupportedEmbeddedImageError(
            "SVG images are omitted because they cannot be safely published without sanitizing."
        )
    if normalized not in {
        "image/jpeg",
        "image/jpg",
        "image/png",
        "image/x-png",
        "image/gif",
        "image/bmp",
        "image/tiff",
        "image/tif",
        "image/webp",
        "image/avif",
    }:
        raise UnsupportedEmbeddedImageError(f"Unsupported embedded image MIME type: {mime_type}")
    raise ValueError(f"An embedded image does not match its declared MIME type ({mime_type}).")


def _extract_data_images(
    markdown: str,
) -> tuple[str, dict[str, ExtractedAsset], int, tuple[str, ...]]:
    assets: dict[str, ExtractedAsset] = {}
    references = 0
    warnings: list[str] = []

    def replace(match: re.Match[str]) -> str:
        nonlocal references
        try:
            data = base64.b64decode(match.group("payload"), validate=True)
        except (ValueError, TypeError) as exc:
            raise ValueError("An embedded image contains invalid base64 data.") from exc
        if not data:
            raise ValueError("An embedded image is empty.")
        raw_mime_type = match.group("mime").casefold()
        try:
            mime_type, suffix = _asset_type(raw_mime_type, data)
        except UnsupportedEmbeddedImageError:
            warnings.append(f"unsupported_embedded_image:{raw_mime_type}")
            return f"[Embedded image omitted: {raw_mime_type}]"
        digest = hashlib.sha256(data).hexdigest()
        path = f"images/{digest}{suffix}"
        existing = assets.get(path)
        if existing is not None and existing.data != data:
            raise ValueError("An embedded image hash collision was detected.")
        assets[path] = ExtractedAsset(data=data, mime_type=mime_type)
        references += 1
        return path

    rewritten = _DATA_IMAGE_URI.sub(replace, markdown)
    if re.search(r"data:image/", rewritten, re.IGNORECASE):
        raise ValueError("An embedded image uses an unsupported or incomplete data URI.")
    return rewritten, assets, references, tuple(dict.fromkeys(warnings))


def _zip_info(name: str) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(filename=name, date_time=(1980, 1, 1, 0, 0, 0))
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o600 << 16
    info.create_system = 3
    return info


def write_result_bundle(
    output_path: Path,
    *,
    markdown: str,
    source_sha256: str,
    source_size_bytes: int,
    source_format: str,
    unit_kind: str,
    unit_count: int,
    profile: str,
    engine_version: str,
    engine_build_id: str,
    max_result_bytes: int,
    assets: dict[str, ExtractedAsset] | None = None,
    embedded_image_relationships: int = 0,
    embedded_image_references: int = 0,
    external_image_relationships: int = 0,
    external_image_references: int = 0,
    embedded_image_parts: int = 0,
    output_image_references: int = 0,
    additional_warnings: tuple[str, ...] = (),
) -> dict[str, Any]:
    """Write one deterministic, independently verifiable result ZIP atomically."""

    assets = assets or {}
    markdown_bytes = markdown.encode("utf-8")
    if len(markdown_bytes) > max_result_bytes:
        raise ConversionLimitError("The Markdown output exceeds the configured result limit.")

    warnings = list(additional_warnings)
    if not markdown.strip():
        warnings.append("empty_markdown")
    expected_image_references = embedded_image_references + external_image_references
    missing_image_references = max(0, expected_image_references - output_image_references)
    if missing_image_references:
        warnings.append(f"missing_image_references:{missing_image_references}")
    if external_image_references:
        warnings.append(f"external_image_references:{external_image_references}")

    markdown_sha256 = hashlib.sha256(markdown_bytes).hexdigest()
    asset_manifest: list[dict[str, object]] = []
    total_payload_bytes = len(markdown_bytes)
    for path, asset in sorted(assets.items()):
        safe = PurePosixPath(path)
        digest = hashlib.sha256(asset.data).hexdigest()
        if (
            safe.is_absolute()
            or safe.parts[:1] != ("images",)
            or len(safe.parts) != 2
            or safe.stem != digest
            or any(part in {"", ".", ".."} for part in safe.parts)
            or not asset.mime_type.startswith("image/")
            or safe.suffix.casefold() == ".svg"
            or asset.mime_type.casefold() == "image/svg+xml"
        ):
            raise ValueError(f"Unsafe result asset path: {path!r}")
        total_payload_bytes += len(asset.data)
        asset_manifest.append(
            {
                "path": safe.as_posix(),
                "sha256": digest,
                "mime_type": asset.mime_type,
                "size_bytes": len(asset.data),
            }
        )
    if total_payload_bytes > max_result_bytes:
        raise ConversionLimitError("The expanded result exceeds the configured result limit.")

    capabilities = {
        **RESULT_CAPABILITIES,
        "assets": "embedded" if source_format in {"docx", "pptx"} else False,
    }
    manifest: dict[str, Any] = {
        "schema": RESULT_SCHEMA,
        "source_sha256": source_sha256,
        "engine": {
            "name": BACKEND_NAME,
            "version": engine_version,
            "service_version": __version__,
            "build_id": engine_build_id,
        },
        "profile": profile,
        "capabilities": capabilities,
        "input": {
            "size_bytes": source_size_bytes,
            "source_format": source_format,
            "unit_kind": unit_kind,
            "unit_count": unit_count,
            "embedded_image_relationships": embedded_image_relationships,
            "embedded_image_references": embedded_image_references,
            "external_image_relationships": external_image_relationships,
            "external_image_references": external_image_references,
            "embedded_image_parts": embedded_image_parts,
        },
        "output": {
            "markdown_sha256": markdown_sha256,
            "markdown_bytes": len(markdown_bytes),
            "image_references": output_image_references,
            "assets": asset_manifest,
        },
        "warnings": warnings,
    }
    manifest_bytes = (
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")
    if total_payload_bytes + len(manifest_bytes) > max_result_bytes:
        raise ConversionLimitError("The expanded result exceeds the configured result limit.")

    output_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent
    )
    os.close(descriptor)
    temporary_path = Path(temporary_name)
    try:
        with zipfile.ZipFile(
            temporary_path,
            mode="w",
            compression=zipfile.ZIP_DEFLATED,
            compresslevel=6,
            allowZip64=False,
        ) as archive:
            archive.writestr(_zip_info("manifest.json"), manifest_bytes)
            archive.writestr(_zip_info("document.md"), markdown_bytes)
            for path, asset in sorted(assets.items()):
                archive.writestr(_zip_info(path), asset.data)
        result_size = temporary_path.stat().st_size
        if result_size > max_result_bytes:
            raise ConversionLimitError("The result ZIP exceeds the configured result limit.")
        os.replace(temporary_path, output_path)
    finally:
        temporary_path.unlink(missing_ok=True)
    return manifest


def convert_document_to_bundle(
    input_path: Path,
    output_path: Path,
    *,
    source_sha256: str,
    filename: str,
    profile: str,
    max_units: int,
    max_result_bytes: int,
    engine_version: str,
    engine_build_id: str,
    converter: Callable[[BinaryIO], str] | None = None,
) -> dict[str, Any]:
    """Validate one supported document, convert it, and build the response ZIP."""

    inspection = _inspect_document(
        input_path,
        max_units=max_units,
    )
    source_size = input_path.stat().st_size
    with input_path.open("rb") as handle:
        markdown = (
            _convert_stream(
                handle,
                filename=filename,
                source_format=inspection.source_format,
            )
            if converter is None
            else converter(handle)
        )
    markdown, assets, output_image_references, image_warnings = _extract_data_images(markdown)
    warnings = image_warnings
    if inspection.source_format == "pdf":
        warnings = ("pdf_text_only_images_not_extracted", *warnings)
    return write_result_bundle(
        output_path,
        markdown=markdown,
        source_sha256=source_sha256,
        source_size_bytes=source_size,
        source_format=inspection.source_format,
        unit_kind=inspection.unit_kind,
        unit_count=inspection.unit_count,
        profile=profile,
        engine_version=engine_version,
        engine_build_id=engine_build_id,
        max_result_bytes=max_result_bytes,
        assets=assets,
        embedded_image_relationships=inspection.embedded_image_relationships,
        embedded_image_references=inspection.embedded_image_references,
        external_image_relationships=inspection.external_image_relationships,
        external_image_references=inspection.external_image_references,
        embedded_image_parts=inspection.embedded_image_parts,
        output_image_references=output_image_references,
        additional_warnings=warnings,
    )


def convert_pdf_to_bundle(
    input_path: Path,
    output_path: Path,
    *,
    source_sha256: str,
    filename: str,
    profile: str,
    max_pages: int,
    max_result_bytes: int,
    engine_version: str,
    engine_build_id: str,
    converter: Callable[[BinaryIO], str] | None = None,
) -> dict[str, Any]:
    """Compatibility wrapper for callers that still use the PDF-specific name."""

    if input_path.suffix.lower() != ".pdf":
        raise ValueError("convert_pdf_to_bundle requires a .pdf input")
    return convert_document_to_bundle(
        input_path,
        output_path,
        source_sha256=source_sha256,
        filename=filename,
        profile=profile,
        max_units=max_pages,
        max_result_bytes=max_result_bytes,
        engine_version=engine_version,
        engine_build_id=engine_build_id,
        converter=converter,
    )


def _safe_failure(exc: BaseException) -> tuple[str, str]:
    class_name = type(exc).__name__
    if isinstance(exc, ConversionLimitError):
        return "capacity_exceeded", str(exc)
    if isinstance(exc, EncryptedPdfError):
        return "encrypted_pdf", "The PDF is encrypted and cannot be converted."
    if class_name in {"PdfReadError", "PdfStreamError"}:
        return "invalid_pdf", "The uploaded file is not a readable PDF."
    if class_name == "UnsupportedFormatException":
        return "unsupported_document", "MarkItDown did not recognize the document format."
    if class_name == "FileConversionException":
        return "conversion_failed", "MarkItDown could not convert this document."
    return "conversion_failed", f"Document conversion failed ({class_name})."


def _write_failure(path: Path, *, code: str, message: str) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    clean_message = re.sub(r"[\x00-\x1f\x7f]", " ", message).strip()[:300]
    payload = json.dumps(
        {"code": code, "message": clean_message}, ensure_ascii=False, sort_keys=True
    )
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(payload + "\n", encoding="utf-8")
    os.replace(temporary, path)


def child_main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Run one isolated PDF/PPTX conversion.")
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--failure", type=Path, required=True)
    parser.add_argument("--source-sha256", required=True)
    parser.add_argument("--filename", required=True)
    parser.add_argument("--profile", default=DEFAULT_PROFILE)
    parser.add_argument("--max-pages", type=int, required=True)
    parser.add_argument("--max-result-bytes", type=int, required=True)
    parser.add_argument("--engine-version", required=True)
    parser.add_argument("--engine-build-id", required=True)
    args = parser.parse_args(argv)

    if args.profile not in SUPPORTED_PROFILES:
        parser.error(f"unsupported profile: {args.profile}")

    try:
        convert_document_to_bundle(
            args.input,
            args.output,
            source_sha256=args.source_sha256,
            filename=args.filename,
            profile=args.profile,
            max_units=args.max_pages,
            max_result_bytes=args.max_result_bytes,
            engine_version=args.engine_version,
            engine_build_id=args.engine_build_id,
        )
    except Exception as exc:
        code, message = _safe_failure(exc)
        _write_failure(args.failure, code=code, message=message)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(child_main())

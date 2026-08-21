"""Narrow PDF/PPTX/DOCX conversion and deterministic result bundle construction."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import tempfile
import zipfile
from collections.abc import Callable
from pathlib import Path
from typing import Any, BinaryIO

from . import __version__
from .constants import BACKEND_NAME, DEFAULT_PROFILE, RESULT_CAPABILITIES, RESULT_SCHEMA


class ConversionLimitError(RuntimeError):
    """Raised when a validated document or result exceeds a configured limit."""


class EncryptedPdfError(RuntimeError):
    """Raised when a PDF cannot be opened without a password."""


def _inspect_pdf(path: Path, *, max_units: int) -> tuple[str, str, int]:
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
    return "pdf", "page", count


def _inspect_pptx(path: Path, *, max_units: int) -> tuple[str, str, int]:
    """Validate a bounded, macro-free OOXML presentation and count its slides."""

    slide_pattern = re.compile(r"ppt/slides/slide[1-9][0-9]*\.xml\Z")
    total_uncompressed = 0
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if len(infos) > 20_000:
                raise ConversionLimitError("The PPTX contains too many package entries.")
            names: set[str] = set()
            for info in infos:
                name = info.filename
                normalized = Path(name.replace("\\", "/"))
                if (
                    name.startswith(("/", "\\"))
                    or "\\" in name
                    or ".." in normalized.parts
                    or info.flag_bits & 0x1
                ):
                    raise ValueError("The PPTX contains an unsafe package entry.")
                folded = name.casefold()
                if folded in names:
                    raise ValueError("The PPTX contains duplicate package entries.")
                names.add(folded)
                total_uncompressed += info.file_size
                if total_uncompressed > 512 * 1024 * 1024:
                    raise ConversionLimitError(
                        "The PPTX uncompressed package exceeds the safety limit."
                    )
            required = {"[content_types].xml", "ppt/presentation.xml"}
            if not required.issubset(names):
                raise ValueError("The PPTX is missing required OOXML presentation parts.")
            if "ppt/vbaproject.bin" in names:
                raise ValueError("Macro-enabled PowerPoint input is unsupported.")
            count = sum(1 for name in names if slide_pattern.fullmatch(name))
    except zipfile.BadZipFile as exc:
        raise ValueError("The uploaded file is not a readable PPTX package.") from exc
    if count <= 0:
        raise ValueError("The PPTX contains no slides.")
    if count > max_units:
        raise ConversionLimitError(f"The PPTX exceeds the {max_units}-slide limit.")
    return "pptx", "slide", count


def _inspect_docx(path: Path) -> tuple[str, str, int]:
    """Validate the minimum bounded OOXML Word structure expected from the client."""

    total_uncompressed = 0
    try:
        with zipfile.ZipFile(path) as archive:
            infos = archive.infolist()
            if len(infos) > 20_000:
                raise ConversionLimitError("The DOCX contains too many package entries.")
            names: set[str] = set()
            for info in infos:
                name = info.filename
                normalized = Path(name.replace("\\", "/"))
                if (
                    name.startswith(("/", "\\"))
                    or "\\" in name
                    or ".." in normalized.parts
                    or info.flag_bits & 0x1
                ):
                    raise ValueError("The DOCX contains an unsafe package entry.")
                folded = name.casefold()
                if folded in names:
                    raise ValueError("The DOCX contains duplicate package entries.")
                names.add(folded)
                total_uncompressed += info.file_size
                if total_uncompressed > 512 * 1024 * 1024:
                    raise ConversionLimitError(
                        "The DOCX uncompressed package exceeds the safety limit."
                    )
            required = {"[content_types].xml", "word/document.xml"}
            if not required.issubset(names):
                raise ValueError("The DOCX is missing required OOXML Word parts.")
            if "word/vbaproject.bin" in names:
                raise ValueError("Macro-enabled Word input is unsupported.")
    except zipfile.BadZipFile as exc:
        raise ValueError("The uploaded file is not a readable DOCX package.") from exc
    return "docx", "document", 1


def _inspect_document(path: Path, *, max_units: int) -> tuple[str, str, int]:
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
    result = converter.convert_stream(handle, stream_info=stream_info)
    return str(result.text_content)


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
) -> dict[str, Any]:
    """Write an exact two-entry ZIP atomically and return its manifest."""

    markdown_bytes = markdown.encode("utf-8")
    if len(markdown_bytes) > max_result_bytes:
        raise ConversionLimitError("The Markdown output exceeds the configured result limit.")

    warnings: list[str] = []
    if not markdown.strip():
        warnings.append("empty_markdown")

    markdown_sha256 = hashlib.sha256(markdown_bytes).hexdigest()
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
        "capabilities": RESULT_CAPABILITIES,
        "input": {
            "size_bytes": source_size_bytes,
            "source_format": source_format,
            "unit_kind": unit_kind,
            "unit_count": unit_count,
        },
        "output": {
            "markdown_sha256": markdown_sha256,
            "markdown_bytes": len(markdown_bytes),
        },
        "warnings": warnings,
    }
    manifest_bytes = (
        json.dumps(manifest, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
    ).encode("utf-8")

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

    source_format, unit_kind, unit_count = _inspect_document(
        input_path,
        max_units=max_units,
    )
    source_size = input_path.stat().st_size
    with input_path.open("rb") as handle:
        markdown = (
            _convert_stream(
                handle,
                filename=filename,
                source_format=source_format,
            )
            if converter is None
            else converter(handle)
        )
    return write_result_bundle(
        output_path,
        markdown=markdown,
        source_sha256=source_sha256,
        source_size_bytes=source_size,
        source_format=source_format,
        unit_kind=unit_kind,
        unit_count=unit_count,
        profile=profile,
        engine_version=engine_version,
        engine_build_id=engine_build_id,
        max_result_bytes=max_result_bytes,
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

    if args.profile != DEFAULT_PROFILE:
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

"""Choose a parser from the document kind and user-facing quality choice."""

from __future__ import annotations

from pathlib import Path

from .models import ImportQuality, ParserName

SUPPORTED_EXTENSIONS = {".pdf", ".doc", ".docx", ".ppt", ".pptx"}


def choose_parser(
    source: Path,
    quality: ImportQuality,
    override: ParserName | None = None,
) -> ParserName:
    extension = source.suffix.casefold()
    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"unsupported document type {extension or '<none>'}; "
            "expected PDF, DOC, DOCX, PPT, or PPTX"
        )
    if override is not None:
        if extension in {".doc", ".docx"} and override is ParserName.MINERU:
            raise ValueError("DOC/DOCX uses MarkItDown after Word normalization")
        return override
    # Quality controls verification, not an implicit remote MinerU launch.
    # Retain the explicit override for users who deliberately opt back in.
    return ParserName.MARKITDOWN

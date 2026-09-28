"""Choose a parser from the document kind and user-facing quality choice."""

from __future__ import annotations

from pathlib import Path

from .models import ImportQuality, ParserName

SUPPORTED_EXTENSIONS = {
    ".pdf", ".doc", ".docx", ".ppt", ".pptx",
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif",
}


def choose_parser(
    source: Path,
    quality: ImportQuality,
    override: ParserName | None = None,
) -> ParserName:
    extension = source.suffix.casefold()
    if extension not in SUPPORTED_EXTENSIONS:
        raise ValueError(
            f"unsupported document type {extension or '<none>'}; "
            "expected PDF, DOC, DOCX, PPT, PPTX, or a supported image"
        )
    if override is not None:
        return override
    # Quality controls verification; cloud MinerU handles every supported format.
    return ParserName.MINERU

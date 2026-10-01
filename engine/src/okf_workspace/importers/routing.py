"""Choose a parser from the document kind and user-facing quality choice."""

from __future__ import annotations

from pathlib import Path

from .models import ConversionMethod, ImportQuality, ParserName

SUPPORTED_EXTENSIONS = {
    ".pdf", ".doc", ".docx", ".ppt", ".pptx",
    ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif",
}

METHOD_EXTENSIONS = {
    ConversionMethod.MINERU_CLOUD: frozenset(SUPPORTED_EXTENSIONS),
    ConversionMethod.MARKITDOWN_SERVICE: frozenset({".pdf", ".doc", ".docx", ".ppt", ".pptx"}),
    ConversionMethod.MINERU_SELF_HOSTED: frozenset({".pdf", ".ppt", ".pptx"}),
}


def choose_method(
    source: Path,
    method: ConversionMethod | None = None,
    parser: ParserName | None = None,
    *,
    default: ConversionMethod = ConversionMethod.MINERU_CLOUD,
) -> ConversionMethod:
    legacy = ConversionMethod.from_parser(parser) if parser is not None else None
    if method is not None and legacy is not None and method is not legacy:
        raise ValueError("method conflicts with legacy parser; specify only one conversion method")
    selected = method or legacy or default
    extension = source.suffix.casefold()
    if extension not in METHOD_EXTENSIONS[selected]:
        raise ValueError(
            f"{selected.value} does not support {extension or '<none>'}; "
            f"supported inputs: {', '.join(sorted(METHOD_EXTENSIONS[selected]))}"
        )
    return selected


def choose_parser(
    source: Path,
    quality: ImportQuality,
    override: ParserName | None = None,
) -> ParserName:
    del quality  # Quality controls verification, independently of conversion method.
    return choose_method(source, parser=override).parser

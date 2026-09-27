"""Only meaningful conversion checks; usable text is not blocked for cosmetics."""

from __future__ import annotations

import re

from .models import ParserExport, QCReport

_LOCAL_IMAGE = re.compile(r"!\[[^\]]*\]\((?!https?://|data:)([^)#]+)(?:#[^)]+)?\)")
_EMBEDDED_IMAGE = re.compile(r"!\[[^\]]*\]\((data:image/[^)]*)\)", re.IGNORECASE)
_IMAGE_MARKDOWN = re.compile(r"!\[[^\]]*\]\([^)]+\)")
_LINK_MARKDOWN = re.compile(r"\[([^\]]+)\]\([^)]+\)")


def _embedded_image_complete(value: str) -> bool:
    lowered = value.casefold()
    if ";base64," not in lowered or value.rstrip().endswith(("...", "…")):
        return False
    payload = value.split(",", 1)[1].strip()
    return len(payload) >= 16 and not payload.endswith(("...", "…"))


def inspect_export(export: ParserExport, *, strict_assets: bool = False) -> QCReport:
    markdown = export.markdown.strip()
    warnings = list(export.warnings)
    errors: list[str] = []
    checks: dict[str, bool] = {}

    checks["markdown_nonempty"] = bool(markdown)
    if not markdown:
        errors.append("parser returned empty Markdown")

    has_structure = any(
        line.startswith("# ") or line.startswith("## ") for line in markdown.splitlines()
    )
    checks["basic_structure"] = has_structure
    if markdown and not has_structure:
        warnings.append("Markdown has no heading; body remains importable")

    references = {match.replace("\\", "/").lstrip("./") for match in _LOCAL_IMAGE.findall(markdown)}
    assets = {path.replace("\\", "/").lstrip("./") for path in export.assets}
    missing = sorted(reference for reference in references if reference not in assets)
    checks["referenced_assets_present"] = not missing
    if missing:
        message = "missing referenced assets: " + ", ".join(missing[:10])
        (errors if strict_assets else warnings).append(message)

    embedded = _EMBEDDED_IMAGE.findall(markdown)
    incomplete_embedded = [value for value in embedded if not _embedded_image_complete(value)]
    checks["embedded_images_complete"] = not incomplete_embedded
    if incomplete_embedded:
        message = "embedded image data is truncated or only a placeholder"
        (errors if strict_assets else warnings).append(message)

    expected_images = export.expected_image_references
    output_images = export.output_image_references
    images_preserved = not (
        expected_images is not None and (output_images is None or output_images < expected_images)
    )
    checks["source_image_references_preserved"] = images_preserved
    if not images_preserved and expected_images is not None:
        missing_count = expected_images - (output_images or 0)
        message = f"parser omitted {missing_count} image reference(s) from the source document"
        (errors if strict_assets else warnings).append(message)

    text_without_images = _IMAGE_MARKDOWN.sub("", markdown)
    text_without_links = _LINK_MARKDOWN.sub(r"\1", text_without_images)
    visible = sum(character.isalnum() for character in text_without_links)
    replacement_ratio = markdown.count("\ufffd") / max(1, len(markdown))
    ocr_usable = visible >= 20 and replacement_ratio < 0.03
    checks["text_or_ocr_usable"] = ocr_usable
    visual_fallback = bool((references and not missing) or embedded) and not incomplete_embedded
    checks["visual_fallback_available"] = visual_fallback
    if markdown and not ocr_usable:
        message = "converted text is too short or appears badly decoded"
        if visual_fallback:
            warnings.append(message + "; original images remain available")
        else:
            errors.append(message)

    checks["parser_not_degraded"] = export.degraded_from is None
    if export.degraded_from is not None:
        warnings.append(
            f"parser degraded from {export.degraded_from.value} to {export.parser.value}"
        )
    return QCReport(
        passed=not errors,
        checks=checks,
        warnings=tuple(dict.fromkeys(warnings)),
        errors=tuple(errors),
    )

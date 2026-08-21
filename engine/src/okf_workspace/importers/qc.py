"""Only meaningful conversion checks; usable text is not blocked for cosmetics."""

from __future__ import annotations

import re

from .models import ParserExport, QCReport

_LOCAL_IMAGE = re.compile(r"!\[[^\]]*\]\((?!https?://|data:)([^)#]+)(?:#[^)]+)?\)")
_EMBEDDED_IMAGE = re.compile(r"!\[[^\]]*\]\((data:image/[^)]*)\)", re.IGNORECASE)


def _embedded_image_complete(value: str) -> bool:
    lowered = value.casefold()
    if ";base64," not in lowered or value.rstrip().endswith(("...", "…")):
        return False
    payload = value.split(",", 1)[1].strip()
    return len(payload) >= 16 and not payload.endswith(("...", "…"))


def inspect_export(export: ParserExport, *, strict_assets: bool = False) -> QCReport:
    markdown = export.markdown.strip()
    warnings: list[str] = []
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

    visible = sum(character.isalnum() for character in markdown)
    replacement_ratio = markdown.count("\ufffd") / max(1, len(markdown))
    ocr_usable = visible >= 20 and replacement_ratio < 0.03
    checks["text_or_ocr_usable"] = ocr_usable
    if markdown and not ocr_usable:
        errors.append("converted text is too short or appears badly decoded")

    checks["parser_not_degraded"] = export.degraded_from is None
    if export.degraded_from is not None:
        warnings.append(
            f"parser degraded from {export.degraded_from.value} to {export.parser.value}"
        )
    return QCReport(
        passed=not errors,
        checks=checks,
        warnings=tuple(warnings),
        errors=tuple(errors),
    )

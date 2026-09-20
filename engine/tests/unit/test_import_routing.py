from __future__ import annotations

from pathlib import Path

import pytest

from okf_workspace.importers.models import ImportQuality, ParserName
from okf_workspace.importers.routing import choose_parser


@pytest.mark.parametrize(
    ("filename", "quality", "expected"),
    [
        ("paper.pdf", ImportQuality.HIGH, ParserName.MARKITDOWN),
        ("paper.pdf", ImportQuality.QUICK, ParserName.MARKITDOWN),
        ("manual.docx", ImportQuality.HIGH, ParserName.MARKITDOWN),
        ("legacy.doc", ImportQuality.HIGH, ParserName.MARKITDOWN),
        ("slides.pptx", ImportQuality.HIGH, ParserName.MARKITDOWN),
        ("slides.ppt", ImportQuality.QUICK, ParserName.MARKITDOWN),
    ],
)
def test_user_facing_quality_routes_to_expected_parser(
    filename: str,
    quality: ImportQuality,
    expected: ParserName,
) -> None:
    assert choose_parser(Path(filename), quality) is expected


def test_explicit_parser_is_respected_but_doc_cannot_use_mineru() -> None:
    assert (
        choose_parser(
            Path("slides.pptx"),
            ImportQuality.HIGH,
            ParserName.MINERU,
        )
        is ParserName.MINERU
    )
    with pytest.raises(ValueError):
        choose_parser(
            Path("manual.docx"),
            ImportQuality.HIGH,
            ParserName.MINERU,
        )

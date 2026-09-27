from __future__ import annotations

from pathlib import Path

import pytest

from okf_workspace.importers.models import ImportQuality, ParserName
from okf_workspace.importers.routing import choose_parser


@pytest.mark.parametrize(
    ("filename", "quality", "expected"),
    [
        ("paper.pdf", ImportQuality.HIGH, ParserName.MINERU),
        ("paper.pdf", ImportQuality.QUICK, ParserName.MINERU),
        ("manual.docx", ImportQuality.HIGH, ParserName.MINERU),
        ("legacy.doc", ImportQuality.HIGH, ParserName.MINERU),
        ("slides.pptx", ImportQuality.HIGH, ParserName.MINERU),
        ("slides.ppt", ImportQuality.QUICK, ParserName.MINERU),
        ("diagram.PNG", ImportQuality.QUICK, ParserName.MINERU),
    ],
)
def test_user_facing_quality_routes_to_expected_parser(
    filename: str,
    quality: ImportQuality,
    expected: ParserName,
) -> None:
    assert choose_parser(Path(filename), quality) is expected


def test_explicit_mineru_accepts_word_documents() -> None:
    assert (
        choose_parser(
            Path("slides.pptx"),
            ImportQuality.HIGH,
            ParserName.MINERU,
        )
        is ParserName.MINERU
    )
    assert (
        choose_parser(Path("manual.docx"), ImportQuality.HIGH, ParserName.MINERU)
        is ParserName.MINERU
    )

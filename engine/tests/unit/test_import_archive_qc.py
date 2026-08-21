from __future__ import annotations

import zipfile
from pathlib import Path

import pytest

from okf_workspace.importers.archive import UnsafeParserArchive, normalize_zip
from okf_workspace.importers.models import ParserExport, ParserName
from okf_workspace.importers.qc import inspect_export


def test_mineru_nested_bundle_becomes_complete_markdown_and_relative_assets(
    tmp_path: Path,
) -> None:
    archive = tmp_path / "result.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(
            "manual/manual_full.md",
            "# Manual\n\n正文足够长，用于验证完整 Markdown。\n\n![diagram](images/diagram.png)\n",
        )
        bundle.writestr("manual/images/diagram.png", b"PNG")

    export = normalize_zip(
        archive,
        parser=ParserName.MINERU,
        parser_version="3.4.4",
    )

    assert export.markdown.startswith("# Manual")
    assert export.assets == {"images/diagram.png": b"PNG"}
    assert inspect_export(export).passed


def test_zip_traversal_is_rejected(tmp_path: Path) -> None:
    archive = tmp_path / "unsafe.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("../escape.md", "# Escape")

    with pytest.raises(UnsafeParserArchive):
        normalize_zip(
            archive,
            parser=ParserName.MINERU,
            parser_version="test",
        )


def test_missing_asset_warns_but_usable_text_is_not_blocked() -> None:
    export = ParserExport(
        markdown=(
            "# Useful\n\n这是一段仍然可以阅读和检索的正文，"
            "即使某张非关键图片缺失也不应该阻断导入。\n\n"
            "![missing](images/missing.png)\n"
        ),
        assets={},
        parser=ParserName.MARKITDOWN,
        parser_version="test",
    )

    report = inspect_export(export)

    assert report.passed
    assert not report.checks["referenced_assets_present"]
    assert report.warnings


def test_truncated_data_image_placeholder_is_not_treated_as_a_valid_image() -> None:
    export = ParserExport(
        markdown=(
            "# Word 文档\n\n这是一段完整且可阅读的正文。\n\n![figure](data:image/jpeg;base64...)\n"
        ),
        assets={},
        parser=ParserName.MARKITDOWN,
        parser_version="test",
    )

    report = inspect_export(export)

    assert not report.checks["embedded_images_complete"]
    assert any("embedded image" in warning for warning in report.warnings)

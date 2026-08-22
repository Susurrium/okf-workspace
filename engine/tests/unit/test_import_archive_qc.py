from __future__ import annotations

import hashlib
import json
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


def test_markitdown_v3_bundle_verifies_assets_and_exposes_image_counts(tmp_path: Path) -> None:
    archive = tmp_path / "result.zip"
    image = b"\x89PNG\r\n\x1a\nfixture"
    image_hash = hashlib.sha256(image).hexdigest()
    image_path = f"images/{image_hash}.png"
    markdown = f"# Illustrated\n\nUseful converted body text.\n\n![figure]({image_path})\n"
    manifest: dict[str, object] = {
        "schema": "markitdown-result/v3",
        "profile": "fallback-assets-v2",
        "input": {
            "embedded_image_references": 1,
            "external_image_references": 0,
        },
        "output": {
            "markdown_sha256": hashlib.sha256(markdown.encode()).hexdigest(),
            "markdown_bytes": len(markdown.encode()),
            "image_references": 1,
            "assets": [
                {
                    "path": image_path,
                    "sha256": image_hash,
                    "mime_type": "image/png",
                    "size_bytes": len(image),
                }
            ],
        },
        "warnings": [],
    }
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("manifest.json", json.dumps(manifest))
        bundle.writestr("document.md", markdown)
        bundle.writestr(image_path, image)

    export = normalize_zip(
        archive,
        parser=ParserName.MARKITDOWN,
        parser_version="0.1.6",
    )

    assert export.assets == {image_path: image}
    assert export.expected_image_references == 1
    assert export.output_image_references == 1
    assert export.bundle_schema == "markitdown-result/v3"
    assert export.profile == "fallback-assets-v2"
    assert inspect_export(export, strict_assets=True).passed


def test_markitdown_v3_rejects_asset_hash_mismatch(tmp_path: Path) -> None:
    archive = tmp_path / "result.zip"
    markdown = "# Document\n\nReadable converted body text.\n"
    image = b"image"
    declared_hash = hashlib.sha256(image).hexdigest()
    image_path = f"images/{declared_hash}.png"
    corrupted_image = b"imagf"
    manifest: dict[str, object] = {
        "schema": "markitdown-result/v3",
        "profile": "fallback-assets-v2",
        "input": {"embedded_image_references": 1, "external_image_references": 0},
        "output": {
            "markdown_sha256": hashlib.sha256(markdown.encode()).hexdigest(),
            "markdown_bytes": len(markdown.encode()),
            "image_references": 1,
            "assets": [
                {
                    "path": image_path,
                    "sha256": declared_hash,
                    "mime_type": "image/png",
                    "size_bytes": len(corrupted_image),
                }
            ],
        },
        "warnings": [],
    }
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("manifest.json", json.dumps(manifest))
        bundle.writestr("document.md", markdown)
        bundle.writestr(image_path, corrupted_image)

    with pytest.raises(ValueError, match="asset integrity"):
        normalize_zip(
            archive,
            parser=ParserName.MARKITDOWN,
            parser_version="0.1.6",
        )


def test_legacy_markitdown_bundle_cannot_smuggle_an_svg_asset(tmp_path: Path) -> None:
    archive = tmp_path / "legacy-svg.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(
            "manifest.json",
            json.dumps(
                {
                    "schema": "markitdown-result/v2",
                    "profile": "fallback-text-v1",
                }
            ),
        )
        bundle.writestr(
            "document.md",
            "# Unsafe\n\n![figure](images/unsafe.svg)\n",
        )
        bundle.writestr(
            "images/unsafe.svg",
            '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        )

    with pytest.raises(ValueError, match="SVG assets"):
        normalize_zip(
            archive,
            parser=ParserName.MARKITDOWN,
            parser_version="0.1.6",
        )


def test_missing_source_image_fails_high_quality_but_warns_in_quick_mode() -> None:
    export = ParserExport(
        markdown="# Text only\n\nThis converted body is long enough to remain useful.\n",
        assets={},
        parser=ParserName.MARKITDOWN,
        parser_version="0.1.6",
        warnings=("missing_image_references:1",),
        expected_image_references=2,
        output_image_references=1,
    )

    quick = inspect_export(export, strict_assets=False)
    high = inspect_export(export, strict_assets=True)

    assert quick.passed
    assert not quick.checks["source_image_references_preserved"]
    assert any("omitted 1 image" in warning for warning in quick.warnings)
    assert not high.passed
    assert any("omitted 1 image" in error for error in high.errors)

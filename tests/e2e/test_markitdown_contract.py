from __future__ import annotations

import hashlib
import json
import sys
import zipfile
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "services" / "markitdown" / "src"))

from markitdown_service.conversion import ExtractedAsset, write_result_bundle
from okf_workspace.importers.archive import normalize_zip
from okf_workspace.importers.models import ParserName


def test_markitdown_bundle_is_accepted_by_engine(tmp_path: Path) -> None:
    bundle = tmp_path / "result.zip"
    source_sha256 = "a" * 64

    write_result_bundle(
        bundle,
        markdown="# Contract test\n\nBody\n",
        source_sha256=source_sha256,
        source_size_bytes=128,
        source_format="pdf",
        unit_kind="page",
        unit_count=1,
        profile="fallback-assets-v2",
        engine_version="0.1.6",
        engine_build_id="markitdown-0.1.6-py31213-assets-v3",
        max_result_bytes=1024 * 1024,
        additional_warnings=("pdf_text_only_images_not_extracted",),
    )

    export = normalize_zip(
        bundle,
        parser=ParserName.MARKITDOWN,
        parser_version="0.1.6",
    )

    assert export.markdown == "# Contract test\n\nBody\n"
    assert export.parser is ParserName.MARKITDOWN
    assert export.parser_version == "0.1.6"
    assert export.assets == {}
    assert export.bundle_schema == "markitdown-result/v3"
    assert export.profile == "fallback-assets-v2"

    with zipfile.ZipFile(bundle) as archive:
        assert set(archive.namelist()) == {"document.md", "manifest.json"}
        manifest = json.loads(archive.read("manifest.json"))
    assert manifest["source_sha256"] == source_sha256
    assert manifest["engine"]["service_version"] == "1.3.0"
    assert manifest["engine"]["build_id"] == "markitdown-0.1.6-py31213-assets-v3"
    assert manifest["input"]["source_format"] == "pdf"
    assert manifest["warnings"] == ["pdf_text_only_images_not_extracted"]


def test_markitdown_asset_bundle_is_accepted_by_engine(tmp_path: Path) -> None:
    bundle = tmp_path / "illustrated-result.zip"
    image = b"\x89PNG\r\n\x1a\ncontract-image"
    digest = hashlib.sha256(image).hexdigest()
    asset_path = f"images/{digest}.png"

    write_result_bundle(
        bundle,
        markdown=f"# Illustrated contract\n\n![figure]({asset_path})\n",
        source_sha256="b" * 64,
        source_size_bytes=256,
        source_format="docx",
        unit_kind="document",
        unit_count=1,
        profile="fallback-assets-v2",
        engine_version="0.1.6",
        engine_build_id="markitdown-0.1.6-py31213-assets-v3",
        max_result_bytes=1024 * 1024,
        assets={asset_path: ExtractedAsset(data=image, mime_type="image/png")},
        embedded_image_relationships=1,
        embedded_image_references=1,
        embedded_image_parts=1,
        output_image_references=1,
    )

    export = normalize_zip(
        bundle,
        parser=ParserName.MARKITDOWN,
        parser_version="0.1.6",
    )

    assert export.assets == {asset_path: image}
    assert export.expected_image_references == 1
    assert export.output_image_references == 1
    assert export.warnings == ()

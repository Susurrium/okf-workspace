from __future__ import annotations

import json
import sys
import zipfile
from pathlib import Path

REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPOSITORY_ROOT / "services" / "markitdown" / "src"))

from markitdown_service.conversion import write_result_bundle
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
        profile="fallback-text-v1",
        engine_version="0.1.6",
        engine_build_id="markitdown-0.1.6-py31213-v3",
        max_result_bytes=1024 * 1024,
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

    with zipfile.ZipFile(bundle) as archive:
        assert set(archive.namelist()) == {"document.md", "manifest.json"}
        manifest = json.loads(archive.read("manifest.json"))
    assert manifest["source_sha256"] == source_sha256
    assert manifest["engine"]["service_version"] == "1.2.0"
    assert manifest["engine"]["build_id"] == "markitdown-0.1.6-py31213-v3"
    assert manifest["input"]["source_format"] == "pdf"

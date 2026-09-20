from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from okf_workspace.importers.archive import UnsafeParserArchive, normalize_zip
from okf_workspace.importers.archive_paths import contained_output_path, safe_relative_path
from okf_workspace.importers.export import load_export_contract, write_export_contract
from okf_workspace.importers.models import OriginalRecord, ParserExport, ParserName, QCReport


@pytest.mark.parametrize(
    "value",
    [
        "C:/Users/test/image.png",
        "C:relative.png",
        "//server/share/image.png",
        "\\\\?\\C:\\image.png",
        "image.png:secret",
        "../outside.png",
        "a/../image.png",
        "/image.png",
        "a//image.png",
        "a/./image.png",
        "NUL.png",
        "COM1/image.png",
        "assets /image.png",
        "assets./image.png",
        "image\x00.png",
    ],
)
def test_paths_reject_windows_escape_and_aliases(value: str, tmp_path: Path) -> None:
    with pytest.raises(UnsafeParserArchive):
        contained_output_path(tmp_path, value)


def test_safe_unicode_nested_path() -> None:
    assert safe_relative_path("images\\测试_01.png").as_posix() == "images/测试_01.png"


def test_zip_rejects_windows_drive_asset(tmp_path: Path) -> None:
    archive = tmp_path / "output.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("document.md", "# document")
        bundle.writestr("C:/Users/example/Pictures/replace.png", b"image")
    with pytest.raises(UnsafeParserArchive):
        normalize_zip(archive, parser=ParserName.MARKITDOWN, parser_version="test")


def test_zip_rejects_case_aliases(tmp_path: Path) -> None:
    archive = tmp_path / "output.zip"
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr("document.md", "# document")
        bundle.writestr("images/A.png", b"one")
        bundle.writestr("images/a.png", b"two")
    with pytest.raises(UnsafeParserArchive, match="duplicate"):
        normalize_zip(archive, parser=ParserName.MARKITDOWN, parser_version="test")


def test_export_sink_rejects_drive_asset_before_publishing(tmp_path: Path) -> None:
    directory = tmp_path / "export"
    export = ParserExport("# document", {"C:/outside.png": b"image"}, ParserName.MARKITDOWN, "test")
    original = OriginalRecord(
        "abc", "input.pdf", ".pdf", 5, tmp_path / "input.pdf", "okf-original://sha256/abc/input.pdf"
    )
    with pytest.raises(UnsafeParserArchive):
        write_export_contract(
            directory,
            conversion_id="test",
            original=original,
            export=export,
            qc=QCReport(True, {}, (), ()),
        )
    assert not directory.exists()


@pytest.mark.parametrize(
    "field,value",
    [
        ("markdown", "../outside.md"),
        ("markdown", "C:/outside.md"),
        ("assets", ["assets/../../outside.png"]),
        ("assets", ["C:/outside.png"]),
    ],
)
def test_saved_export_contract_cannot_read_outside_directory(
    tmp_path: Path,
    field: str,
    value: object,
) -> None:
    manifest: dict[str, object] = {"markdown": "document.md", "assets": [], "parser": "markitdown"}
    manifest[field] = value
    (tmp_path / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
    (tmp_path / "qc-report.json").write_text('{"passed": true}', encoding="utf-8")
    (tmp_path / "document.md").write_text("# document", encoding="utf-8")
    with pytest.raises(UnsafeParserArchive):
        load_export_contract(tmp_path)

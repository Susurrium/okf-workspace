from __future__ import annotations

import hashlib
import json
import time
import zipfile
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest

from okf_workspace.importers.models import (
    ConversionStatus,
    ImportIntent,
    ImportQuality,
    ImportRequest,
    ParserExport,
    ParserName,
)
from okf_workspace.importers.originals import OriginalStore
from okf_workspace.importers.pipeline import DocumentImporter
from okf_workspace.importers.state import ConversionStore
from okf_workspace.okf.templates import initialize_vault

FIXTURES = Path(__file__).parents[1] / "fixtures" / "documents"


class FixtureParser:
    def __init__(self, parser: ParserName, *, error: Exception | None = None) -> None:
        self.parser = parser
        self.error = error

    def convert(
        self,
        source: Path,
        working_directory: Path,
        *,
        timeout_seconds: float = 900.0,
    ) -> ParserExport:
        if self.error is not None:
            raise self.error
        return ParserExport(
            markdown=(
                "# Complete conversion fixture\n\n"
                "## Preserved structure\n\n"
                "This is the full Markdown conversion result, not a preview. "
                "It preserves headings, lists, tables, notes, and source provenance.\n\n"
                "- Separate item one\n- Separate item two\n"
            ),
            assets={},
            parser=self.parser,
            parser_version="fixture-1.0",
        )


class FixtureDocConverter:
    def convert(self, source: Path, destination: Path) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        with zipfile.ZipFile(destination, "w") as bundle:
            bundle.writestr("[Content_Types].xml", "<Types/>")
            member = (
                "word/document.xml" if destination.suffix == ".docx" else "ppt/slides/slide1.xml"
            )
            bundle.writestr(member, "<root>Normalized legacy fixture</root>")
        return destination


def test_committed_office_and_pdf_fixtures_are_structurally_real() -> None:
    expected = {
        "simple.docx",
        "legacy.doc",
        "slides.pptx",
        "text.pdf",
        "scan.pdf",
        "two-column.pdf",
        "formula.pdf",
        "broken.pdf",
        "duplicate.pdf",
    }
    assert expected <= {path.name for path in FIXTURES.iterdir() if path.is_file()}

    with zipfile.ZipFile(FIXTURES / "simple.docx") as bundle:
        document_xml = bundle.read("word/document.xml")
        styles_xml = bundle.read("word/styles.xml")
        assert b"w:hyperlink" in document_xml
        assert b"w:tbl" in document_xml
        assert b"ListBullet" in document_xml
        assert b"w:numPr" in styles_xml

    with zipfile.ZipFile(FIXTURES / "slides.pptx") as bundle:
        names = set(bundle.namelist())
        assert {"ppt/slides/slide1.xml", "ppt/slides/slide2.xml"} <= names
        assert any(name.startswith("ppt/notesSlides/notesSlide") for name in names)
        assert any(name.startswith("ppt/media/") for name in names)
        combined = b"".join(
            bundle.read(name) for name in names if name.startswith("ppt/slides/slide")
        )
        assert b"PowerPoint conversion" in combined
        assert b"Separate bullet items" in combined

    assert (FIXTURES / "text.pdf").read_bytes().startswith(b"%PDF-")
    assert (FIXTURES / "text.pdf").read_bytes().rstrip().endswith(b"%%EOF")
    assert not (FIXTURES / "broken.pdf").read_bytes().rstrip().endswith(b"%%EOF")
    assert (
        hashlib.sha256((FIXTURES / "text.pdf").read_bytes()).digest()
        == hashlib.sha256((FIXTURES / "duplicate.pdf").read_bytes()).digest()
    )


@pytest.mark.parametrize(
    ("filename", "quality", "expected"),
    [
        ("text.pdf", ImportQuality.HIGH, ParserName.MARKITDOWN),
        ("scan.pdf", ImportQuality.HIGH, ParserName.MARKITDOWN),
        ("two-column.pdf", ImportQuality.HIGH, ParserName.MARKITDOWN),
        ("formula.pdf", ImportQuality.HIGH, ParserName.MARKITDOWN),
        ("text.pdf", ImportQuality.QUICK, ParserName.MARKITDOWN),
        ("simple.docx", ImportQuality.HIGH, ParserName.MARKITDOWN),
        ("slides.pptx", ImportQuality.HIGH, ParserName.MARKITDOWN),
        ("legacy.doc", ImportQuality.HIGH, ParserName.MARKITDOWN),
    ],
)
def test_real_format_fixtures_complete_the_expected_pipeline(
    tmp_path: Path,
    filename: str,
    quality: ImportQuality,
    expected: ParserName,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    importer = DocumentImporter(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        clients={
            ParserName.MINERU: FixtureParser(ParserName.MINERU),
            ParserName.MARKITDOWN: FixtureParser(ParserName.MARKITDOWN),
        },
        doc_converter=FixtureDocConverter(),
    )

    result = importer.import_document(
        ImportRequest(
            source=FIXTURES / filename,
            intent=ImportIntent.SOURCE,
            quality=quality,
        )
    )

    assert result.parser is expected
    assert result.source is not None
    assert result.source_text is not None
    assert (result.export_directory / "document.md").is_file()
    assert "full Markdown conversion result" in (result.export_directory / "document.md").read_text(
        encoding="utf-8"
    )


def test_duplicate_pdf_reuses_one_original_and_records_both_names(tmp_path: Path) -> None:
    store = OriginalStore(tmp_path / "originals")
    first = store.ingest(FIXTURES / "text.pdf")
    second = store.ingest(FIXTURES / "duplicate.pdf")

    assert first.sha256 == second.sha256
    assert first.stored_path == second.stored_path
    metadata = json.loads((first.stored_path.parent / "manifest.json").read_text("utf-8"))
    assert metadata["filenames"] == ["duplicate.pdf", "text.pdf"]


def test_concurrent_duplicate_originals_preserve_every_filename(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    store = OriginalStore(tmp_path / "originals")
    first = store.ingest(FIXTURES / "text.pdf")
    metadata = first.stored_path.parent / "manifest.json"
    original_read = Path.read_text

    def slow_manifest_read(
        path: Path,
        encoding: str | None = None,
        errors: str | None = None,
    ) -> str:
        content = original_read(path, encoding=encoding, errors=errors)
        if path == metadata:
            time.sleep(0.02)
        return content

    monkeypatch.setattr(Path, "read_text", slow_manifest_read)
    names = [f"duplicate-{index}.pdf" for index in range(8)]
    ready = Barrier(len(names))

    def ingest(name: str) -> None:
        ready.wait(timeout=5)
        store.ingest(FIXTURES / "text.pdf", filename=name)

    with ThreadPoolExecutor(max_workers=len(names)) as pool:
        list(pool.map(ingest, names))

    manifest = json.loads(metadata.read_text(encoding="utf-8"))
    assert manifest["filenames"] == sorted(["text.pdf", *names])


def test_broken_pdf_is_failed_without_publishing_a_source(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    importer = DocumentImporter(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        clients={
            ParserName.MINERU: FixtureParser(
                ParserName.MINERU,
                error=RuntimeError("damaged PDF"),
            )
        },
    )

    with pytest.raises(RuntimeError, match="damaged PDF"):
        importer.import_document(
            ImportRequest(
                source=FIXTURES / "broken.pdf",
                intent=ImportIntent.SOURCE,
                parser=ParserName.MINERU,
            )
        )

    records = ConversionStore(tmp_path / "state").list(status=ConversionStatus.FAILED)
    assert len(records) == 1
    assert records[0]["error"] == "damaged PDF"
    assert not list((vault / "sources" / "records" / "documents").glob("broken*.md"))

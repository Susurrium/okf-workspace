from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

from pypdf import PdfWriter

from markitdown_service.conversion import (
    ConversionLimitError,
    convert_document_to_bundle,
    convert_pdf_to_bundle,
)


def make_pdf(path: Path, pages: int = 1) -> None:
    writer = PdfWriter()
    for _ in range(pages):
        writer.add_blank_page(width=72, height=72)
    with path.open("wb") as handle:
        writer.write(handle)


def test_conversion_builds_exact_verified_bundle(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    output = tmp_path / "result.zip"
    make_pdf(source)
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()

    manifest = convert_pdf_to_bundle(
        source,
        output,
        source_sha256=source_hash,
        filename="source.pdf",
        profile="fallback-text-v1",
        max_pages=10,
        max_result_bytes=4096,
        engine_version="0.1.6",
        engine_build_id="markitdown-0.1.6-py31213-v3",
        converter=lambda _handle: "# Test\n\nBody\n",
    )

    with zipfile.ZipFile(output) as archive:
        assert set(archive.namelist()) == {"manifest.json", "document.md"}
        markdown = archive.read("document.md")
        archived_manifest = json.loads(archive.read("manifest.json"))
        assert archive.getinfo("manifest.json").date_time == (1980, 1, 1, 0, 0, 0)

    assert manifest == archived_manifest
    assert manifest["schema"] == "markitdown-result/v2"
    assert manifest["source_sha256"] == source_hash
    assert manifest["input"]["unit_count"] == 1
    assert manifest["engine"]["build_id"] == "markitdown-0.1.6-py31213-v3"
    assert manifest["capabilities"] == {
        "page_map": False,
        "assets": False,
        "ocr": False,
        "formulas": False,
        "tables": "best_effort",
        "headings": "best_effort",
    }
    assert manifest["input"] == {
        "size_bytes": source.stat().st_size,
        "source_format": "pdf",
        "unit_kind": "page",
        "unit_count": 1,
    }
    assert manifest["output"]["markdown_sha256"] == hashlib.sha256(markdown).hexdigest()


def test_pinned_markitdown_pdf_converter_runs_without_a_mock(tmp_path: Path) -> None:
    source = tmp_path / "real-converter.pdf"
    output = tmp_path / "real-converter.zip"
    make_pdf(source)

    manifest = convert_pdf_to_bundle(
        source,
        output,
        source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        filename=source.name,
        profile="fallback-text-v1",
        max_pages=1,
        max_result_bytes=1024 * 1024,
        engine_version="0.1.6",
        engine_build_id="markitdown-0.1.6-py31213-v3",
    )

    with zipfile.ZipFile(output) as archive:
        markdown = archive.read("document.md")
    assert markdown.decode("utf-8") == ""
    assert manifest["warnings"] == ["empty_markdown"]
    assert manifest["output"]["markdown_sha256"] == hashlib.sha256(markdown).hexdigest()


def test_page_limit_is_enforced_before_conversion(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    make_pdf(source, pages=2)
    called = False

    def converter(_handle: object) -> str:
        nonlocal called
        called = True
        return "should not run"

    try:
        convert_pdf_to_bundle(
            source,
            tmp_path / "result.zip",
            source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
            filename="source.pdf",
            profile="fallback-text-v1",
            max_pages=1,
            max_result_bytes=4096,
            engine_version="0.1.6",
            engine_build_id="markitdown-0.1.6-py31213-v3",
            converter=converter,
        )
    except ConversionLimitError:
        pass
    else:
        raise AssertionError("expected the page limit to fail")
    assert called is False


def test_result_limit_does_not_publish_partial_zip(tmp_path: Path) -> None:
    source = tmp_path / "source.pdf"
    output = tmp_path / "result.zip"
    make_pdf(source)

    try:
        convert_pdf_to_bundle(
            source,
            output,
            source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
            filename="source.pdf",
            profile="fallback-text-v1",
            max_pages=1,
            max_result_bytes=8,
            engine_version="0.1.6",
            engine_build_id="markitdown-0.1.6-py31213-v3",
            converter=lambda _handle: "too much Markdown",
        )
    except ConversionLimitError:
        pass
    else:
        raise AssertionError("expected the result limit to fail")
    assert not output.exists()


def test_pinned_markitdown_pptx_converter_preserves_slide_text(tmp_path: Path) -> None:
    from pptx import Presentation

    source = tmp_path / "slides.pptx"
    output = tmp_path / "slides.zip"
    presentation = Presentation()
    slide = presentation.slides.add_slide(presentation.slide_layouts[1])
    slide.shapes.title.text = "课程标题"
    slide.placeholders[1].text = "第一条知识点"
    presentation.save(source)

    manifest = convert_document_to_bundle(
        source,
        output,
        source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        filename=source.name,
        profile="fallback-text-v1",
        max_units=10,
        max_result_bytes=1024 * 1024,
        engine_version="0.1.6",
        engine_build_id="markitdown-0.1.6-py31213-v3",
    )

    with zipfile.ZipFile(output) as archive:
        markdown = archive.read("document.md").decode("utf-8")
    assert manifest["input"]["source_format"] == "pptx"
    assert manifest["input"]["unit_kind"] == "slide"
    assert manifest["input"]["unit_count"] == 1
    assert "课程标题" in markdown
    assert "第一条知识点" in markdown


def test_pinned_markitdown_docx_converter_preserves_word_text(tmp_path: Path) -> None:
    source = tmp_path / "notes.docx"
    with zipfile.ZipFile(source, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr(
            "[Content_Types].xml",
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.'
            'relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" ContentType="application/vnd.'
            "openxmlformats-officedocument.wordprocessingml.document.main+xml\"/></Types>",
        )
        archive.writestr(
            "_rels/.rels",
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/'
            '2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
        )
        archive.writestr(
            "word/document.xml",
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            "<w:body><w:p><w:r><w:t>Word heading</w:t></w:r></w:p>"
            "<w:p><w:r><w:t>Native Word body text.</w:t></w:r></w:p>"
            "</w:body></w:document>",
        )
    output = tmp_path / "result.zip"
    manifest = convert_document_to_bundle(
        source,
        output,
        source_sha256=hashlib.sha256(source.read_bytes()).hexdigest(),
        filename=source.name,
        profile="fallback-text-v1",
        max_units=500,
        max_result_bytes=1024 * 1024,
        engine_version="0.1.6",
        engine_build_id="test-build",
    )
    with zipfile.ZipFile(output) as archive:
        markdown = archive.read("document.md").decode()
    assert "Word heading" in markdown
    assert "Native Word body text." in markdown
    assert manifest["input"] == {
        "size_bytes": source.stat().st_size,
        "source_format": "docx",
        "unit_kind": "document",
        "unit_count": 1,
    }

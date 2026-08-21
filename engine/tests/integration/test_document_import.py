from __future__ import annotations

import json
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import NoReturn, cast

import pytest

from okf_workspace.git import GitCheckpointError, initialize_repository
from okf_workspace.importers.config import ImportSettings
from okf_workspace.importers.models import (
    ImportIntent,
    ImportQuality,
    ImportRequest,
    ParserExport,
    ParserName,
)
from okf_workspace.importers.pipeline import DocumentImporter
from okf_workspace.importers.publish import route_existing_import
from okf_workspace.okf.frontmatter import read_document
from okf_workspace.okf.templates import initialize_vault


class FakeParser:
    def __init__(
        self,
        parser: ParserName,
        export: ParserExport | None = None,
        error: Exception | None = None,
    ) -> None:
        self.parser = parser
        self.export = export
        self.error = error
        self.calls: list[Path] = []

    def convert(
        self,
        source: Path,
        working_directory: Path,
        *,
        timeout_seconds: float = 900.0,
    ) -> ParserExport:
        self.calls.append(source)
        if self.error is not None:
            raise self.error
        assert self.export is not None
        return self.export


def make_pdf(tmp_path: Path) -> Path:
    source = tmp_path / "manual.pdf"
    source.write_bytes(b"%PDF-1.7 deterministic fixture")
    return source


def useful_export(
    parser: ParserName = ParserName.MINERU,
) -> ParserExport:
    return ParserExport(
        markdown=(
            "# VPN 配置手册\n\n"
            "这是一份完整、可阅读、可检索的转换正文，包含配置步骤和排障说明。\n\n"
            "![拓扑图](images/network.png)\n"
        ),
        assets={"images/network.png": b"PNG"},
        parser=parser,
        parser_version="fixture-1",
    )


def test_wiki_import_writes_original_export_source_text_and_reserves_target(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    parser = FakeParser(ParserName.MINERU, useful_export())
    importer = DocumentImporter(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        clients={ParserName.MINERU: parser},
    )

    result = importer.import_document(
        ImportRequest(
            source=make_pdf(tmp_path),
            intent=ImportIntent.WIKI,
            parser=ParserName.MINERU,
        )
    )

    assert result.original.stored_path.is_file()
    assert not result.original.stored_path.is_relative_to(vault)
    assert result.original.stored_path.relative_to(tmp_path / "originals").parts[:2] == (
        "sha256",
        result.original.sha256[:2],
    )
    assert (result.original.stored_path.parent / "manifest.json").is_file()
    assert (result.export_directory / "document.md").is_file()
    assert (result.export_directory / "manifest.json").is_file()
    assert (result.export_directory / "qc-report.json").is_file()
    assert (result.export_directory / "assets/images/network.png").is_file()

    assert result.source is not None
    assert result.source_text is not None
    assert result.routed_target is not None
    source = read_document(result.source)
    extract = read_document(result.source_text)
    assert source.frontmatter["resource"].startswith("okf-original://sha256/")
    assert source.frontmatter["ingested_via"] == "file-import"
    assert "purpose" not in source.frontmatter
    assert "course" not in source.frontmatter
    assert "project" not in source.frontmatter
    assert source.frontmatter["uses"] == [{"purpose": "wiki"}]
    assert extract.frontmatter["parser"] == "mineru"
    assert "/sources/assets/" in extract.body
    assert not result.routed_target.exists()

    status = json.loads(
        (tmp_path / "state/conversions" / result.conversion_id / "status.json").read_text(
            encoding="utf-8"
        )
    )
    assert status["status"] == "imported"


def test_failed_qc_keeps_export_but_does_not_publish_fake_success(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    parser = FakeParser(
        ParserName.MINERU,
        ParserExport(
            markdown="bad",
            assets={},
            parser=ParserName.MINERU,
            parser_version="fixture-1",
        ),
    )
    importer = DocumentImporter(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        clients={ParserName.MINERU: parser},
    )

    with pytest.raises(RuntimeError, match="QC failed"):
        importer.import_document(
            ImportRequest(
                source=make_pdf(tmp_path),
                intent=ImportIntent.WIKI,
                parser=ParserName.MINERU,
            )
        )

    assert list((tmp_path / "state/conversions").glob("*/export/document.md"))
    assert not list((vault / "sources/records/documents").glob("manual-*.md"))


def test_high_quality_import_rejects_truncated_embedded_images(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    parser = FakeParser(
        ParserName.MARKITDOWN,
        ParserExport(
            markdown=(
                "# DOCX\n\n这是一段足够长且可以正常阅读的正文。\n\n"
                "![figure](data:image/jpeg;base64...)\n"
            ),
            assets={},
            parser=ParserName.MARKITDOWN,
            parser_version="fixture-1",
        ),
    )
    importer = DocumentImporter(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        clients={ParserName.MARKITDOWN: parser},
    )

    with pytest.raises(RuntimeError, match="embedded image"):
        importer.import_document(
            ImportRequest(
                source=make_pdf(tmp_path),
                intent=ImportIntent.SOURCE,
                quality=ImportQuality.HIGH,
                parser=ParserName.MARKITDOWN,
            )
        )

    assert not list((vault / "sources/records/documents").glob("*.md"))


def test_default_high_quality_can_record_mineru_to_markitdown_fallback(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    mineru = FakeParser(
        ParserName.MINERU,
        error=RuntimeError("MinerU unavailable"),
    )
    markitdown = FakeParser(
        ParserName.MARKITDOWN,
        useful_export(ParserName.MARKITDOWN),
    )
    importer = DocumentImporter(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        clients={
            ParserName.MINERU: mineru,
            ParserName.MARKITDOWN: markitdown,
        },
    )

    result = importer.import_document(
        ImportRequest(
            source=make_pdf(tmp_path),
            intent=ImportIntent.SOURCE,
        )
    )

    assert result.parser is ParserName.MARKITDOWN
    assert not result.qc.checks["parser_not_degraded"]
    manifest = json.loads((result.export_directory / "manifest.json").read_text(encoding="utf-8"))
    assert manifest["degraded_from"] == "mineru"


def test_default_mineru_uses_managed_ssh_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    parser = FakeParser(ParserName.MINERU, useful_export())
    seen: list[ImportSettings] = []

    @contextmanager
    def fake_managed(settings: ImportSettings) -> Generator[FakeParser]:
        seen.append(settings)
        yield parser

    monkeypatch.setattr(
        "okf_workspace.importers.pipeline.managed_mineru_client",
        fake_managed,
    )
    importer = DocumentImporter(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        settings=ImportSettings(mineru_ssh_host="bjmu-inner"),
    )

    result = importer.import_document(
        ImportRequest(
            source=make_pdf(tmp_path),
            intent=ImportIntent.SOURCE,
            parser=ParserName.MINERU,
        )
    )

    assert result.parser is ParserName.MINERU
    assert seen[0].mineru_ssh_managed is True
    assert seen[0].mineru_ssh_host == "bjmu-inner"
    assert len(parser.calls) == 1


def test_undecided_import_keeps_one_source_until_the_user_routes_it(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    parser = FakeParser(ParserName.MARKITDOWN, useful_export(ParserName.MARKITDOWN))
    importer = DocumentImporter(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        clients={ParserName.MARKITDOWN: parser},
    )

    result = importer.import_document(
        ImportRequest(
            source=make_pdf(tmp_path),
            intent=ImportIntent.LATER,
            parser=ParserName.MARKITDOWN,
        )
    )

    assert result.routed_target is None
    assert result.source is not None
    assert result.source_text is not None
    source = read_document(result.source)
    extract = read_document(result.source_text)
    assert "purpose" not in source.frontmatter
    assert source.frontmatter["uses"] == [{"purpose": "undecided"}]
    assert source.frontmatter["text"].startswith("/sources/text/")
    assert extract.frontmatter["parser"] == "markitdown"
    assert "requested_parser" not in extract.frontmatter

    source_path, extract_path, learning = route_existing_import(
        vault,
        result.source,
        intent=ImportIntent.LEARN,
    )
    assert source_path == result.source
    assert extract_path == result.source_text
    assert learning is not None and not learning.exists()
    assert "purpose" not in read_document(source_path).frontmatter
    assert read_document(source_path).frontmatter["uses"] == [{"purpose": "study"}]


def test_same_document_reused_across_contexts_keeps_source_context_neutral(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    from okf_workspace.notes import NoteService

    notes = NoteService(vault)
    notes.create_course("course-a", "课程 A")
    notes.create_project("project-b", "项目 B")
    parser = FakeParser(ParserName.MARKITDOWN, useful_export(ParserName.MARKITDOWN))
    importer = DocumentImporter(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        clients={ParserName.MARKITDOWN: parser},
    )
    document = make_pdf(tmp_path)

    course_result = importer.import_document(
        ImportRequest(
            source=document,
            intent=ImportIntent.COURSE,
            parser=ParserName.MARKITDOWN,
            course="course-a",
        )
    )
    project_result = importer.import_document(
        ImportRequest(
            source=document,
            intent=ImportIntent.LEARN,
            parser=ParserName.MARKITDOWN,
            project="project-b",
        )
    )

    assert course_result.source == project_result.source
    assert course_result.source_text == project_result.source_text
    source = read_document(cast(Path, project_result.source))
    assert "course" not in source.frontmatter
    assert "project" not in source.frontmatter
    assert "purpose" not in source.frontmatter
    uses = cast(list[dict[str, str]], source.frontmatter["uses"])
    assert {
        "purpose": "study",
        "course": "/learning/courses/course-a/course.md",
    } in uses
    assert {
        "purpose": "study",
        "project": "/projects/project-b/project.md",
    } in uses
    assert course_result.routed_target is not None
    assert "/learning/courses/course-a/guides/" in course_result.routed_target.as_posix()
    assert project_result.routed_target is not None
    assert "/learning/guides/" in project_result.routed_target.as_posix()


def test_git_checkpoint_failure_is_a_warning_after_successful_conversion(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    initialize_repository(vault)
    parser = FakeParser(ParserName.MARKITDOWN, useful_export(ParserName.MARKITDOWN))
    importer = DocumentImporter(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        clients={ParserName.MARKITDOWN: parser},
    )

    def fail_checkpoint(*_args: object, **_kwargs: object) -> NoReturn:
        raise GitCheckpointError("busy")

    monkeypatch.setattr("okf_workspace.importers.pipeline.create_checkpoint", fail_checkpoint)

    result = importer.import_document(
        ImportRequest(
            source=make_pdf(tmp_path),
            intent=ImportIntent.SOURCE,
            parser=ParserName.MARKITDOWN,
        )
    )
    record = importer.store.load(result.conversion_id)
    stages = cast(dict[str, object], record["stages"])
    warnings = cast(list[str], record["warnings"])

    assert record["status"] == "imported"
    assert stages["checkpoint"] == "failed"
    assert "Git 检查点失败" in " ".join(warnings)


def test_retry_resumes_verified_export_without_running_parser_again(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    parser = FakeParser(ParserName.MARKITDOWN, useful_export(ParserName.MARKITDOWN))
    importer = DocumentImporter(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        clients={ParserName.MARKITDOWN: parser},
    )
    from okf_workspace.importers import pipeline as pipeline_module

    real_publish = pipeline_module.publish_import

    def fail_publish(*_args: object, **_kwargs: object) -> NoReturn:
        raise RuntimeError("routing interrupted")

    monkeypatch.setattr(pipeline_module, "publish_import", fail_publish)
    with pytest.raises(RuntimeError, match="routing interrupted"):
        importer.import_document(
            ImportRequest(
                source=make_pdf(tmp_path),
                intent=ImportIntent.SOURCE,
                parser=ParserName.MARKITDOWN,
            )
        )
    conversion = next((tmp_path / "state/conversions").iterdir()).name
    monkeypatch.setattr(pipeline_module, "publish_import", real_publish)

    resumed = importer.retry(conversion)

    assert resumed.status.value == "imported"
    assert len(parser.calls) == 1

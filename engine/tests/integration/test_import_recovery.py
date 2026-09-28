# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path
from typing import cast

import pytest
from fastapi.testclient import TestClient

from okf_workspace.api import LocalTokenStore, create_app
from okf_workspace.config import BrainPaths
from okf_workspace.importers.models import (
    ConversionStatus,
    ImportIntent,
    ImportRequest,
    OriginalRecord,
    ParserExport,
    ParserName,
)
from okf_workspace.importers.pipeline import DocumentImporter
from okf_workspace.importers.publish import PublishedImport
from okf_workspace.importers.worker import DocumentImportWorker
from okf_workspace.okf.file_io import FileWriteConflict
from okf_workspace.okf.frontmatter import read_document, write_document
from okf_workspace.semantic import SemanticOperationService, SemanticOutput, SemanticRequest
from okf_workspace.semantic.worker import SemanticWorker


class FixedRunner:
    def generate(self, request: SemanticRequest) -> SemanticOutput:
        return SemanticOutput("## Result\n\nGenerated fixture content.", request.sources)


class CountingParser:
    def __init__(self, parser: ParserName) -> None:
        self.parser = parser
        self.calls = 0

    def convert(
        self, source: Path, working_directory: Path, *, timeout_seconds: float = 900.0,
    ) -> ParserExport:
        self.calls += 1
        return ParserExport(
            markdown=f"# Document\n\nUseful conversion from {self.parser} with enough text.\n"
            "![Image](images/figure.png)\n",
            assets={"images/figure.png": self.parser.value.encode()},
            parser=self.parser,
            parser_version="test",
        )


def setup_import(
    vault: Path, tmp_path: Path,
) -> tuple[DocumentImporter, ImportRequest, dict[ParserName, CountingParser]]:
    source = tmp_path / "fixture.pdf"
    source.write_bytes(b"%PDF-1.7 synthetic document")
    parsers = {parser: CountingParser(parser) for parser in ParserName}
    importer = DocumentImporter(
        vault=vault, originals=tmp_path / "originals", state=tmp_path / "state",
        clients=parsers,
    )
    return importer, ImportRequest(
        source=source, intent=ImportIntent.SOURCE, parser=ParserName.MARKITDOWN,
    ), parsers


def test_reimport_only_merges_uses_and_preserves_text_and_assets(
    vault: Path, tmp_path: Path,
) -> None:
    importer, request, _ = setup_import(vault, tmp_path)
    first = importer.import_document(request)
    assert first.source_text is not None
    document = read_document(first.source_text)
    document.body += "\nHuman correction must survive.\n"
    document.frontmatter["custom_extension"] = "keep"
    write_document(first.source_text, document)
    before = first.source_text.read_bytes()
    assets = {path: path.read_bytes() for path in (vault / "sources/assets").rglob("*.png")}

    second = importer.import_document(replace(request, intent=ImportIntent.LEARN,
                                              parser=ParserName.MINERU))

    assert second.source_text == first.source_text
    assert first.source_text.read_bytes() == before
    assert {path: path.read_bytes() for path in assets} == assets
    assert second.source is not None
    assert read_document(second.source).frontmatter["uses"] == [
        {"purpose": "reference"}, {"purpose": "study"},
    ]


def test_explicit_reparse_preserves_human_edits_and_reports_conflict(
    vault: Path, tmp_path: Path,
) -> None:
    importer, request, parsers = setup_import(vault, tmp_path)
    first = importer.import_document(request)
    assert first.source_text is not None
    document = read_document(first.source_text)
    document.body += "\nHuman correction.\n"
    write_document(first.source_text, document)
    before = first.source_text.read_bytes()
    with pytest.raises(FileWriteConflict):
        importer.retry(first.conversion_id, parser=ParserName.MINERU)
    assert parsers[ParserName.MINERU].calls == 1
    assert first.source_text.read_bytes() == before
    assert (first.export_directory / "document.md").is_file()


def test_queued_parser_change_replaces_only_an_unchanged_publication(
    vault: Path, tmp_path: Path,
) -> None:
    importer, request, parsers = setup_import(vault, tmp_path)
    first = importer.import_document(request)
    importer.store.queue_retry(first.conversion_id, parser=ParserName.MINERU)
    assert DocumentImportWorker(importer).run_once()
    record = importer.store.load(first.conversion_id)
    assert record["status"] == "imported"
    assert record["parser"] == "mineru"
    assert parsers[ParserName.MINERU].calls == 1
    assert first.source_text is not None
    assert read_document(first.source_text).frontmatter["parser"] == "mineru"


def test_ready_conversion_recovers_using_export_without_reconversion(
    vault: Path, tmp_path: Path,
) -> None:
    importer, request, parsers = setup_import(vault, tmp_path)
    first = importer.import_document(request)
    importer.store.transition(first.conversion_id, ConversionStatus.READY)
    worker = DocumentImportWorker(importer)
    assert worker.reconcile() == 1
    assert worker.run_once()
    assert importer.store.load(first.conversion_id)["status"] == "imported"
    assert parsers[ParserName.MARKITDOWN].calls == 1


def test_wiki_intent_is_generated_by_the_production_worker(vault: Path, tmp_path: Path) -> None:
    importer, request, _ = setup_import(vault, tmp_path)
    service = SemanticOperationService(vault, tmp_path / "state")
    queued = importer.enqueue(replace(request, intent=ImportIntent.WIKI))
    assert DocumentImportWorker(importer, semantic_service=service).run_once()
    operations = service.store.list()
    assert len(operations) == 1
    assert operations[0]["kind"] == "generate-wiki"
    assert importer.store.load(str(queued["conversion_id"]))["error"] is None


def test_semantic_enqueue_failure_is_visible_and_recovers_without_conversion(
    vault: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    importer, request, parsers = setup_import(vault, tmp_path)
    service = SemanticOperationService(vault, tmp_path / "state")
    queued = importer.enqueue(replace(request, intent=ImportIntent.LEARN, generate=True))
    identifier = str(queued["conversion_id"])

    def unavailable(*args: object, **kwargs: object) -> dict[str, object]:
        raise TimeoutError("queue busy")

    with monkeypatch.context() as scoped:
        scoped.setattr(service, "enqueue", unavailable)
        assert DocumentImportWorker(importer, semantic_service=service).run_once()
    failed = importer.store.load(identifier)
    assert failed["error"] == "queue busy"
    assert failed["stages"] == {
        "upload": "completed", "conversion": "completed", "quality": "passed",
        "routing": "completed", "checkpoint": "disabled", "semantic": "failed",
    }
    assert not DocumentImportWorker(importer, semantic_service=service).run_once()
    importer.store.queue_retry(identifier)
    assert DocumentImportWorker(importer, semantic_service=service).run_once()
    assert len(service.store.list()) == 1
    assert parsers[ParserName.MARKITDOWN].calls == 1
    assert importer.store.load(identifier)["error"] is None


def test_restart_after_import_before_enqueue_completes_handoff(
    vault: Path, tmp_path: Path,
) -> None:
    importer, request, parsers = setup_import(vault, tmp_path)
    first = importer.import_document(replace(request, intent=ImportIntent.LEARN, generate=True))
    service = SemanticOperationService(vault, tmp_path / "state")
    assert DocumentImportWorker(importer, semantic_service=service).run_once()
    assert len(service.store.list()) == 1
    assert importer.store.load(first.conversion_id)["error"] is None
    assert parsers[ParserName.MARKITDOWN].calls == 1


def test_completed_generation_is_not_duplicated_after_lost_conversion_receipt(
    vault: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    importer, request, parsers = setup_import(vault, tmp_path)
    first = importer.import_document(replace(request, intent=ImportIntent.LEARN, generate=True))
    service = SemanticOperationService(vault, tmp_path / "state")
    real_transition = importer.store.transition

    def fail_receipt(
        identifier: str, status: ConversionStatus, **kwargs: object,
    ) -> dict[str, object]:
        outputs = kwargs.get("outputs")
        if isinstance(outputs, dict) and "semantic_operation_id" in outputs:
            raise OSError("interrupted before receipt")
        return real_transition(identifier, status, error=str(kwargs.get("error")),
                               stages=cast(Mapping[str, str], kwargs.get("stages")))

    with monkeypatch.context() as scoped:
        scoped.setattr(importer.store, "transition", fail_receipt)
        assert DocumentImportWorker(importer, semantic_service=service).run_once()
    assert SemanticWorker(vault, tmp_path / "state", FixedRunner()).run_once()
    importer.store.queue_retry(first.conversion_id)
    assert DocumentImportWorker(importer, semantic_service=service).run_once()
    assert len(service.store.list()) == 1
    assert service.store.list()[0]["status"] == "completed"
    assert parsers[ParserName.MARKITDOWN].calls == 1


def test_production_upload_queue_generates_wiki_end_to_end(vault: Path, tmp_path: Path) -> None:
    importer, request, parsers = setup_import(vault, tmp_path)
    paths = BrainPaths(vault, tmp_path / "originals", tmp_path / "state")
    client = TestClient(create_app(paths, semantic_enabled=True, semantic_runner=FixedRunner()))
    response = client.post(
        "/documents/import",
        headers={"Authorization": f"Bearer {LocalTokenStore(paths.state).ensure()}"},
        data={"intent": "wiki", "parser": "markitdown", "generate": "true"},
        files={"file": ("fixture.pdf", request.source.read_bytes(), "application/pdf")},
    )
    assert response.status_code == 200
    payload = cast(dict[str, object], response.json())
    assert payload["status"] == "queued"
    service = SemanticOperationService(vault, paths.state)
    assert DocumentImportWorker(importer, semantic_service=service).run_once()
    assert SemanticWorker(vault, paths.state, FixedRunner()).run_once()
    operation = service.store.list()[0]
    assert operation["status"] == "completed"
    assert read_document(vault / str(operation["target"])).type == "Wiki"
    assert parsers[ParserName.MARKITDOWN].calls == 1


def test_reparse_recovers_after_note_publish_before_status_write(
    vault: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    importer, request, parsers = setup_import(vault, tmp_path)
    first = importer.import_document(request)
    from okf_workspace.importers import pipeline as pipeline_module

    real_publish = pipeline_module.publish_import

    def publish_then_stop(
        vault: Path, request: ImportRequest, original: OriginalRecord, export: ParserExport,
        *, replace_existing: bool = False, expected_text_sha256: str | None = None,
    ) -> PublishedImport:
        real_publish(vault, request, original, export, replace_existing=replace_existing,
                     expected_text_sha256=expected_text_sha256)
        raise RuntimeError("stopped after publication")

    with monkeypatch.context() as scoped:
        scoped.setattr(pipeline_module, "publish_import", publish_then_stop)
        with pytest.raises(RuntimeError, match="stopped after publication"):
            importer.retry(first.conversion_id, parser=ParserName.MINERU)
    importer.store.queue_retry(first.conversion_id)
    assert DocumentImportWorker(importer).run_once()
    assert importer.store.load(first.conversion_id)["status"] == "imported"
    assert parsers[ParserName.MINERU].calls == 1

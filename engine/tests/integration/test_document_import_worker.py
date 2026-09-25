from __future__ import annotations

from pathlib import Path

from okf_workspace.importers.models import (
    ConversionStatus,
    ImportIntent,
    ImportRequest,
    ParserExport,
    ParserName,
)
from okf_workspace.importers.pipeline import DocumentImporter
from okf_workspace.importers.worker import DocumentImportWorker
from okf_workspace.okf.templates import initialize_vault


class WorkerParser:
    parser = ParserName.MINERU

    def __init__(
        self,
        error: Exception | None = None,
        *,
        parser: ParserName = ParserName.MINERU,
    ) -> None:
        self.error = error
        self.parser = parser

    def convert(
        self,
        source: Path,
        working_directory: Path,
        *,
        timeout_seconds: float = 900.0,
    ) -> ParserExport:
        del source, working_directory, timeout_seconds
        if self.error is not None:
            raise self.error
        return ParserExport(
            markdown="# 后台转换\n\n这是完整且足够长的后台转换正文，用于验证队列不会阻塞上传请求。",
            assets={},
            parser=self.parser,
            parser_version="worker-test",
        )


def _request(tmp_path: Path) -> ImportRequest:
    source = tmp_path / "queued.pdf"
    source.write_bytes(b"%PDF-1.7 queued")
    return ImportRequest(
        source=source,
        intent=ImportIntent.SOURCE,
        parser=ParserName.MINERU,
    )


def test_document_worker_completes_a_durable_queued_import(tmp_path: Path) -> None:
    importer = DocumentImporter(
        vault=initialize_vault(tmp_path / "vault"),
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        clients={ParserName.MINERU: WorkerParser()},
    )
    queued = importer.enqueue(_request(tmp_path))

    assert queued["status"] == ConversionStatus.QUEUED.value
    assert DocumentImportWorker(importer).run_once() is True
    completed = importer.store.load(str(queued["conversion_id"]))
    assert completed["status"] == ConversionStatus.IMPORTED.value
    assert completed["attempt"] == 1


def test_required_mineru_waits_after_a_transient_failure(tmp_path: Path) -> None:
    importer = DocumentImporter(
        vault=initialize_vault(tmp_path / "vault"),
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        clients={ParserName.MINERU: WorkerParser(RuntimeError("MinerU unavailable"))},
    )
    queued = importer.enqueue(_request(tmp_path))

    assert DocumentImportWorker(importer, retry_seconds=30).run_once() is True
    waiting = importer.store.load(str(queued["conversion_id"]))
    assert waiting["status"] == ConversionStatus.WAITING_FOR_MINERU.value
    assert waiting["next_retry_at"]


def test_legacy_office_normalization_failure_stops_worker_retry_loop(tmp_path: Path) -> None:
    class BrokenOfficeConverter:
        def convert(self, source: Path, destination: Path) -> Path:
            del source, destination
            raise RuntimeError("Office COM unavailable")

    source = tmp_path / "legacy.doc"
    source.write_bytes(b"legacy document")
    importer = DocumentImporter(
        vault=initialize_vault(tmp_path / "vault"),
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        doc_converter=BrokenOfficeConverter(),
    )
    queued = importer.enqueue(ImportRequest(source=source, intent=ImportIntent.SOURCE))
    worker = DocumentImportWorker(importer)

    assert worker.run_once() is True
    record = importer.store.load(str(queued["conversion_id"]))
    assert record["status"] == ConversionStatus.FAILED.value
    assert record["error"] == "Office COM unavailable"
    assert worker.run_once() is False


def test_switching_parser_retries_the_same_job_without_leaving_old_queue(
    tmp_path: Path,
) -> None:
    importer = DocumentImporter(
        vault=initialize_vault(tmp_path / "vault"),
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        clients={
            ParserName.MINERU: WorkerParser(RuntimeError("MinerU unavailable")),
            ParserName.MARKITDOWN: WorkerParser(parser=ParserName.MARKITDOWN),
        },
    )
    queued = importer.enqueue(_request(tmp_path))
    identifier = str(queued["conversion_id"])

    retried = importer.store.queue_retry(identifier, parser=ParserName.MARKITDOWN)
    assert retried["conversion_id"] == identifier
    assert DocumentImportWorker(importer).run_once() is True

    records = importer.store.list()
    assert len(records) == 1
    assert records[0]["conversion_id"] == identifier
    assert records[0]["status"] == ConversionStatus.IMPORTED.value
    assert records[0]["parser"] == ParserName.MARKITDOWN.value

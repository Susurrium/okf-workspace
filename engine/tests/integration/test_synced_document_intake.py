from __future__ import annotations

import hashlib
import shutil
import threading
import time
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from okf_workspace.api import create_app
from okf_workspace.cli import main
from okf_workspace.config import BrainPaths
from okf_workspace.importers.models import ParserExport, ParserName
from okf_workspace.importers.pipeline import DocumentImporter
from okf_workspace.importers.synced_intake import SyncedDocumentIntake
from okf_workspace.importers.worker import DocumentImportWorker
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.okf.validator import validate_bundle
from okf_workspace.retrieval.scanner import is_retrievable_markdown
from okf_workspace.semantic.service import SemanticOperationService


class FixtureParser:
    parser = ParserName.MINERU

    def convert(
        self, source: Path, working_directory: Path, *, timeout_seconds: float = 900.0,
    ) -> ParserExport:
        del source, working_directory, timeout_seconds
        return ParserExport(
            markdown="# 手机资料\n\n这是足够完整的资料正文，验证离线收集、文件同步和电脑后台转换。",
            assets={}, parser=self.parser, parser_version="synced-intake-fixture",
        )


@pytest.fixture
def importer(tmp_path: Path) -> DocumentImporter:
    return DocumentImporter(
        vault=initialize_vault(tmp_path / "desktop"),
        originals=tmp_path / "originals", state=tmp_path / "state",
        clients={ParserName.MINERU: FixtureParser()},
    )


def submit(vault: Path, *, contents: bytes = b"%PDF-1.7 synced fixture") -> Path:
    identifier = str(uuid.uuid4())
    directory = vault / "inbox" / "uploads" / identifier
    directory.mkdir(parents=True)
    (directory / "lecture.pdf").write_bytes(contents)
    request = directory / "request.md"
    write_document(request, OkfDocument({
        "type": "Document Import Request", "title": "lecture.pdf",
        "created_at": "2026-10-04T10:00:00+08:00", "request_id": identifier,
        "file": "/" + (directory / "lecture.pdf").relative_to(vault).as_posix(),
        "filename": "lecture.pdf", "file_sha256": hashlib.sha256(contents).hexdigest(),
        "size_bytes": len(contents), "intent": "source", "quality": "quick",
        "method": "auto", "generate": False,
    }, "# lecture.pdf\n\n来自手机的明确导入选择。"))
    return request


def test_offline_mobile_submission_replicates_then_converts_and_returns_receipt(
    importer: DocumentImporter, tmp_path: Path,
) -> None:
    mobile = initialize_vault(tmp_path / "mobile")
    original_request = submit(mobile)
    desktop_directory = importer.vault / original_request.parent.relative_to(mobile)
    desktop_directory.mkdir(parents=True)
    request = desktop_directory / "request.md"
    shutil.copyfile(original_request, request)  # Application metadata arrives first.
    intake = SyncedDocumentIntake(importer)
    assert intake.scan() == 0
    assert read_document(request.with_name("receipt.md")).frontmatter[
        "processing_status"
    ] == "waiting-for-file"
    shutil.copyfile(original_request.with_name("lecture.pdf"), request.with_name("lecture.pdf"))
    assert intake.scan() == 1
    queued = read_document(request.with_name("receipt.md"))
    assert queued.frontmatter["processing_status"] == "queued"
    assert DocumentImportWorker(importer).run_once()
    # Recreate receiver after desktop restart; the request is not requeued.
    assert SyncedDocumentIntake(importer).scan() == 0
    receipt = read_document(request.with_name("receipt.md"))
    assert receipt.frontmatter["processing_status"] == "imported"
    assert receipt.frontmatter["conversion_id"] == queued.frontmatter["conversion_id"]
    outputs = receipt.frontmatter["outputs"]
    assert (importer.vault / outputs["source_text"]).is_file()
    assert len(importer.store.list()) == 1
    assert request.with_name("lecture.pdf").is_file()
    assert list(importer.original_store.root.rglob("lecture.pdf"))
    assert validate_bundle(importer.vault).valid
    assert not is_retrievable_markdown(request, importer.vault)
    # Returning results uses ordinary Vault files, with no mobile Engine access.
    shutil.copyfile(request.with_name("receipt.md"), original_request.with_name("receipt.md"))
    target = mobile / outputs["source_text"]
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(importer.vault / outputs["source_text"], target)
    assert "手机资料" in target.read_text(encoding="utf-8")


def store_request(importer: DocumentImporter) -> Path:
    request = submit(importer.vault)
    document = read_document(request)
    for field in ("quality", "method", "generate"):
        document.frontmatter.pop(field)
    document.frontmatter.update(action="store", request_version=4)
    write_document(request, document)
    return request


def test_cli_store_original_without_converter(importer: DocumentImporter) -> None:
    path = submit(importer.vault).with_name("lecture.pdf")
    assert main([
        "import", str(path), "--action", "store", "--intent", "source",
        "--vault", str(importer.vault), "--state", str(importer.state_root),
        "--originals", str(importer.legacy_originals),
    ]) == 0
    assert not importer.store.list()
    assert len(list((importer.vault / "sources/records/documents").glob("*.md"))) == 1


def test_store_only_survives_restart_without_parser_or_conversion(
    importer: DocumentImporter, monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = store_request(importer)

    def forbidden(*_args: object, **_kwargs: object) -> None:
        pytest.fail("store-only must not resolve a converter or enqueue a conversion")

    monkeypatch.setattr(importer, "resolve_method", forbidden)
    monkeypatch.setattr(importer, "enqueue", forbidden)
    intake = SyncedDocumentIntake(importer)
    assert intake.scan() == 1
    receipt = read_document(request.with_name("receipt.md"))
    assert receipt.frontmatter["processing_status"] == "stored"
    assert "conversion_id" not in receipt.frontmatter
    source = importer.vault / receipt.frontmatter["outputs"]["source"]
    assert "text" not in read_document(source).frontmatter
    assert not list((importer.vault / "sources/text").rglob("*.md"))
    assert not importer.store.list()
    assert SyncedDocumentIntake(importer).scan() == 0
    assert not DocumentImportWorker(importer).run_once()
    assert validate_bundle(importer.vault).valid
    for binding in intake.bindings.glob("*.json"):
        binding.unlink()
    assert SyncedDocumentIntake(importer).scan() == 1
    assert len(list((importer.vault / "sources/records/documents").glob("*.md"))) == 1
    assert not importer.store.list()


def test_saved_original_converts_only_after_explicit_request_and_preserves_notes(
    importer: DocumentImporter,
) -> None:
    request = store_request(importer)
    intake = SyncedDocumentIntake(importer)
    assert intake.scan() == 1
    receipt = read_document(request.with_name("receipt.md"))
    source = importer.vault / receipt.frontmatter["outputs"]["source"]
    document = read_document(source)
    document.frontmatter["personal_label"] = "keep"
    document.body += "\nMy handwritten notes.\n"
    write_document(source, document)
    conversion = submit(importer.vault)
    assert intake.scan() == 1
    assert DocumentImportWorker(importer).run_once()
    intake.scan()
    result = read_document(conversion.with_name("receipt.md")).frontmatter
    assert result["processing_status"] == "imported"
    assert result["outputs"]["source"] == source.relative_to(importer.vault).as_posix()
    assert "My handwritten notes." in source.read_text(encoding="utf-8")
    assert read_document(source).frontmatter["personal_label"] == "keep"
    text = importer.vault / result["outputs"]["source_text"]
    assert result["outputs"]["source_text"] in read_document(source).body
    before = text.read_bytes()
    store_request(importer)
    intake.scan()
    assert text.read_bytes() == before
    assert len(importer.store.list()) == 1
    assert validate_bundle(importer.vault).valid


def test_generation_reuses_text_and_explicit_retry_retries_only_generation(
    importer: DocumentImporter, monkeypatch: pytest.MonkeyPatch,
) -> None:
    submit(importer.vault)
    intake = SyncedDocumentIntake(importer)
    intake.scan()
    assert DocumentImportWorker(importer).run_once()

    def forbidden(*_args: object, **_kwargs: object) -> None:
        pytest.fail("generation from existing text must not run a parser")

    monkeypatch.setattr(FixtureParser, "convert", forbidden)
    monkeypatch.setattr(importer, "resolve_method", forbidden)
    service = SemanticOperationService(importer.vault, importer.state_root)
    intake = SyncedDocumentIntake(importer, semantic_service=service)

    def generate_request() -> Path:
        path = submit(importer.vault)
        document = read_document(path)
        document.frontmatter.update(
            action="convert", request_version=4, intent="learn", generate=True,
        )
        write_document(path, document)
        return path

    request = generate_request()
    assert intake.scan() == 1
    result = read_document(request.with_name("receipt.md")).frontmatter
    assert result["processing_status"] == "imported"
    worker = DocumentImportWorker(importer, semantic_service=service)
    operation = worker.enqueue_semantic(result["conversion_id"])
    assert operation is not None
    operation_id = str(operation["operation_id"])
    service.store.fail(operation_id, "fixture generation failure")
    assert intake.scan() == 0
    assert service.store.load(operation_id)["status"] == "failed"
    retried_request = generate_request()
    assert intake.scan() == 1, read_document(retried_request.with_name("receipt.md")).frontmatter
    assert service.store.load(operation_id)["status"] == "queued"
    assert len(importer.store.list()) == 2


@pytest.mark.parametrize("extra", [
    {"generate": True}, {"method": "auto"}, {"intent": "wiki"},
    {"action": "unknown"}, {"request_version": 5}, {"action": None},
])
def test_invalid_new_request_never_falls_back_to_conversion(
    importer: DocumentImporter, extra: dict[str, object],
) -> None:
    request = store_request(importer)
    document = read_document(request)
    document.frontmatter.update(extra)
    write_document(request, document)
    assert SyncedDocumentIntake(importer).scan() == 0
    assert not importer.store.list()
    assert read_document(request.with_name("receipt.md")).frontmatter[
        "processing_status"
    ] == "failed"


def test_complete_size_with_wrong_hash_waits_for_correct_replication(
    importer: DocumentImporter,
) -> None:
    request = submit(importer.vault)
    file = request.with_name("lecture.pdf")
    contents = file.read_bytes()
    file.write_bytes(b"x" * len(contents))
    intake = SyncedDocumentIntake(importer)
    assert intake.scan() == 0
    assert not importer.store.list()
    assert read_document(request.with_name("receipt.md")).frontmatter[
        "processing_status"
    ] == "waiting-for-file"
    file.write_bytes(contents)
    assert intake.scan() == 1


def test_duplicate_scan_and_lost_binding_reuse_existing_conversion(
    importer: DocumentImporter,
) -> None:
    request = submit(importer.vault)
    intake = SyncedDocumentIntake(importer)
    assert intake.scan() == 1
    assert intake.scan() == 0
    for binding in intake.bindings.glob("*.json"):
        binding.unlink()
    request.with_name("receipt.md").unlink()
    assert SyncedDocumentIntake(importer).scan() == 1
    assert len(importer.store.list()) == 1
    assert DocumentImportWorker(importer).run_once()
    assert not DocumentImportWorker(importer).run_once()


def test_same_filename_different_contents_are_independent(importer: DocumentImporter) -> None:
    submit(importer.vault, contents=b"%PDF-1.7 first")
    submit(importer.vault, contents=b"%PDF-1.7 second")
    assert SyncedDocumentIntake(importer).scan() == 2
    assert len(importer.store.list()) == 2


def test_api_lifespan_receives_existing_input_and_stops_receiver(
    importer: DocumentImporter, monkeypatch: pytest.MonkeyPatch,
) -> None:
    request = submit(importer.vault)

    def configured_importer(**_kwargs: object) -> DocumentImporter:
        return importer

    monkeypatch.setattr("okf_workspace.api.app.DocumentImporter", configured_importer)
    paths = BrainPaths(
        vault=importer.vault, originals=importer.original_store.root, state=importer.state_root,
    )
    with TestClient(create_app(paths, semantic_enabled=False)):
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            receipt = request.with_name("receipt.md")
            if receipt.is_file() and read_document(receipt).frontmatter[
                "processing_status"
            ] == "imported":
                break
            time.sleep(0.05)
        else:
            pytest.fail("API did not receive and process the existing synced input")
    assert not any(
        thread.name == "okf-synced-document-intake" for thread in threading.enumerate()
    )


def test_receipt_refresh_preserves_user_notes_and_unknown_fields(
    importer: DocumentImporter,
) -> None:
    request = submit(importer.vault)
    intake = SyncedDocumentIntake(importer)
    assert intake.scan() == 1
    receipt_path = request.with_name("receipt.md")
    receipt = read_document(receipt_path)
    receipt.frontmatter["personal_label"] = "保留我的批注"
    receipt.body += "\n\n## 我的记录\n\n请保留这段人工记录。\n"
    write_document(receipt_path, receipt)
    assert DocumentImportWorker(importer).run_once()
    assert intake.scan() == 0
    refreshed = read_document(receipt_path)
    assert refreshed.frontmatter["processing_status"] == "imported"
    assert refreshed.frontmatter["personal_label"] == "保留我的批注"
    assert "请保留这段人工记录。" in refreshed.body


def test_received_original_survives_removed_sync_attachment(importer: DocumentImporter) -> None:
    request = submit(importer.vault)
    intake = SyncedDocumentIntake(importer)
    assert intake.scan() == 1
    request.with_name("lecture.pdf").unlink()
    assert DocumentImportWorker(importer).run_once()
    assert intake.scan() == 0
    assert read_document(request.with_name("receipt.md")).frontmatter[
        "processing_status"
    ] == "imported"


def test_retired_cleanup_cannot_delete_vault_attachments(importer: DocumentImporter) -> None:
    from okf_workspace.importers.upload_cleanup import cleanup_uploads

    request = submit(importer.vault)
    before = request.read_bytes()
    with pytest.raises(ValueError, match="全量同步"):
        cleanup_uploads(importer, apply=True)
    assert request.read_bytes() == before
    assert request.with_name("lecture.pdf").is_file()


def test_new_inputs_and_progress_do_not_wait_for_a_slow_conversion(
    importer: DocumentImporter, monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = submit(importer.vault)
    intake = SyncedDocumentIntake(importer)
    assert intake.scan() == 1
    entered = threading.Event()
    release = threading.Event()
    original = FixtureParser.convert

    def slow_convert(
        self: FixtureParser, source: Path, working_directory: Path,
        *, timeout_seconds: float = 900.0,
    ) -> ParserExport:
        entered.set()
        assert release.wait(timeout=10)
        return original(self, source, working_directory, timeout_seconds=timeout_seconds)

    monkeypatch.setattr(FixtureParser, "convert", slow_convert)
    worker = threading.Thread(target=DocumentImportWorker(importer).run_once)
    worker.start()
    try:
        assert entered.wait(timeout=5)
        submit(importer.vault, contents=b"%PDF-1.7 second while converting")
        assert intake.scan() == 1
        assert read_document(first.with_name("receipt.md")).frontmatter[
            "processing_status"
        ] == "converting"
        assert len(importer.store.list()) == 2
    finally:
        release.set()
        worker.join(timeout=10)


@pytest.mark.parametrize("value", ["/../../private.pdf", "/self/profile.md"])
def test_request_cannot_import_unrelated_local_files(
    importer: DocumentImporter, value: str,
) -> None:
    request = submit(importer.vault)
    document = read_document(request)
    document.frontmatter["file"] = value
    write_document(request, document)
    assert SyncedDocumentIntake(importer).scan() == 0
    assert not importer.store.list()
    assert read_document(request.with_name("receipt.md")).frontmatter[
        "processing_status"
    ] == "failed"


def test_missing_context_is_retried_after_context_sync(importer: DocumentImporter) -> None:
    request = submit(importer.vault)
    document = read_document(request)
    document.frontmatter["course"] = "/learning/courses/mobile/course.md"
    write_document(request, document)
    intake = SyncedDocumentIntake(importer)
    assert intake.scan() == 0
    assert read_document(request.with_name("receipt.md")).frontmatter[
        "processing_status"
    ] == "waiting-for-file"
    from okf_workspace.notes import NoteService

    NoteService(importer.vault).create_course("mobile", "手机课程")
    assert intake.scan() == 1

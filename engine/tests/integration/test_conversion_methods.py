from __future__ import annotations

import json
from collections.abc import Generator
from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
from dataclasses import replace
from pathlib import Path
from threading import Event
from typing import Any, cast

import httpx
import pytest
from fastapi.testclient import TestClient

from okf_workspace.api import create_app
from okf_workspace.api.auth import LocalTokenStore
from okf_workspace.config import BrainPaths, apply_deployment_config
from okf_workspace.importers.clients import RetryableConversionError
from okf_workspace.importers.config import ImportSettings
from okf_workspace.importers.methods import method_catalogue
from okf_workspace.importers.models import (
    ConversionMethod,
    ImportIntent,
    ImportQuality,
    ImportRequest,
    ParserExport,
    ParserName,
)
from okf_workspace.importers.pipeline import DocumentImporter
from okf_workspace.importers.routing import choose_method
from okf_workspace.importers.state import ConversionBusyError
from okf_workspace.importers.worker import DocumentImportWorker
from okf_workspace.okf.file_io import FileWriteConflict
from okf_workspace.okf.frontmatter import read_document
from okf_workspace.okf.templates import initialize_vault


class CountingParser:
    def __init__(self, parser: ParserName) -> None:
        self.parser = parser
        self.calls = 0
        self.error: Exception | None = None
        self.markdown = "# Document\n\nUseful complete text for a document conversion.\n"

    def convert(
        self, source: Path, working_directory: Path, *, timeout_seconds: float = 900.0
    ) -> ParserExport:
        self.calls += 1
        if self.error:
            raise self.error
        return ParserExport(
            self.markdown, {}, self.parser, "test", warnings=("fixture quality warning",)
        )


def setup(
    tmp_path: Path,
) -> tuple[DocumentImporter, ImportRequest, dict[ConversionMethod, CountingParser]]:
    source = tmp_path / "document.pdf"
    source.write_bytes(b"%PDF synthetic")
    clients = {method: CountingParser(method.parser) for method in ConversionMethod}
    importer = DocumentImporter(
        vault=initialize_vault(tmp_path / "vault"),
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        method_clients=clients,
    )
    return importer, ImportRequest(source=source, intent=ImportIntent.SOURCE), clients


@pytest.mark.parametrize("method", list(ConversionMethod))
@pytest.mark.parametrize("quality", list(ImportQuality))
def test_selected_method_is_independent_of_quality(
    tmp_path: Path, method: ConversionMethod, quality: ImportQuality
) -> None:
    importer, request, clients = setup(tmp_path)
    result = importer.import_document(replace(request, method=method, quality=quality))
    record = cast(dict[str, Any], importer.store.load(result.conversion_id))
    assert record["method"] == method.value
    assert record["warnings"] == ["fixture quality warning"]
    assert sum(client.calls for client in clients.values()) == 1
    assert clients[method].calls == 1
    assert record["parser_attempts"][0]["method"] == method.value
    assert result.source_text is not None
    assert read_document(result.source_text).frontmatter["parser"] == method.parser.value


def test_queue_freezes_default_and_explicit_reparse_uses_other_mineru(tmp_path: Path) -> None:
    importer, request, clients = setup(tmp_path)
    queued = importer.enqueue(request)
    identifier = str(queued["conversion_id"])
    importer.settings = replace(
        importer.settings, default_conversion_method=ConversionMethod.MARKITDOWN_SERVICE
    )
    worker = DocumentImportWorker(importer)
    assert worker.run_once()
    assert clients[ConversionMethod.MINERU_CLOUD].calls == 1
    reused = importer.enqueue(replace(request, method=ConversionMethod.MINERU_SELF_HOSTED))
    assert reused["reused_existing"] is True
    assert clients[ConversionMethod.MINERU_SELF_HOSTED].calls == 0
    importer.queue_retry(identifier, method=ConversionMethod.MINERU_SELF_HOSTED)
    assert worker.run_once()
    assert clients[ConversionMethod.MINERU_SELF_HOSTED].calls == 1
    assert len(importer.store.list()) == 1
    record = cast(dict[str, Any], importer.store.load(identifier))
    assert record["method"] == "mineru-self-hosted"
    manifest = json.loads((Path(record["outputs"]["export"]) / "manifest.json").read_text())
    assert manifest["method"] == "mineru-self-hosted"


def test_markitdown_transient_failure_waits_and_can_switch(tmp_path: Path) -> None:
    importer, request, clients = setup(tmp_path)
    clients[ConversionMethod.MARKITDOWN_SERVICE].error = RetryableConversionError("busy")
    record = importer.enqueue(replace(request, method=ConversionMethod.MARKITDOWN_SERVICE))
    worker = DocumentImportWorker(importer)
    assert worker.run_once()
    identifier = str(record["conversion_id"])
    assert importer.store.load(identifier)["status"] == "waiting-for-parser"
    importer.queue_retry(identifier, method=ConversionMethod.MINERU_CLOUD)
    assert worker.run_once()
    assert importer.store.load(identifier)["status"] == "imported"


@pytest.mark.parametrize("transient_failure", [False, True])
def test_legacy_queue_keeps_parser_when_default_changes(
    tmp_path: Path,
    transient_failure: bool,
) -> None:
    importer, request, clients = setup(tmp_path)
    queued = importer.enqueue(replace(request, method=ConversionMethod.MARKITDOWN_SERVICE))
    identifier = str(queued["conversion_id"])
    queued.pop("method")
    importer.store.record_path(identifier).write_text(json.dumps(queued), encoding="utf-8")
    importer.settings = replace(
        importer.settings, default_conversion_method=ConversionMethod.MINERU_CLOUD
    )
    if transient_failure:
        clients[ConversionMethod.MARKITDOWN_SERVICE].error = RetryableConversionError("busy")
    assert DocumentImportWorker(importer).run_once()
    assert clients[ConversionMethod.MARKITDOWN_SERVICE].calls == 1
    assert clients[ConversionMethod.MINERU_CLOUD].calls == 0
    assert importer.store.load(identifier)["status"] == (
        "waiting-for-parser" if transient_failure else "imported"
    )


@pytest.mark.parametrize("managed", [False, True])
@pytest.mark.parametrize("transient_failure", [False, True])
def test_self_hosted_factory_uses_selected_lifecycle_and_retries_connection_errors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    managed: bool,
    transient_failure: bool,
) -> None:
    importer, request, clients = setup(tmp_path)
    parser = clients[ConversionMethod.MINERU_SELF_HOSTED]
    importer.method_clients.pop(ConversionMethod.MINERU_SELF_HOSTED)
    importer.settings = replace(
        importer.settings,
        mineru_self_hosted_enabled=True,
        mineru_ssh_managed=managed,
        mineru_url="http://127.0.0.1:18999",
    )
    events: list[str] = []

    def direct_factory(url: str) -> CountingParser:
        events.append(url)
        return parser

    @contextmanager
    def managed_factory(settings: ImportSettings) -> Generator[CountingParser]:
        events.append(settings.mineru_url)
        try:
            yield parser
        finally:
            events.append("released")

    monkeypatch.setattr("okf_workspace.importers.pipeline.MinerUClient", direct_factory)
    monkeypatch.setattr("okf_workspace.importers.pipeline.managed_mineru_client", managed_factory)
    if transient_failure:
        parser.error = httpx.ConnectError("offline")
    queued = importer.enqueue(replace(request, method=ConversionMethod.MINERU_SELF_HOSTED))
    assert not events
    assert DocumentImportWorker(importer).run_once()
    assert events == ["http://127.0.0.1:18999"] + (["released"] if managed else [])
    assert clients[ConversionMethod.MINERU_CLOUD].calls == 0
    assert importer.store.load(str(queued["conversion_id"]))["status"] == (
        "waiting-for-parser" if transient_failure else "imported"
    )


def test_reparse_conflict_retains_human_text_and_exposes_new_result(tmp_path: Path) -> None:
    importer, request, clients = setup(tmp_path)
    first = importer.import_document(request)
    assert first.source_text is not None
    first.source_text.write_text(
        first.source_text.read_text(encoding="utf-8") + "\nHuman edit\n", encoding="utf-8"
    )
    before = first.source_text.read_bytes()
    clients[
        ConversionMethod.MARKITDOWN_SERVICE
    ].markdown = "# New result\n\nA complete different converted document.\n"
    with pytest.raises(FileWriteConflict):
        importer.retry(first.conversion_id, method=ConversionMethod.MARKITDOWN_SERVICE)
    assert first.source_text.read_bytes() == before
    paths = BrainPaths(importer.vault, importer.original_store.root, importer.state_root)
    token = LocalTokenStore(paths.state).ensure()
    client = cast(Any, TestClient(create_app(paths, document_importer=importer)))
    endpoint = f"/documents/conversions/{first.conversion_id}/result"
    assert client.get(endpoint).status_code == 401
    result = client.get(endpoint, headers={"Authorization": f"Bearer {token}"})
    assert result.status_code == 200
    assert result.json()["method"] == "markitdown-service"
    assert result.json()["markdown"].startswith("# New result")
    assert result.json()["qc"]["passed"] is True
    assert first.source_text.read_bytes() == before


def test_quality_failure_is_not_a_publish_failure(tmp_path: Path) -> None:
    importer, request, clients = setup(tmp_path)
    clients[ConversionMethod.MARKITDOWN_SERVICE].markdown = "bad"
    with pytest.raises(RuntimeError, match="QC failed"):
        importer.import_document(replace(request, method=ConversionMethod.MARKITDOWN_SERVICE))
    record = cast(dict[str, Any], importer.store.list()[0])
    assert record["stages"]["quality"] == "failed"
    assert record["stages"]["routing"] == "not-started"
    importer.queue_retry(str(record["conversion_id"]), method=ConversionMethod.MINERU_CLOUD)
    assert DocumentImportWorker(importer).run_once()
    assert importer.store.list()[0]["status"] == "imported"


def test_busy_conversion_rejects_switch_without_losing_request(tmp_path: Path) -> None:
    importer, request, _ = setup(tmp_path)
    identifier = str(importer.enqueue(request)["conversion_id"])
    entered, release = Event(), Event()

    def hold_execution() -> None:
        with importer.store.execution(identifier):
            entered.set()
            assert release.wait(5)

    with ThreadPoolExecutor() as pool:
        future = pool.submit(hold_execution)
        assert entered.wait(5)
        try:
            with pytest.raises(ConversionBusyError):
                importer.queue_retry(identifier, method=ConversionMethod.MARKITDOWN_SERVICE)
        finally:
            release.set()
        future.result()
    assert importer.store.load(identifier)["method"] == "mineru-cloud"


def test_catalogue_is_configuration_only_and_formats_are_checked_before_queue(
    tmp_path: Path,
) -> None:
    importer, request, _ = setup(tmp_path)
    token = tmp_path / "markitdown.token"
    token.write_text("fixture-token")
    importer.settings = ImportSettings(markitdown_token_file=token)
    catalogue = method_catalogue(importer.settings)
    entries = {entry["id"]: entry for entry in cast(list[dict[str, Any]], catalogue["methods"])}
    assert not entries["mineru-cloud"]["configured"]
    assert entries["markitdown-service"]["configured"]
    assert not entries["mineru-self-hosted"]["enabled"]
    image = tmp_path / "image.png"
    image.write_bytes(b"image")
    with pytest.raises(ValueError, match="does not support"):
        importer.enqueue(replace(request, source=image, method=ConversionMethod.MARKITDOWN_SERVICE))
    assert not importer.store.list()
    with pytest.raises(ValueError, match="conflicts"):
        choose_method(request.source, ConversionMethod.MINERU_SELF_HOSTED, ParserName.MINERU)


def test_api_catalogue_legacy_aliases_and_format_validation(tmp_path: Path) -> None:
    importer, _, _ = setup(tmp_path)
    paths = BrainPaths(importer.vault, importer.original_store.root, importer.state_root)
    token = LocalTokenStore(paths.state).ensure()
    client = cast(Any, TestClient(create_app(paths, document_importer=importer)))
    headers = {"Authorization": f"Bearer {token}"}
    assert client.get("/documents/converters").status_code == 401
    assert (
        client.get("/documents/converters", headers=headers).json()["default_method"]
        == "mineru-cloud"
    )
    result = client.post(
        "/documents/import",
        headers=headers,
        data={"intent": "source", "parser": "markitdown"},
        files={"file": ("doc.pdf", b"%PDF", "application/pdf")},
    )
    assert result.status_code == 200
    assert result.json()["method"] == "markitdown-service"
    invalid = client.post(
        "/documents/import",
        headers=headers,
        data={"intent": "source", "method": "markitdown-service"},
        files={"file": ("image.png", b"image", "image/png")},
    )
    assert invalid.status_code == 400


def test_deployment_preserves_method_settings_and_clears_empty_token(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    for key in (
        "OKF_DEFAULT_CONVERSION_METHOD",
        "OKF_MARKITDOWN_TOKEN_FILE",
        "OKF_MINERU_SELF_HOSTED_ENABLED",
        "OKF_MINERU_SSH_MANAGED",
    ):
        monkeypatch.setenv(key, "")
    config = tmp_path / "deployment.json"
    config.write_text(
        json.dumps(
            {
                "default_conversion_method": "markitdown-service",
                "markitdown_token_file": "",
                "mineru_self_hosted_enabled": True,
                "mineru_ssh_managed": False,
            }
        )
    )
    monkeypatch.setenv("OKF_MARKITDOWN_TOKEN_FILE", "obsolete.token")
    apply_deployment_config(config)
    settings = ImportSettings.from_env()
    assert settings.default_conversion_method is ConversionMethod.MARKITDOWN_SERVICE
    assert settings.markitdown_token_file is None
    assert settings.mineru_self_hosted_enabled
    assert not settings.mineru_ssh_managed

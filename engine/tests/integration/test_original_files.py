from __future__ import annotations

import hashlib
from pathlib import Path
from typing import cast

import httpx
import pytest
from fastapi.testclient import TestClient

from okf_workspace.api import create_app
from okf_workspace.api.auth import LocalTokenStore
from okf_workspace.config import BrainPaths
from okf_workspace.importers.file_transport import (
    FileTransport,
    FileTransportConfig,
    OriginalReplication,
)
from okf_workspace.importers.models import ParserExport, ParserName
from okf_workspace.importers.pipeline import DocumentImporter
from okf_workspace.importers.synced_intake import SyncedDocumentIntake
from okf_workspace.importers.worker import DocumentImportWorker
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.okf.validator import validate_bundle

TOKEN = "a" * 40
DIGEST = hashlib.sha256(b"%PDF-1.7 remote fixture").hexdigest()
PAYLOAD = b"%PDF-1.7 remote fixture"
IDENTIFIER = "d1111111-1111-4111-a111-111111111111"


class FixtureParser:
    parser = ParserName.MINERU

    def convert(
        self, source: Path, working_directory: Path, *, timeout_seconds: float = 900.0
    ) -> ParserExport:
        del source, working_directory, timeout_seconds
        return ParserExport(
            markdown="# Remote fixture\n\n" + "Complete source material. " * 20,
            assets={},
            parser=self.parser,
            parser_version="fixture",
        )


def test_legacy_request_uses_migrated_vault_file_without_network(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    importer = DocumentImporter(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
        clients={ParserName.MINERU: FixtureParser()},
    )
    def forbidden(*_args: object, **_kwargs: object) -> None:
        pytest.fail("Full sync must not call the retired transport")

    monkeypatch.setattr(FileTransport, "download", forbidden)
    request = vault / "system" / "imports" / IDENTIFIER / "request.md"
    request.parent.mkdir(parents=True)
    write_document(
        request,
        OkfDocument(
            {
                "type": "Document Import Request",
                "title": "远程课件",
                "created_at": "2026-10-05T12:00:00Z",
                "request_id": IDENTIFIER,
                "transport": "file-store",
                "original_store": "fixture-store",
                "filename": "lecture.pdf",
                "file_sha256": DIGEST,
                "size_bytes": len(PAYLOAD),
                "intent": "source",
                "quality": "quick",
                "method": "auto",
                "generate": False,
            },
            "# 远程课件\n",
        ),
    )
    assert SyncedDocumentIntake(importer).scan() == 0
    receipt = request.with_name("receipt.md")
    assert read_document(receipt).frontmatter["processing_status"] == "waiting-for-file"
    assert not importer.store.list()
    local = tmp_path / "lecture.pdf"
    local.write_bytes(PAYLOAD)
    importer.original_store.ingest(local)
    assert SyncedDocumentIntake(importer).scan() == 1
    assert read_document(receipt).frontmatter["original_archived"] is True
    assert read_document(receipt).frontmatter["file_sha256"] == DIGEST
    assert importer.original_store.resolve(DIGEST).read_bytes() == PAYLOAD
    assert DocumentImportWorker(importer).run_once()
    assert SyncedDocumentIntake(importer).scan() == 0
    assert read_document(receipt).frontmatter["processing_status"] == "imported"
    assert len(importer.store.list()) == 1
    assert len(list(vault.rglob("*.pdf"))) == 1
    assert validate_bundle(vault).valid


def test_download_integrity_and_store_identity(tmp_path: Path) -> None:
    config = FileTransportConfig("https://files.example", TOKEN, "fixture-store")

    def handle(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/status":
            return httpx.Response(200, json={"store_id": "fixture-store"})
        return httpx.Response(200, content=b"wrong", headers={"x-okf-store-id": "fixture-store"})

    transport = FileTransport(config, client=httpx.Client(transport=httpx.MockTransport(handle)))
    target = tmp_path / "file.pdf"
    with pytest.raises(ValueError, match="integrity"):
        transport.download(DIGEST, target)
    assert not target.exists()
    transport.close()
    wrong = FileTransport(
        config,
        client=httpx.Client(
            transport=httpx.MockTransport(
                lambda _: httpx.Response(200, json={"store_id": "another-store"}),
            )
        ),
    )
    with pytest.raises(ValueError, match="identity"):
        wrong.download(DIGEST, target)
    wrong.close()


def test_modified_original_is_never_silently_replaced(tmp_path: Path) -> None:
    from okf_workspace.importers.originals import OriginalStore

    store = OriginalStore(tmp_path / "originals")
    source = tmp_path / "file.pdf"
    source.write_bytes(PAYLOAD)
    original = store.ingest(source)
    original.stored_path.write_bytes(b"user annotations")
    with pytest.raises(ValueError, match="原件内容已改变"):
        store.resolve(original.sha256, verify=True)
    with pytest.raises(ValueError, match="Stored Original changed"):
        store.ingest(source)
    assert original.stored_path.read_bytes() == b"user annotations"


def test_original_content_is_authenticated_and_not_an_arbitrary_file_read(tmp_path: Path) -> None:
    paths = BrainPaths(
        initialize_vault(tmp_path / "vault"), tmp_path / "originals", tmp_path / "state"
    )
    importer = DocumentImporter(vault=paths.vault, originals=paths.originals, state=paths.state)
    source = tmp_path / "课件.pdf"
    source.write_bytes(PAYLOAD)
    original = importer.original_store.ingest(source)
    app = create_app(paths, document_importer=importer, semantic_enabled=False)
    client = cast(httpx.Client, TestClient(app))
    token = LocalTokenStore(paths.state).ensure()
    headers = {"Authorization": f"Bearer {token}"}
    url = f"/documents/originals/{original.sha256}/content"
    assert client.get(url, params={"filename": source.name}).status_code == 401
    response = client.get(url, params={"filename": source.name}, headers=headers)
    assert response.status_code == 200
    assert response.content == PAYLOAD
    assert client.get(url.replace(original.sha256, "invalid"),
                      params={"filename": source.name}, headers=headers).status_code == 400
    assert client.get("/documents/files/config", headers=headers).status_code == 404
    assert client.post("/documents/uploads/cleanup?apply=true", headers=headers).status_code == 410
    assert original.stored_path.is_file()




def test_one_changed_original_does_not_block_uploading_other_files(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    from okf_workspace.importers.originals import OriginalStore

    store = OriginalStore(tmp_path / "originals")
    for name in ("one", "two"):
        source = tmp_path / f"{name}.pdf"
        source.write_bytes(name.encode())
        store.ingest(source)
    first = next(store.root.glob("sha256/*/*/manifest.json")).parent.name
    store.resolve(first).write_bytes(b"changed outside the importer")
    state = tmp_path / "state"
    FileTransportConfig("https://files.example", TOKEN, "fixture-store").save(state)

    def upload(_self: FileTransport, _path: Path, _digest: str) -> None:
        return None

    monkeypatch.setattr(FileTransport, "upload", upload)
    assert OriginalReplication(store, state).run_once() == 1

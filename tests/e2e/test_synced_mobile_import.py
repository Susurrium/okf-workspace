"""The real TypeScript mobile writer interoperates with the Python Engine."""

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from okf_workspace.importers.models import ParserExport, ParserName
from okf_workspace.importers.pipeline import DocumentImporter
from okf_workspace.importers.synced_intake import SyncedDocumentIntake
from okf_workspace.importers.worker import DocumentImportWorker
from okf_workspace.okf.frontmatter import read_document
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.okf.validator import validate_bundle


class FixtureConverter:
    parser = ParserName.MINERU

    def convert(
        self, source: Path, working_directory: Path, *, timeout_seconds: float = 900.0,
    ) -> ParserExport:
        del source, working_directory, timeout_seconds
        return ParserExport(
            markdown="# 跨端资料\n\n手机离线收集后通过同步送达电脑，电脑使用现有后台流程转换资料。",
            assets={}, parser=self.parser, parser_version="mobile-cross-component",
        )


@pytest.mark.parametrize("action", [None, "convert", "store"])
def test_mobile_writer_desktop_receiver_and_returned_results(
    tmp_path: Path, action: str | None,
) -> None:
    repository = Path(__file__).resolve().parents[2]
    mobile = initialize_vault(tmp_path / "mobile")
    desktop = initialize_vault(tmp_path / "desktop")
    source = tmp_path / "lecture.pdf"
    source.write_bytes(b"%PDF-1.7 offline mobile fixture")
    completed = subprocess.run(
        ["node", str(repository / "dashboard/tests/fixtures/create-synced-import.mjs"),
         str(mobile), str(source), *([action] if action else [])],
        capture_output=True, text=True, encoding="utf-8", check=True, timeout=60,
    )
    submission = json.loads(completed.stdout)
    request = mobile / submission["request_path"]
    assert validate_bundle(mobile).valid
    target = desktop / submission["request_path"]
    target.parent.mkdir(parents=True)
    shutil.copyfile(request, target)
    importer = DocumentImporter(
        vault=desktop, originals=tmp_path / "originals", state=tmp_path / "state",
        clients={ParserName.MINERU: FixtureConverter()},
    )
    intake = SyncedDocumentIntake(importer)
    assert intake.scan() == 0
    (desktop / submission["saved_path"]).parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(mobile / submission["saved_path"], desktop / submission["saved_path"])
    assert intake.scan() == 1
    assert DocumentImportWorker(importer).run_once() is (action != "store")
    assert SyncedDocumentIntake(importer).scan() == 0
    receipt = read_document(target.with_name("receipt.md"))
    expected_status = "stored" if action == "store" else "imported"
    assert receipt.frontmatter["processing_status"] == expected_status
    for relative in receipt.frontmatter["outputs"].values():
        destination = mobile / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(desktop / relative, destination)
    shutil.copyfile(target.with_name("receipt.md"), request.with_name("receipt.md"))
    if action == "store":
        assert "source_text" not in receipt.frontmatter["outputs"]
        assert not importer.store.list()
        assert not DocumentImportWorker(importer).run_once()
    else:
        assert "跨端资料" in (mobile / receipt.frontmatter["outputs"]["source_text"]).read_text(
            encoding="utf-8",
        )
    assert (mobile / submission["saved_path"]).is_file()
    assert len(list(desktop.rglob("*.pdf"))) == 1
    assert not importer.legacy_originals.exists()
    assert validate_bundle(desktop).valid

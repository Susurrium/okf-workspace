"""Upgrade real legacy TypeScript device bytes into the full-sync import path."""
from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

from okf_workspace.importers.models import ParserExport, ParserName
from okf_workspace.importers.pipeline import DocumentImporter
from okf_workspace.importers.synced_intake import SyncedDocumentIntake
from okf_workspace.importers.worker import DocumentImportWorker
from okf_workspace.okf.frontmatter import read_document
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.okf.validator import validate_bundle


class FixtureParser:
    parser = ParserName.MINERU

    def convert(self, source: Path, working_directory: Path, *,
                timeout_seconds: float = 900.0) -> ParserExport:
        del source, working_directory, timeout_seconds
        return ParserExport(markdown="# Recovered fixture\n\n" + "Course material. " * 30,
                            assets={}, parser=self.parser, parser_version="fixture")


def test_pending_device_upload_recovers_without_the_retired_server(tmp_path: Path) -> None:
    repository = Path(__file__).resolve().parents[2]
    mobile = initialize_vault(tmp_path / "mobile")
    desktop = initialize_vault(tmp_path / "desktop")
    source = tmp_path / "lecture.pdf"
    source.write_bytes(b"%PDF-1.7 legacy offline fixture")
    result = subprocess.run(
        ["node", str(repository / "dashboard/tests/fixtures/recover-legacy-import.mjs"),
         str(mobile), str(source)],
        capture_output=True, text=True, encoding="utf-8", check=True, timeout=60,
    )
    recovered = json.loads(result.stdout)
    assert recovered["issues"] == recovered["repeated"] == recovered["uploadKeys"] == []
    request = mobile / recovered["saved"]["request_path"]
    fields = read_document(request).frontmatter
    assert "transport" not in fields
    assert str(fields["file"]).startswith("/sources/originals/")
    shutil.copytree(mobile, desktop, dirs_exist_ok=True)
    importer = DocumentImporter(vault=desktop, originals=tmp_path / "old-originals",
                                state=tmp_path / "state",
                                clients={ParserName.MINERU: FixtureParser()})
    assert SyncedDocumentIntake(importer).scan() == 1
    assert DocumentImportWorker(importer).run_once()
    assert SyncedDocumentIntake(importer).scan() == 0
    receipt = read_document((desktop / request.relative_to(mobile)).with_name("receipt.md"))
    assert receipt.frontmatter["processing_status"] == "imported"
    assert len(list(desktop.rglob("*.pdf"))) == 1
    assert not importer.legacy_originals.exists()
    assert validate_bundle(desktop).valid
    assert validate_bundle(mobile).valid

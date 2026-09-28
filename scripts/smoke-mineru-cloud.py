"""Exercise the real MinerU precision API with a repository fixture."""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

from okf_workspace.importers.cloud_mineru import CloudMinerUClient
from okf_workspace.importers.config import ImportSettings
from okf_workspace.importers.models import ImportIntent, ImportQuality, ImportRequest
from okf_workspace.importers.pipeline import DocumentImporter
from okf_workspace.importers.qc import inspect_export
from okf_workspace.okf.templates import initialize_vault


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--token-file", required=True, type=Path)
    parser.add_argument("--file", type=Path, default=Path(__file__).resolve().parents[1]
                        / "engine/tests/fixtures/documents/text.pdf")
    parser.add_argument("--pipeline", action="store_true")
    arguments = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="okf-mineru-cloud-smoke-") as directory:
        if arguments.pipeline:
            root = Path(directory)
            importer = DocumentImporter(
                vault=initialize_vault(root / "vault"),
                originals=root / "originals",
                state=root / "state",
                settings=ImportSettings(mineru_token_file=arguments.token_file),
            )
            result = importer.import_document(ImportRequest(
                source=arguments.file, intent=ImportIntent.SOURCE, quality=ImportQuality.HIGH,
            ))
            if not result.source_text or not result.source_text.is_file():
                raise RuntimeError("MinerU result was not published to the fixture Vault")
            print(json.dumps({
                "parser": result.parser.value,
                "qc_passed": result.qc.passed,
                "source_text_published": True,
            }))
            return
        working = Path(directory) / "working"
        working.mkdir()
        (working.parent / "status.json").write_text("{}", encoding="utf-8")
        client = CloudMinerUClient(arguments.token_file)
        try:
            export = client.convert(arguments.file, working, timeout_seconds=600)
        finally:
            client.close()
        qc = inspect_export(export, strict_assets=True)
        if not qc.passed:
            raise RuntimeError("MinerU result failed local QC: " + "; ".join(qc.errors))
        print(json.dumps({
            "parser": export.parser.value,
            "parser_version": export.parser_version,
            "markdown_characters": len(export.markdown),
            "assets": len(export.assets),
            "qc_passed": qc.passed,
        }))


if __name__ == "__main__":
    main()

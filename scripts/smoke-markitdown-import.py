"""Exercise the real configured parser through Engine, using public fixtures only.

Uses a disposable Vault/State/Originals, never the production knowledge base.
The deployment config supplies only the existing parser connection and token.
"""

from __future__ import annotations

import argparse
import json
import tempfile
from pathlib import Path

from okf_workspace.config import apply_deployment_config
from okf_workspace.importers.models import ImportIntent, ImportRequest, ParserName
from okf_workspace.importers.pipeline import DocumentImporter
from okf_workspace.okf.frontmatter import read_document
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.okf.validator import validate_bundle


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True, type=Path)
    args = parser.parse_args()
    apply_deployment_config(args.config)
    fixtures = Path(__file__).resolve().parents[1] / "engine/tests/fixtures/documents"
    results: list[dict[str, object]] = []
    with tempfile.TemporaryDirectory(prefix="okf-markitdown-live-smoke-") as directory:
        root = Path(directory)
        vault = initialize_vault(root / "vault")
        importer = DocumentImporter(
            vault=vault, originals=root / "originals", state=root / "state"
        )
        for filename in ("simple.docx", "slides.pptx"):
            result = importer.import_document(
                ImportRequest(source=fixtures / filename, intent=ImportIntent.SOURCE)
            )
            assert result.parser is ParserName.MARKITDOWN
            assert result.qc.passed, result.qc.errors
            assert result.source is not None and result.source_text is not None
            document = read_document(result.source_text)
            assert document.frontmatter["parser"] == "markitdown"
            images = list((result.export_directory / "assets").rglob("*"))
            image_count = sum(image.is_file() for image in images)
            if filename == "slides.pptx":
                assert image_count > 0, "The slide fixture's raster image was lost"
            results.append(
                {
                    "fixture": filename,
                    "parser": result.parser.value,
                    "qc_passed": result.qc.passed,
                    "assets": image_count,
                    "source": result.source.relative_to(vault).as_posix(),
                    "source_text": result.source_text.relative_to(vault).as_posix(),
                }
            )
        report = validate_bundle(vault)
        assert report.valid, report.errors
    print(json.dumps({"passed": True, "imports": results}, ensure_ascii=True, indent=2))


if __name__ == "__main__":
    main()

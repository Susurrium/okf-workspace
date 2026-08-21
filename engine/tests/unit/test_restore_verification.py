from __future__ import annotations

import hashlib
from pathlib import Path

from okf_workspace.deployment import verify_restored_data
from okf_workspace.notes import NoteService
from okf_workspace.okf.frontmatter import OkfDocument, write_document


def test_restore_verification_checks_markdown_and_original_references(
    vault: Path, tmp_path: Path
) -> None:
    NoteService(vault).create_daily()
    payload = b"restored-pdf"
    digest = hashlib.sha256(payload).hexdigest()
    originals = tmp_path / "originals"
    stored = originals / "sha256" / digest[:2] / digest / "original.pdf"
    stored.parent.mkdir(parents=True)
    stored.write_bytes(payload)
    write_document(
        vault / "sources" / "records" / "documents" / "restored.md",
        OkfDocument(
            {
                "type": "Source",
                "title": "Restored",
                "status": "stable",
                "resource": f"okf-original://sha256/{digest}/manual.pdf",
            },
            "# Restored\n",
        ),
    )

    result = verify_restored_data(vault, originals)

    assert result.valid
    assert result.markdown_files > 1
    assert result.resolved_originals == result.original_references == 1


def test_restore_verification_fails_when_original_is_missing(vault: Path, tmp_path: Path) -> None:
    digest = "0" * 64
    write_document(
        vault / "sources" / "records" / "documents" / "missing.md",
        OkfDocument(
            {
                "type": "Source",
                "title": "Missing",
                "status": "stable",
                "resource": f"okf-original://sha256/{digest}/missing.pdf",
            },
            "# Missing\n",
        ),
    )

    result = verify_restored_data(vault, tmp_path / "originals")

    assert not result.valid
    assert result.resolved_originals == 0
    assert any("missing Original" in error for error in result.errors)

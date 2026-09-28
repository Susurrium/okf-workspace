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


def test_restore_verification_requires_the_referenced_original_extension(
    vault: Path, tmp_path: Path
) -> None:
    payload = b"same bytes, different extension"
    digest = hashlib.sha256(payload).hexdigest()
    directory = tmp_path / "originals" / "sha256" / digest[:2] / digest
    directory.mkdir(parents=True)
    (directory / "original.txt").write_bytes(payload)
    write_document(
        vault / "sources" / "records" / "documents" / "wrong-extension.md",
        OkfDocument(
            {
                "type": "Source",
                "title": "Wrong extension",
                "status": "stable",
                "resource": f"okf-original://sha256/{digest}/manual.pdf",
            },
            "# Wrong extension\n",
        ),
    )

    result = verify_restored_data(vault, tmp_path / "originals")

    assert not result.valid
    assert result.resolved_originals == 0
    assert any("missing Original" in error for error in result.errors)


def test_restore_verification_rejects_a_corrupt_original(vault: Path, tmp_path: Path) -> None:
    digest = hashlib.sha256(b"original bytes").hexdigest()
    stored = tmp_path / "originals" / "sha256" / digest[:2] / digest / "original.pdf"
    stored.parent.mkdir(parents=True)
    stored.write_bytes(b"corrupt bytes")
    write_document(
        vault / "sources" / "records" / "documents" / "corrupt.md",
        OkfDocument(
            {
                "type": "Source",
                "title": "Corrupt",
                "status": "stable",
                "resource": f"okf-original://sha256/{digest}/manual.pdf",
            },
            "# Corrupt\n",
        ),
    )

    result = verify_restored_data(vault, tmp_path / "originals")

    assert not result.valid
    assert result.resolved_originals == 0
    assert any("corrupt Original" in error for error in result.errors)


def test_restore_verification_rejects_malformed_original_reference(
    vault: Path, tmp_path: Path
) -> None:
    write_document(
        vault / "sources" / "records" / "documents" / "malformed.md",
        OkfDocument(
            {
                "type": "Source",
                "title": "Malformed",
                "status": "stable",
                "resource": "okf-original://sha256/invalid/manual.pdf",
            },
            "# Malformed\n",
        ),
    )

    result = verify_restored_data(vault, tmp_path / "originals")

    assert not result.valid
    assert result.original_references == 1
    assert any("invalid Original resource" in error for error in result.errors)

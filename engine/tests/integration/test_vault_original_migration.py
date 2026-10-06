from __future__ import annotations

import json
from pathlib import Path

import pytest

from okf_workspace.importers.originals import OriginalStore, VaultOriginalStore
from okf_workspace.importers.vault_original_migration import migrate_originals
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document
from okf_workspace.okf.templates import initialize_vault


def test_migration_preserves_originals_notes_and_conversion_identity(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    state = tmp_path / "state"
    legacy = OriginalStore(tmp_path / "legacy")
    source = tmp_path / "中文课件.pdf"
    source.write_bytes(b"%PDF-1.7 migration fixture")
    original = legacy.ingest(source)
    note = vault / "sources/records/documents/lecture.md"
    write_document(note, OkfDocument({
        "type": "Source", "title": "My title", "created_at": "2026-10-06T00:00:00Z",
        "resource": original.resource, "sha256": original.sha256, "custom": {"kept": True},
    }, f"# My title\n\n- 原件：{original.resource}\n\n人工备注、批注与任务。\n"))
    status = state / "conversions/conv-fixture/status.json"
    status.parent.mkdir(parents=True)
    status.write_text(json.dumps({"source_sha256": original.sha256,
                                 "original_path": str(original.stored_path),
                                 "conversion_id": "conv-fixture", "status": "imported"}))
    report = migrate_originals(vault, legacy.root, state)
    assert report["originals"] == 1
    migrated = VaultOriginalStore(vault, state).resolve(original.sha256, verify=True)
    assert migrated.name == source.name
    assert migrated.read_bytes() == original.stored_path.read_bytes()
    document = read_document(note)
    assert document.frontmatter["custom"] == {"kept": True}
    assert document.frontmatter["resource"] == "/" + migrated.relative_to(vault).as_posix()
    assert "人工备注、批注与任务。" in document.body
    assert "[[sources/originals/" in document.body
    record = json.loads(status.read_text(encoding="utf-8"))
    assert record["conversion_id"] == "conv-fixture"
    assert record["original_path"] == str(migrated)
    assert original.stored_path.is_file()
    repeated = migrate_originals(vault, legacy.root, state)
    assert repeated["updated_notes"] == []
    assert repeated["updated_conversions"] == 0
    assert len(list(vault.rglob("*.pdf"))) == 1


def test_migration_never_replaces_a_modified_vault_original(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    source = tmp_path / "lecture.pdf"
    source.write_bytes(b"%PDF original")
    legacy = OriginalStore(tmp_path / "legacy")
    original = legacy.ingest(source)
    store = VaultOriginalStore(vault, tmp_path / "state")
    copied = store.ingest(source)
    copied.stored_path.write_bytes(b"user annotations")
    with pytest.raises(ValueError, match="原件内容已改变"):
        migrate_originals(vault, legacy.root, tmp_path / "state")
    assert copied.stored_path.read_bytes() == b"user annotations"
    assert original.stored_path.read_bytes() == source.read_bytes()

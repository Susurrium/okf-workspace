from __future__ import annotations

import shutil
from pathlib import Path

from okf_workspace.config import default_template_root
from okf_workspace.okf.templates import (
    VAULT_DYNAMIC_DIRECTORIES,
    ensure_vault_dynamic_directories,
    initialize_vault,
)


def test_workspace_kit_creates_canonical_empty_content_directories(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")

    for relative in VAULT_DYNAMIC_DIRECTORIES:
        assert (vault / relative).is_dir()

    assert not (vault / "learning/topics").exists()
    assert not (vault / "sources/extracts").exists()


def test_dynamic_directory_repair_is_idempotent_and_never_copies_content(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    existing = vault / "inbox/captures"
    existing.mkdir(parents=True)
    note = existing / "keep.md"
    note.write_text("keep\n", encoding="utf-8")

    created = ensure_vault_dynamic_directories(vault)

    assert Path("inbox/captures") not in created
    assert note.read_text(encoding="utf-8") == "keep\n"
    assert all((vault / relative).is_dir() for relative in VAULT_DYNAMIC_DIRECTORIES)
    assert ensure_vault_dynamic_directories(vault) == ()


def test_workspace_kit_never_copies_dynamic_content(tmp_path: Path) -> None:
    template = tmp_path / "template"
    shutil.copytree(default_template_root(), template)
    private_note = template / "inbox/captures/private.md"
    private_note.parent.mkdir(parents=True, exist_ok=True)
    private_note.write_text("private\n", encoding="utf-8")
    workspace_state = template / ".obsidian/workspace.json"
    workspace_state.write_text('{"private": true}\n', encoding="utf-8")
    private_decision = template / "self/decisions/private.md"
    private_decision.parent.mkdir(parents=True, exist_ok=True)
    private_decision.write_text("private decision\n", encoding="utf-8")

    vault = initialize_vault(tmp_path / "vault", template_root=template)

    assert not (vault / "inbox/captures/private.md").exists()
    assert not (vault / ".obsidian/workspace.json").exists()
    assert not (vault / "self/decisions/private.md").exists()

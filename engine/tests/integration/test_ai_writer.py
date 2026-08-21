from __future__ import annotations

from pathlib import Path

from okf_workspace.ai.writer import AIWriter
from okf_workspace.git import create_checkpoint, initialize_repository, undo_last_checkpoint
from okf_workspace.notes import NoteService
from okf_workspace.okf.frontmatter import read_document
from okf_workspace.okf.templates import initialize_vault


def test_explicit_ai_wiki_is_stable_by_default_sourced_and_one_step_undoable(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    initialize_repository(vault)
    create_checkpoint(vault, "initial Vault")
    writer = AIWriter(vault)

    target = writer.create_wiki(
        "LiveSync 不是备份",
        "同步与备份解决的是不同问题。",
        sources=("knowledge/wiki/livesync.md",),
    )

    document = read_document(target)
    assert "status" not in document.frontmatter
    assert "studied_at" not in document.frontmatter
    assert "generated" not in document.frontmatter
    assert document.frontmatter["sources"][0]["resource"] == ("/knowledge/wiki/livesync.md")

    undo_last_checkpoint(vault)

    assert not target.exists()


def test_automatic_ai_only_replaces_named_project_region(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    project = NoteService(vault).create_project("demo", "Demo")
    initialize_repository(vault)
    create_checkpoint(vault, "initial project")
    before = project.read_text(encoding="utf-8")

    AIWriter(vault).replace_region(
        "projects/demo/project.md",
        "project-current-state",
        "## 当前状态\n\n索引完成。\n\n## 下一步\n\n接入导入器。",
        actor="automatic-ai",
    )

    after = project.read_text(encoding="utf-8")
    assert "索引完成" in after
    assert (
        before.split("<!-- ai:auto:start", 1)[0]
        == after.split(
            "<!-- ai:auto:start",
            1,
        )[0]
    )

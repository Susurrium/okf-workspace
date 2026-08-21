from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from okf_workspace.notes import NoteService
from okf_workspace.notes.captures import discard_capture, process_capture
from okf_workspace.okf.frontmatter import read_document
from okf_workspace.okf.templates import initialize_vault

NOW = datetime(2026, 8, 17, 14, 32, 5, tzinfo=timezone(timedelta(hours=8)))


def test_capture_becomes_stable_wiki_and_original_is_archived(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    capture = NoteService(vault, clock=lambda: NOW).create_capture(
        "同步与备份",
        "LiveSync 不能替代备份。",
    )
    relative = capture.relative_to(vault).as_posix()

    target, archived = process_capture(
        vault,
        relative,
        destination="wiki",
    )

    assert not capture.exists()
    assert archived.relative_to(vault).as_posix().startswith("archive/captures/2026/08/")
    archived_document = read_document(archived)
    assert archived_document.frontmatter["capture_status"] == "processed"
    assert archived_document.frontmatter["processed_into"] == ["/knowledge/wiki/同步与备份.md"]
    target_document = read_document(target)
    assert "status" not in target_document.frontmatter
    assert "studied_at" not in target_document.frontmatter
    assert target_document.frontmatter["sources"][0]["resource"].startswith(
        "/archive/captures/2026/08/"
    )


def test_capture_can_become_learning_note_or_be_discarded_without_deletion(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)
    learning_capture = service.create_capture("学习线索", "一段待学习的原始内容")
    learning, archived = process_capture(
        vault,
        learning_capture.relative_to(vault).as_posix(),
        destination="study-guide",
    )
    assert "learning/guides/" in learning.relative_to(vault).as_posix()
    rendered_learning = learning.read_text(encoding="utf-8")
    assert "learning_status" not in rendered_learning
    assert "study_material_status" not in rendered_learning
    assert "一段待学习的原始内容" in rendered_learning
    assert archived.is_file()

    discarded_capture = service.create_capture("不再处理", "仍然保留原始文字")
    discarded = discard_capture(vault, discarded_capture.relative_to(vault).as_posix())
    assert discarded.is_file()
    rendered = discarded.read_text(encoding="utf-8")
    assert "capture_status: discarded" in rendered
    assert "仍然保留原始文字" in rendered

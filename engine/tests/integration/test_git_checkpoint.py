from __future__ import annotations

from pathlib import Path
from subprocess import TimeoutExpired, run

import pytest

from okf_workspace import git as git_module
from okf_workspace.git import (
    create_checkpoint,
    initialize_repository,
    latest_checkpoint_summary,
    undo_last_checkpoint,
)


def git(repo: Path, *args: str) -> str:
    result = run(
        ["git", *args],
        cwd=repo,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    return result.stdout.strip()


def test_checkpoint_and_revert_are_human_auditable(tmp_path: Path) -> None:
    repo = tmp_path / "vault"
    repo.mkdir()
    initialize_repository(repo)

    note = repo / "中文 note.md"
    note.write_text("第一版\n", encoding="utf-8")
    first = create_checkpoint(repo, "initial note")
    note.write_text("第二版\n", encoding="utf-8")
    second = create_checkpoint(repo, "update note")

    assert first
    assert second
    assert latest_checkpoint_summary(repo) == {
        "checkpoint": second,
        "message": "update note",
        "files": ["中文 note.md"],
    }
    assert git(repo, "log", "--format=%s", "-2").splitlines() == [
        "update note",
        "initial note",
    ]

    revert = undo_last_checkpoint(repo)

    assert revert
    assert note.read_text(encoding="utf-8") == "第一版\n"
    assert git(repo, "log", "--format=%s", "-1").startswith('Revert "update note"')


def test_automatic_checkpoint_does_not_initialize_vault_git(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    (vault / "note.md").write_text("content\n", encoding="utf-8")

    assert create_checkpoint(vault, "automatic write") is None
    assert not (vault / ".git").exists()


def test_git_commands_fail_fast_when_the_process_hangs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    initialize_repository(tmp_path)

    def timeout(*_args: object, **_kwargs: object) -> object:
        raise TimeoutExpired(cmd="git", timeout=8)

    monkeypatch.setattr(git_module.subprocess, "run", timeout)

    with pytest.raises(git_module.GitCheckpointError, match="timed out after 8s"):
        git_module.create_checkpoint(tmp_path, "must not hang")

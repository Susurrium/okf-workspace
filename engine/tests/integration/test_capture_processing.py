from __future__ import annotations

import multiprocessing
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Protocol, cast

import pytest

from okf_workspace.git import GitCheckpointError
from okf_workspace.notes import NoteService
from okf_workspace.notes.captures import discard_capture, process_capture
from okf_workspace.okf.frontmatter import read_document
from okf_workspace.okf.templates import initialize_vault

NOW = datetime(2026, 8, 17, 14, 32, 5, tzinfo=timezone(timedelta(hours=8)))


class _StartSignal(Protocol):
    def wait(self, timeout: float | None = None) -> bool: ...

    def set(self) -> None: ...


class _StringQueue(Protocol):
    def put(
        self,
        item: str,
        block: bool = True,
        timeout: float | None = None,
    ) -> None: ...

    def get(self, block: bool = True, timeout: float | None = None) -> str: ...


def _multiprocess_capture_route(
    vault: str,
    relative: str,
    start: _StartSignal,
    output: _StringQueue,
) -> None:
    start.wait(timeout=10)
    try:
        process_capture(Path(vault), relative, destination="project-log")
    except Exception as exc:
        output.put(f"rejected:{type(exc).__name__}")
    else:
        output.put("published")


def test_capture_becomes_one_stable_wiki_and_is_consumed(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    capture = NoteService(vault, clock=lambda: NOW).create_capture(
        "同步与备份",
        "LiveSync 不能替代备份。",
    )

    target = process_capture(
        vault,
        capture.relative_to(vault).as_posix(),
        destination="wiki",
    )

    assert not capture.exists()
    assert not (vault / "archive/captures").exists()
    target_document = read_document(target)
    assert "status" not in target_document.frontmatter
    assert "studied_at" not in target_document.frontmatter
    assert "sources" not in target_document.frontmatter
    assert "LiveSync 不能替代备份。" in target_document.body


def test_capture_can_become_learning_note_or_be_discarded(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)
    learning_capture = service.create_capture("学习线索", "一段待学习的原始内容")
    learning = process_capture(
        vault,
        learning_capture.relative_to(vault).as_posix(),
        destination="study-guide",
    )
    assert "learning/guides/" in learning.relative_to(vault).as_posix()
    rendered_learning = learning.read_text(encoding="utf-8")
    assert "learning_status" not in rendered_learning
    assert "study_material_status" not in rendered_learning
    assert "一段待学习的原始内容" in rendered_learning
    assert not learning_capture.exists()

    discarded_capture = service.create_capture("不再处理", "不需要保留的临时文字")
    deleted = discard_capture(vault, discarded_capture.relative_to(vault).as_posix())
    assert deleted == discarded_capture
    assert not discarded_capture.exists()
    assert (vault / ".trash" / discarded_capture.relative_to(vault)).is_file()


def test_failed_capture_route_keeps_the_inbox_capture(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    capture = NoteService(vault, clock=lambda: NOW).create_capture("课堂线索", "原始记录")

    with pytest.raises(ValueError, match="course"):
        process_capture(
            vault,
            capture.relative_to(vault).as_posix(),
            destination="lesson",
        )

    assert capture.is_file()
    assert "原始记录" in read_document(capture).body


def test_existing_target_collision_keeps_both_target_and_capture(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)
    existing = service.create_wiki("重复主题", "已经存在的长期内容。")
    capture = service.create_capture("重复主题", "尚未处理的临时内容。")

    with pytest.raises(FileExistsError):
        process_capture(
            vault,
            capture.relative_to(vault).as_posix(),
            destination="wiki",
        )

    assert capture.is_file()
    assert "已经存在的长期内容。" in read_document(existing).body


def test_capture_delete_failure_rolls_back_new_target(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    capture = NoteService(vault, clock=lambda: NOW).create_capture("回滚主题", "临时内容。")

    def fail_delete(_source: Path) -> None:
        raise OSError("simulated delete failure")

    monkeypatch.setattr("okf_workspace.notes.captures._delete_capture", fail_delete)
    with pytest.raises(OSError, match="simulated delete failure"):
        process_capture(
            vault,
            capture.relative_to(vault).as_posix(),
            destination="wiki",
        )

    assert capture.is_file()
    assert not (vault / "knowledge/wiki/回滚主题.md").exists()


def test_capture_delete_failure_restores_existing_project_log(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)
    service.create_project("rollback", "Rollback")
    log = vault / "projects/rollback/log.md"
    before = log.read_bytes()
    capture = service.create_capture("不应留下", "项目更新。", project="rollback")

    def fail_delete(_source: Path) -> None:
        raise OSError("simulated delete failure")

    monkeypatch.setattr("okf_workspace.notes.captures._delete_capture", fail_delete)
    with pytest.raises(OSError, match="simulated delete failure"):
        process_capture(
            vault,
            capture.relative_to(vault).as_posix(),
            destination="project-log",
        )

    assert capture.is_file()
    assert log.read_bytes() == before


def test_project_log_rollback_removes_only_its_marker_after_an_unrelated_edit(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)
    service.create_project("edited-rollback", "Edited Rollback")
    log = vault / "projects/edited-rollback/log.md"
    before = log.read_text(encoding="utf-8")
    capture = service.create_capture(
        "不应留下的事务",
        "这一条必须精确撤销。",
        project="edited-rollback",
    )

    def edit_then_fail(_source: Path) -> None:
        with log.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write("\n\n外部保留内容。")
        raise OSError("simulated delete failure after unrelated edit")

    monkeypatch.setattr("okf_workspace.notes.captures._delete_capture", edit_then_fail)
    with pytest.raises(OSError, match="simulated delete failure"):
        process_capture(
            vault,
            capture.relative_to(vault).as_posix(),
            destination="project-log",
        )

    rendered = log.read_text(encoding="utf-8")
    assert capture.is_file()
    assert before in rendered
    assert "外部保留内容。" in rendered
    assert "不应留下的事务" not in rendered
    assert "这一条必须精确撤销。" not in rendered
    assert "okf:capture-transaction" not in rendered


def test_capture_title_is_not_repeated_in_target_or_project_log(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)
    capture = service.create_capture("只写一次", "只写一次")
    reflection = process_capture(
        vault,
        capture.relative_to(vault).as_posix(),
        destination="reflection",
    )
    assert read_document(reflection).body.count("只写一次") == 1

    service.create_project("workspace", "Workspace")
    project_capture = service.create_capture(
        "完成导入测试",
        "完成导入测试\n\n下一步检查图片。",
        project="workspace",
    )
    log = process_capture(
        vault,
        project_capture.relative_to(vault).as_posix(),
        destination="project-log",
    )
    rendered = log.read_text(encoding="utf-8")
    assert rendered.count("完成导入测试") == 1
    assert "下一步检查图片。" in rendered


def test_post_action_checkpoint_failure_does_not_report_a_successful_route_as_failed(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    capture = NoteService(vault, clock=lambda: NOW).create_capture("检查点失败", "仍应成功。")
    calls = 0

    def checkpoint(_vault: Path, _message: str) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise GitCheckpointError("simulated locked index")

    monkeypatch.setattr("okf_workspace.notes.captures.create_checkpoint", checkpoint)

    target = process_capture(
        vault,
        capture.relative_to(vault).as_posix(),
        destination="reflection",
    )

    assert target.is_file()
    assert not capture.exists()


def test_concurrent_project_log_routes_consume_capture_once_without_rolling_back_success(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)
    project = service.create_project("concurrent", "Concurrent")
    capture = service.create_capture(
        "并发记录",
        "这条合法日志只能保留一次。",
        project=project.relative_to(vault).as_posix(),
    )
    relative = capture.relative_to(vault).as_posix()

    def route(_index: int) -> str:
        try:
            process_capture(vault, relative, destination="project-log")
        except (FileNotFoundError, ValueError):
            return "already-consumed"
        return "published"

    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(route, range(2)))

    assert sorted(results) == ["already-consumed", "published"]
    rendered = (vault / "projects/concurrent/log.md").read_text(encoding="utf-8")
    assert rendered.count("并发记录") == 1
    assert rendered.count("这条合法日志只能保留一次。") == 1


def test_multiprocess_project_log_routes_consume_the_same_capture_once(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)
    project = service.create_project("multiprocess", "Multiprocess")
    capture = service.create_capture(
        "跨进程记录",
        "API 与 CLI 同时请求也只能写入一次。",
        project=project.relative_to(vault).as_posix(),
    )
    relative = capture.relative_to(vault).as_posix()
    context = multiprocessing.get_context("spawn")
    start = cast(_StartSignal, context.Event())
    output = cast(_StringQueue, context.Queue())
    processes = [
        context.Process(
            target=_multiprocess_capture_route,
            args=(str(vault), relative, start, output),
        )
        for _ in range(2)
    ]
    for process in processes:
        process.start()
    start.set()
    for process in processes:
        process.join(20)
        assert process.exitcode == 0

    results = sorted(output.get(timeout=5) for _ in processes)
    assert results[0] == "published"
    assert results[1].startswith("rejected:")
    assert not capture.exists()
    rendered = (vault / "projects/multiprocess/log.md").read_text(encoding="utf-8")
    assert rendered.count("跨进程记录") == 1
    assert rendered.count("API 与 CLI 同时请求也只能写入一次。") == 1
    assert "okf:capture-transaction" not in rendered
    assert (vault / ".trash/.okf-capture-transaction.lock").is_file()


def test_multiprocess_different_captures_preserve_both_entries_in_one_project_log(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)
    project = service.create_project("shared-log", "Shared Log")
    first = service.create_capture(
        "第一条跨进程记录",
        "第一条正文必须保留。",
        project=project.relative_to(vault).as_posix(),
    )
    second = service.create_capture(
        "第二条跨进程记录",
        "第二条正文也必须保留。",
        project=project.relative_to(vault).as_posix(),
    )
    context = multiprocessing.get_context("spawn")
    start = cast(_StartSignal, context.Event())
    output = cast(_StringQueue, context.Queue())
    processes = [
        context.Process(
            target=_multiprocess_capture_route,
            args=(str(vault), capture.relative_to(vault).as_posix(), start, output),
        )
        for capture in (first, second)
    ]
    for process in processes:
        process.start()
    start.set()
    for process in processes:
        process.join(20)
        assert process.exitcode == 0

    assert sorted(output.get(timeout=5) for _ in processes) == ["published", "published"]
    assert not first.exists()
    assert not second.exists()
    rendered = (vault / "projects/shared-log/log.md").read_text(encoding="utf-8")
    assert rendered.count("第一条跨进程记录") == 1
    assert rendered.count("第一条正文必须保留。") == 1
    assert rendered.count("第二条跨进程记录") == 1
    assert rendered.count("第二条正文也必须保留。") == 1
    assert "okf:capture-transaction" not in rendered

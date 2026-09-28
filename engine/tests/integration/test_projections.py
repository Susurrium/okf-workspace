from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone
from pathlib import Path

from okf_workspace.notes.create import NoteService
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.projections.navigation import rebuild_root_index
from okf_workspace.projections.tasks import collect_tasks
from okf_workspace.projections.today import build_today_snapshot

NOW = datetime(2026, 8, 17, 14, 32, 5, tzinfo=timezone(timedelta(hours=8)))


def test_task_projection_reads_real_markdown_and_ignores_code_fences(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)
    service.create_daily(
        content=(
            "- [ ] #task 整理课堂笔记\n"
            "- [x] 已完成任务\n\n"
            "```markdown\n"
            "- [ ] 示例代码，不是真任务\n"
            "```\n"
        )
    )
    service.create_capture("下一步", "- [ ] #task 检查同步配置")

    tasks = collect_tasks(vault)
    output = rebuild_root_index(vault)
    rendered = output.read_text(encoding="utf-8")

    assert [task.text for task in tasks] == ["检查同步配置", "整理课堂笔记"]
    assert "示例代码，不是真任务" not in rendered
    assert "整理课堂笔记" not in rendered
    assert "检查同步配置" not in rendered


def test_task_projection_matches_shared_cross_language_fixture(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    fixture_path = (
        Path(__file__).resolve().parents[3]
        / "tests"
        / "fixtures"
        / "tasks"
        / "task-cases.json"
    )
    cases = json.loads(fixture_path.read_text(encoding="utf-8"))
    expected: list[str] = []
    for case in cases:
        target = vault / case["path"]
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(case["markdown"], encoding="utf-8")
    for case in sorted(cases, key=lambda item: item["path"]):
        expected.extend(case["formal_open"])

    assert [task.text for task in collect_tasks(vault)] == expected


def test_task_projection_ignores_runtime_instruction_files(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    instruction = vault / ".agents" / "skills" / "example" / "SKILL.md"
    instruction.parent.mkdir(parents=True, exist_ok=True)
    instruction.write_text("- [ ] #task 这不是用户任务\n", encoding="utf-8")

    assert collect_tasks(vault) == []


def test_unchanged_navigation_projection_does_not_rewrite_root_index(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    output = rebuild_root_index(vault)
    first_mtime = output.stat().st_mtime_ns

    rebuild_root_index(vault)

    assert output.stat().st_mtime_ns == first_mtime


def test_root_navigation_stays_static_when_activity_changes(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)
    service.create_course("statistics", "[TEST] 医学统计学")
    service.create_project("workspace", "个人知识工作区")
    service.create_wiki("sync-rule", "同步不等于备份。")

    rendered = rebuild_root_index(vault).read_text(encoding="utf-8")

    assert "[TEST] 医学统计学" not in rendered
    assert "projects/<project>/project.md" in rendered
    assert "sync-rule" not in rendered
    assert not (vault / "actions" / "index.md").exists()


def test_today_snapshot_is_a_projection_not_an_authority(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)
    service.create_daily(content="- [ ] #task 今天的任务")
    service.create_capture("临时想法", "稍后处理")
    service.create_project("okf-brain", "OKF Brain")

    snapshot = build_today_snapshot(vault, target_date=NOW.date())

    assert snapshot.daily_path == "life/daily/2026/08/2026-08-17.md"
    assert snapshot.open_tasks == 1
    assert snapshot.open_captures == 1
    assert snapshot.active_projects == ("projects/okf-brain/project.md",)

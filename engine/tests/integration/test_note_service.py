from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from okf_workspace.notes.create import NoteService
from okf_workspace.okf.frontmatter import read_document
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.okf.validator import validate_bundle

NOW = datetime(2026, 8, 17, 14, 32, 5, tzinfo=timezone(timedelta(hours=8)))


def test_human_capture_daily_and_reflection_flow(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)

    daily = service.create_daily(content="今天先完成 OKF 基线。")
    service.append_daily_capture("补充一条真实记录。")
    capture = service.create_capture("课堂速记", "老师讲了检索的召回率。")
    reflection = service.create_reflection("关于长期主义", "维护成本决定系统寿命。")

    assert daily.relative_to(vault).as_posix() == "life/daily/2026/08/2026-08-17.md"
    assert (
        capture.relative_to(vault)
        .as_posix()
        .startswith("inbox/captures/2026/08/2026-08-17-143205-")
    )
    assert reflection.relative_to(vault).as_posix().startswith("life/reflections/2026-08-17-")
    capture_fields = read_document(capture).frontmatter
    assert capture_fields["type"] == "Capture"
    assert capture_fields["ingested_via"] == "direct-entry"
    assert "补充一条真实记录。" in read_document(daily).body
    assert read_document(reflection).frontmatter["type"] == "Reflection"
    assert validate_bundle(vault).valid


def test_course_lesson_project_and_wiki_flow(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)

    course = service.create_course("operating-systems", "操作系统")
    lesson = service.create_lesson(
        course_slug="operating-systems",
        title="进程调度",
        human_notes="课堂上记录：时间片轮转。",
        ai_notes="AI 补充：需要结合上下文切换成本理解。",
    )
    project = service.create_project("workspace", "个人知识工作区")
    log = service.append_project_log("workspace", "完成 Vault 初始化与校验器。")
    knowledge = service.create_wiki(
        "混合检索",
        "混合检索组合关键词与语义召回。",
        sources=[lesson.relative_to(vault).as_posix()],
    )

    assert course.exists()
    lesson_body = read_document(lesson).body
    assert "课堂上记录：时间片轮转。" in lesson_body
    assert '<!-- ai:auto:start name="organized-lesson" -->' in lesson_body
    assert "AI 补充" in lesson_body
    assert project.relative_to(vault).as_posix() == "projects/workspace/project.md"
    log_body = log.read_text(encoding="utf-8")
    assert "完成 Vault 初始化与校验器。" in log_body
    assert log_body.index("该文件按时间记录") < log_body.index(f"## {NOW.date()}")

    document = read_document(knowledge)
    assert "status" not in document.frontmatter
    assert "studied_at" not in document.frontmatter
    assert document.frontmatter["sources"] == [
        {
            "resource": f"/{lesson.relative_to(vault).as_posix()}",
        }
    ]
    assert validate_bundle(vault).valid

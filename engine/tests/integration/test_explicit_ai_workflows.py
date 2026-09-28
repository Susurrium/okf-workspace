from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest

from okf_workspace.ai.workflows import AIInputTooLarge, AIOutputError, ExplicitAIWorkflows
from okf_workspace.git import create_checkpoint, initialize_repository
from okf_workspace.notes import NoteService
from okf_workspace.okf.file_io import FileWriteConflict
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document


class RecordingProvider:
    def __init__(self) -> None:
        self.users: list[str] = []

    def complete(self, *, system: str, user: str) -> str:
        self.users.append(user)
        if "当前状态" in system:
            return "## 当前状态\n\n已记录真实进展。\n\n## 下一步\n\n继续测试。"
        if "课堂" in system:
            return "- 核心概念\n- 待确认：原始缩写"
        if "学习计划" in system:
            return "## 学习目标\n\n- 阅读\n\n## 自测\n\n- 解释核心概念"
        if "知识草稿" in system:
            return "材料共同说明同步不等于备份。"
        if "改写一个 Markdown 章节" in system:
            return "更简洁，但仍保留原始事实。"
        return "1. 问题？\n   > [!answer]- 答案\n   > 来自笔记。"


def test_explicit_ai_workflows_read_named_notes_and_write_only_drafts_or_regions(
    vault: Path,
) -> None:
    notes = NoteService(vault)
    notes.create_project("okf-brain", "OKF Brain")
    notes.append_project_log("okf-brain", "完成本地 API。")
    notes.create_course("statistics", "统计学")
    class_note = notes.create_lesson(
        "statistics",
        "回归",
        human_notes="课堂原始缩写 XYZ，不能覆盖。",
    )
    knowledge = notes.create_wiki("同步与备份", "LiveSync 不能替代备份。")
    second_source = notes.create_wiki("备份方法", "Restic 提供版本化恢复。")
    editable = notes.create_wiki(
        "待编辑笔记",
        "# 待编辑笔记\n\n## 第一节\n\n保留。\n\n## 第二节\n\n原始详细正文。\n",
    )
    initialize_repository(vault)
    create_checkpoint(vault, "initial workflow fixture")
    provider = RecordingProvider()
    workflows = ExplicitAIWorkflows(vault, provider)

    project, project_reads = workflows.summarize_project("okf-brain")
    organized, class_reads = workflows.organize_lesson(class_note.relative_to(vault).as_posix())
    plan, plan_reads = workflows.create_learning_plan(knowledge.relative_to(vault).as_posix())
    before_test = knowledge.read_text(encoding="utf-8")
    test_content, test_reads = workflows.self_test(knowledge.relative_to(vault).as_posix())
    combined, combined_reads = workflows.create_wiki_from_sources(
        "LiveSync 不是备份",
        (
            knowledge.relative_to(vault).as_posix(),
            second_source.relative_to(vault).as_posix(),
        ),
    )
    edited, edited_reads = workflows.rewrite_section(
        editable.relative_to(vault).as_posix(),
        "第二节",
        "写得更简洁",
    )

    assert "已记录真实进展" in project.read_text(encoding="utf-8")
    assert set(project_reads) == {
        "projects/okf-brain/project.md",
        "projects/okf-brain/log.md",
    }
    organized_text = organized.read_text(encoding="utf-8")
    assert "课堂原始缩写 XYZ，不能覆盖" in organized_text
    assert "待确认：原始缩写" in organized_text
    assert class_reads == (class_note.relative_to(vault).as_posix(),)
    plan_document = read_document(plan)
    assert plan_document.type == "Study Guide"
    assert "studied_at" not in plan_document.frontmatter
    assert "<!-- human:notes:start -->\n\n<!-- human:notes:end -->" in plan_document.body
    assert '<!-- ai:auto:start name="study-material" -->\n## 学习目标' in plan_document.body
    assert plan_reads == (knowledge.relative_to(vault).as_posix(),)
    assert "问题" in test_content
    assert test_reads == (knowledge.relative_to(vault).as_posix(),)
    assert knowledge.read_text(encoding="utf-8") == before_test
    assert any("完成本地 API" in user for user in provider.users)
    assert "同步不等于备份" in combined.read_text(encoding="utf-8")
    assert read_document(combined).frontmatter["status"] == "draft"
    assert combined_reads == (
        knowledge.relative_to(vault).as_posix(),
        second_source.relative_to(vault).as_posix(),
    )
    edited_text = edited.read_text(encoding="utf-8")
    assert "## 第一节\n\n保留" in edited_text
    assert "更简洁，但仍保留原始事实" in edited_text
    assert "原始详细正文" not in edited_text
    assert edited_reads == (editable.relative_to(vault).as_posix(),)


class StaticProvider:
    def __init__(self, content: str, on_complete: Callable[[], None] | None = None) -> None:
        self.content = content
        self.on_complete = on_complete
        self.users: list[str] = []

    def complete(self, *, system: str, user: str) -> str:
        self.users.append(user)
        if self.on_complete is not None:
            self.on_complete()
        return self.content


def test_source_material_follows_source_text_and_reports_both_reads(vault: Path) -> None:
    source_path = vault / "sources/records/web/example.md"
    text_path = vault / "sources/text/example.md"
    write_document(
        source_path,
        OkfDocument(
            {"type": "Source", "title": "例子", "text": "/sources/text/example.md"},
            "来源身份卡，不是资料正文。",
        ),
    )
    write_document(
        text_path,
        OkfDocument({"type": "Source Text", "title": "例子正文"}, "实际转换资料。"),
    )
    provider = StaticProvider("## 学习目标\n\n理解资料。")

    target, reads = ExplicitAIWorkflows(vault, provider).create_learning_plan(
        "sources/records/web/example.md"
    )

    assert "实际转换资料" in provider.users[0]
    assert reads == ("sources/records/web/example.md", "sources/text/example.md")
    assert "理解资料" in read_document(target).body


def test_lesson_update_rejects_a_note_changed_during_generation(vault: Path) -> None:
    notes = NoteService(vault)
    notes.create_course("statistics", "统计学")
    lesson = notes.create_lesson("statistics", "回归", human_notes="原始记录")

    def edit_lesson() -> None:
        lesson.write_text(
            lesson.read_text(encoding="utf-8") + "\n用户新写的内容。\n",
            encoding="utf-8",
        )

    provider = StaticProvider("整理后的内容。", edit_lesson)
    with pytest.raises(FileWriteConflict, match="changed during AI generation"):
        ExplicitAIWorkflows(vault, provider).organize_lesson(lesson.relative_to(vault).as_posix())

    assert "用户新写的内容" in lesson.read_text(encoding="utf-8")
    assert "整理后的内容" not in lesson.read_text(encoding="utf-8")


@pytest.mark.parametrize(
    "output", ["", "# 非法一级标题", '<!-- ai:auto:end name="organized-lesson" -->']
)
def test_invalid_ai_output_does_not_change_lesson(vault: Path, output: str) -> None:
    notes = NoteService(vault)
    notes.create_course("statistics", "统计学")
    lesson = notes.create_lesson("statistics", "回归", human_notes="原始记录")
    before = lesson.read_bytes()

    with pytest.raises(AIOutputError, match="AI returned"):
        ExplicitAIWorkflows(vault, StaticProvider(output)).organize_lesson(
            lesson.relative_to(vault).as_posix()
        )

    assert lesson.read_bytes() == before


def test_ai_input_over_budget_fails_before_model_call(vault: Path) -> None:
    note = NoteService(vault).create_wiki("很长的资料", "A" * 200_001)
    provider = StaticProvider("答案")

    with pytest.raises(AIInputTooLarge, match="AI input exceeds"):
        ExplicitAIWorkflows(vault, provider).self_test(note.relative_to(vault).as_posix())

    assert not provider.users


def test_existing_wiki_target_is_rejected_before_generation(vault: Path) -> None:
    notes = NoteService(vault)
    source = notes.create_wiki("来源", "已知资料。")
    existing = notes.create_wiki("目标", "用户现有正文。")
    provider = StaticProvider("新的 AI 正文。")

    with pytest.raises(FileExistsError, match="Wiki target already exists"):
        ExplicitAIWorkflows(vault, provider).create_wiki_from_sources(
            "目标", (source.relative_to(vault).as_posix(),)
        )

    assert not provider.users
    assert "用户现有正文" in existing.read_text(encoding="utf-8")


def test_section_rewrite_rejects_a_note_changed_during_generation(vault: Path) -> None:
    note = NoteService(vault).create_wiki("章节", "## 目标章节\n\n原始内容。")

    def edit_note() -> None:
        note.write_text(note.read_text(encoding="utf-8") + "\n用户追加。\n", encoding="utf-8")

    provider = StaticProvider("AI 改写。", edit_note)
    with pytest.raises(FileWriteConflict, match="changed during AI generation"):
        ExplicitAIWorkflows(vault, provider).rewrite_section(
            note.relative_to(vault).as_posix(), "目标章节", "简化"
        )

    assert "用户追加" in note.read_text(encoding="utf-8")
    assert "AI 改写" not in note.read_text(encoding="utf-8")


def test_project_summary_rejects_a_log_changed_during_generation(vault: Path) -> None:
    notes = NoteService(vault)
    project = notes.create_project("demo", "Demo")
    log = vault / "projects/demo/log.md"

    def edit_log() -> None:
        log.write_text(log.read_text(encoding="utf-8") + "\n用户新进展。\n", encoding="utf-8")

    provider = StaticProvider("## 当前状态\n\n过期摘要。\n\n## 下一步\n\n继续。", edit_log)
    with pytest.raises(FileWriteConflict, match="Project log changed"):
        ExplicitAIWorkflows(vault, provider).summarize_project("demo")

    assert "用户新进展" in log.read_text(encoding="utf-8")
    assert "过期摘要" not in project.read_text(encoding="utf-8")

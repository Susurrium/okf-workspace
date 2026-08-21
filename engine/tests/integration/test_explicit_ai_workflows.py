from __future__ import annotations

from pathlib import Path

from okf_workspace.ai.workflows import ExplicitAIWorkflows
from okf_workspace.git import create_checkpoint, initialize_repository
from okf_workspace.notes import NoteService
from okf_workspace.okf.frontmatter import read_document


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
            return "# 学习计划\n\n- [ ] 阅读\n- [ ] 自测"
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
    assert plan_reads == (knowledge.relative_to(vault).as_posix(),)
    assert "问题" in test_content
    assert test_reads == (knowledge.relative_to(vault).as_posix(),)
    assert knowledge.read_text(encoding="utf-8") == before_test
    assert any("完成本地 API" in user for user in provider.users)
    assert "同步不等于备份" in combined.read_text(encoding="utf-8")
    assert combined_reads == (
        knowledge.relative_to(vault).as_posix(),
        second_source.relative_to(vault).as_posix(),
    )
    edited_text = edited.read_text(encoding="utf-8")
    assert "## 第一节\n\n保留" in edited_text
    assert "更简洁，但仍保留原始事实" in edited_text
    assert "原始详细正文" not in edited_text
    assert edited_reads == (editable.relative_to(vault).as_posix(),)

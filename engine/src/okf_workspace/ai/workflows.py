"""Explicit AI workflows that read named Markdown and write only allowed drafts/regions."""

from __future__ import annotations

from pathlib import Path

from okf_workspace.git import create_checkpoint
from okf_workspace.notes import NoteService
from okf_workspace.notes.organize import read_heading_section
from okf_workspace.okf.frontmatter import read_document
from okf_workspace.okf.paths import resolve_bundle_path

from .provider import ChatProvider
from .writer import AIWriter


class ExplicitAIWorkflows:
    def __init__(self, vault: Path, provider: ChatProvider) -> None:
        self.vault = vault.resolve()
        self.provider = provider

    def summarize_project(self, slug: str) -> tuple[Path, tuple[str, ...]]:
        project = resolve_bundle_path(self.vault, f"projects/{slug}/project.md")
        log = resolve_bundle_path(self.vault, f"projects/{slug}/log.md")
        project_text = project.read_text(encoding="utf-8")
        log_text = log.read_text(encoding="utf-8")
        summary = self.provider.complete(
            system=(
                "根据用户项目主页和日志，生成简洁的 Markdown：必须包含二级标题"
                "“当前状态”和“下一步”。不编造未记录的进度。"
            ),
            user=f"项目主页：\n{project_text}\n\n项目日志：\n{log_text}",
        )
        AIWriter(self.vault).replace_region(
            project.relative_to(self.vault).as_posix(),
            "project-current-state",
            summary,
            actor="explicit-ai",
        )
        return project, (
            project.relative_to(self.vault).as_posix(),
            log.relative_to(self.vault).as_posix(),
        )

    def organize_lesson(self, relative: str) -> tuple[Path, tuple[str, ...]]:
        path = resolve_bundle_path(self.vault, relative)
        document = read_document(path)
        if document.type != "Lesson":
            raise ValueError(f"not a Lesson: {relative}")
        organized = self.provider.complete(
            system=(
                "整理课堂原始记录为 Markdown 提纲。保留不确定性并标注待确认点；"
                "不要修改或假定用户已经理解。"
            ),
            user=document.body,
        )
        AIWriter(self.vault).replace_region(
            relative,
            "organized-lesson",
            organized,
            actor="explicit-ai",
        )
        return path, (relative,)

    def create_learning_plan(self, relative: str) -> tuple[Path, tuple[str, ...]]:
        source = resolve_bundle_path(self.vault, relative)
        document = read_document(source)
        plan = self.provider.complete(
            system=(
                "为给定材料生成可执行学习计划，包含目标、步骤、自测和完成标准。"
                "不要声称用户已经学习。"
            ),
            user=document.body,
        )
        title = str(document.frontmatter.get("title") or source.stem)
        create_checkpoint(self.vault, "checkpoint before AI learning plan")
        target = NoteService(self.vault).create_study_guide(
            f"{title} - 学习计划",
            plan,
            sources=(relative,),
        )
        create_checkpoint(self.vault, f"ai: create learning plan for {relative}")
        return target, (relative,)

    def self_test(self, relative: str) -> tuple[str, tuple[str, ...]]:
        source = resolve_bundle_path(self.vault, relative)
        document = read_document(source)
        questions = self.provider.complete(
            system=(
                "仅基于给定笔记生成 5 道自测题和折叠答案。指出材料中的不确定点。"
                "本操作只返回内容，不修改学习状态。"
            ),
            user=document.body,
        )
        return questions, (relative,)

    def create_wiki_from_sources(
        self,
        title: str,
        source_paths: tuple[str, ...],
        *,
        instruction: str = "",
    ) -> tuple[Path, tuple[str, ...]]:
        """Create one sourced draft after reading every user-selected Markdown file."""

        reads = tuple(dict.fromkeys(path.strip() for path in source_paths if path.strip()))
        if not reads:
            raise ValueError("at least one source path is required")
        if len(reads) > 12:
            raise ValueError("at most 12 source notes may be combined at once")
        materials: list[str] = []
        for relative in reads:
            source = resolve_bundle_path(self.vault, relative)
            document = read_document(source)
            materials.append(f"## 来源：{relative}\n\n{document.body.strip()}")
        content = self.provider.complete(
            system=(
                "仅根据用户明确选择的材料创建一篇可长期维护的 Markdown 知识草稿。"
                "区分一致结论、冲突和不确定性；不要声称用户已经学习、验证或认可。"
                "不要输出 YAML frontmatter 或一级标题；直接输出标题下的正文和二级章节。"
            ),
            user=(
                f"目标标题：{title}\n"
                f"用户补充要求：{instruction.strip() or '无'}\n\n" + "\n\n".join(materials)
            ),
        )
        target = AIWriter(self.vault).create_wiki(title, content, sources=reads)
        return target, reads

    def rewrite_section(
        self,
        relative: str,
        heading: str,
        instruction: str,
    ) -> tuple[Path, tuple[str, ...]]:
        """Rewrite exactly one heading body after reading its current real text."""

        source = resolve_bundle_path(self.vault, relative)
        document = read_document(source)
        current = read_heading_section(document.body, heading)
        replacement = self.provider.complete(
            system=(
                "按照用户要求改写一个 Markdown 章节。只返回章节正文，不返回标题、"
                "frontmatter 或其他章节；保留原文事实和不确定性，不添加未经材料支持的内容。"
            ),
            user=(
                f"笔记：{relative}\n章节：{heading}\n要求：{instruction.strip()}\n\n"
                f"当前章节正文：\n{current}"
            ),
        )
        target = AIWriter(self.vault).replace_section(relative, heading, replacement)
        return target, (relative,)

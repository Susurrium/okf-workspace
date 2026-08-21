# pyright: reportUnknownArgumentType=false, reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from okf_workspace.api import LocalTokenStore, create_app
from okf_workspace.config import BrainPaths, default_template_root
from okf_workspace.dashboard.catalog import scan_notes
from okf_workspace.migration import migrate_current_layout
from okf_workspace.notes import NoteService
from okf_workspace.notes.captures import process_capture
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document
from okf_workspace.okf.relations import inherited_context_fields, normalize_context_reference
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.semantic import (
    SemanticKind,
    SemanticOperationService,
    SemanticOutput,
    SemanticRequest,
)
from okf_workspace.semantic.worker import SemanticWorker


class RelationRunner:
    def generate(self, request: SemanticRequest) -> SemanticOutput:
        return SemanticOutput("## 生成内容\n\n来自明确来源。", request.sources)


def _source(
    vault: Path,
    name: str,
    *,
    course: str | None = None,
    project: str | None = None,
) -> tuple[Path, Path]:
    record = vault / "sources" / "records" / "documents" / f"{name}.md"
    text = vault / "sources" / "text" / "documents" / f"{name}.md"
    fields: dict[str, object] = {
        "type": "Source",
        "title": name,
        "created_at": "2026-08-21T12:00:00+08:00",
        "resource": f"okf-original://{name}",
        "kind": "md",
        "text": f"/{text.relative_to(vault).as_posix()}",
        "purpose": "study",
        "ingested_via": "file-import",
    }
    if course is not None:
        fields["course"] = course
    if project is not None:
        fields["project"] = project
    write_document(record, OkfDocument(fields, f"# {name}\n"))
    write_document(
        text,
        OkfDocument(
            {
                "type": "Source Text",
                "title": f"{name} - 完整正文",
                "created_at": "2026-08-21T12:00:00+08:00",
                "parser": "fixture",
                "sources": [{"resource": f"/{record.relative_to(vault).as_posix()}"}],
            },
            f"# {name}\n\n正文。\n",
        ),
    )
    return record, text


def test_capture_creator_and_api_store_optional_context(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    notes = NoteService(vault)
    course = notes.create_course("networks", "网络课程")
    project = notes.create_project("sync", "同步项目")

    direct = notes.create_capture(
        "关联想法",
        "课程与项目可以同时作为上下文。",
        course="networks",
        project=project.relative_to(vault).as_posix(),
    )
    direct_fields = read_document(direct).frontmatter
    assert direct_fields["course"] == f"/{course.relative_to(vault).as_posix()}"
    assert direct_fields["project"] == f"/{project.relative_to(vault).as_posix()}"

    paths = BrainPaths(vault, tmp_path / "originals", tmp_path / "state")
    token = LocalTokenStore(paths.state).ensure()
    with TestClient(create_app(paths, semantic_enabled=False)) as client:
        response = client.post(
            "/captures",
            headers={"Authorization": f"Bearer {token}"},
            json={
                "title": "API 项目灵感",
                "content": "先进入 Inbox。",
                "project": f"/{project.relative_to(vault).as_posix()}",
            },
        )
    assert response.status_code == 200
    api_capture = read_document(vault / response.json()["path"])
    assert api_capture.frontmatter["project"] == f"/{project.relative_to(vault).as_posix()}"


def test_context_uses_one_source_lineage_and_rejects_malformed_references(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    notes = NoteService(vault)
    course = notes.create_course("only-course", "仅课程")
    project = notes.create_project("only-project", "仅项目")
    course_source, _ = _source(
        vault,
        "course-source",
        course=f"/{course.relative_to(vault).as_posix()}",
    )
    project_source, _ = _source(
        vault,
        "project-source",
        project=f"/{project.relative_to(vault).as_posix()}",
    )

    context = inherited_context_fields(
        vault,
        (
            course_source.relative_to(vault).as_posix(),
            project_source.relative_to(vault).as_posix(),
        ),
    )

    assert context == {"course": f"/{course.relative_to(vault).as_posix()}"}
    with pytest.raises(ValueError, match="single Vault-relative reference"):
        normalize_context_reference(vault, "course", "//invalid")


def test_capture_context_follows_study_guide_and_wiki_without_copying_files(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    notes = NoteService(vault)
    course = notes.create_course("systems", "系统课")
    project = notes.create_project("deploy", "部署项目")
    capture = notes.create_capture(
        "服务发现",
        "需要理解服务发现。",
        course="systems",
        project="deploy",
    )

    guide, archived = process_capture(
        vault,
        capture.relative_to(vault).as_posix(),
        destination="study-guide",
    )
    guide_fields = read_document(guide).frontmatter
    assert guide.relative_to(vault).as_posix().startswith("learning/courses/systems/guides/")
    assert guide_fields["course"] == f"/{course.relative_to(vault).as_posix()}"
    assert guide_fields["project"] == f"/{project.relative_to(vault).as_posix()}"
    assert guide_fields["sources"] == [
        {"resource": f"/{archived.relative_to(vault).as_posix()}"}
    ]
    assert len(list(vault.rglob(f"{guide.name}"))) == 1

    wiki_capture = notes.create_capture("部署参考", "形成以后查用的说明。", project="deploy")
    wiki, _ = process_capture(
        vault,
        wiki_capture.relative_to(vault).as_posix(),
        destination="wiki",
    )
    assert read_document(wiki).frontmatter["project"] == (
        f"/{project.relative_to(vault).as_posix()}"
    )


def test_semantic_generation_inherits_source_context_and_preserves_target_context(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    notes = NoteService(vault)
    source_course = notes.create_course("source-course", "来源课程")
    target_course = notes.create_course("target-course", "目标课程")
    project = notes.create_project("semantic", "语义任务")
    record, text = _source(
        vault,
        "context-source",
        course=f"/{source_course.relative_to(vault).as_posix()}",
        project=f"/{project.relative_to(vault).as_posix()}",
    )
    state = tmp_path / "state"
    service = SemanticOperationService(vault, state)
    service.enqueue(
        SemanticKind.GENERATE_STUDY_GUIDE,
        "learning/guides/context-source.md",
        sources=(record.relative_to(vault).as_posix(), text.relative_to(vault).as_posix()),
    )
    assert SemanticWorker(vault, state, RelationRunner()).run_once()
    generated = read_document(vault / "learning/guides/context-source.md")
    assert generated.frontmatter["course"] == f"/{source_course.relative_to(vault).as_posix()}"
    assert generated.frontmatter["project"] == f"/{project.relative_to(vault).as_posix()}"

    existing = notes.create_study_guide(
        "显式目标",
        "等待更新。",
        course="target-course",
    )
    existing_document = read_document(existing)
    existing_document.frontmatter["sources"] = [
        {"resource": f"/{record.relative_to(vault).as_posix()}"}
    ]
    write_document(existing, existing_document)
    service.enqueue(
        SemanticKind.REFRESH_STUDY_GUIDE,
        existing.relative_to(vault).as_posix(),
        sources=(record.relative_to(vault).as_posix(),),
    )
    assert SemanticWorker(vault, state, RelationRunner()).run_once()
    refreshed = read_document(existing)
    assert refreshed.frontmatter["course"] == f"/{target_course.relative_to(vault).as_posix()}"
    assert refreshed.frontmatter["project"] == f"/{project.relative_to(vault).as_posix()}"

    service.enqueue(
        SemanticKind.GENERATE_WIKI,
        "knowledge/wiki/context-wiki.md",
        sources=(existing.relative_to(vault).as_posix(),),
    )
    assert SemanticWorker(vault, state, RelationRunner()).run_once()
    wiki = read_document(vault / "knowledge/wiki/context-wiki.md")
    assert wiki.frontmatter["course"] == f"/{target_course.relative_to(vault).as_posix()}"
    assert wiki.frontmatter["project"] == f"/{project.relative_to(vault).as_posix()}"


def test_legacy_study_guide_context_is_read_compatible_and_migrated_once(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    project = NoteService(vault).create_project("legacy", "旧项目")
    record, _ = _source(
        vault,
        "legacy-source",
        project=f"/{project.relative_to(vault).as_posix()}",
    )
    guide = vault / "learning" / "guides" / "legacy.md"
    write_document(
        guide,
        OkfDocument(
            {
                "type": "Study Guide",
                "title": "旧学习材料",
                "created_at": "2026-08-21T12:00:00+08:00",
                "sources": [{"resource": f"/{record.relative_to(vault).as_posix()}"}],
            },
            (
                "# 旧学习材料\n\n## 辅助学习材料\n\n"
                '<!-- ai:auto:start name="study-material" -->\n内容\n'
                '<!-- ai:auto:end name="study-material" -->\n\n'
                "## 我的笔记\n\n<!-- human:notes:start -->\n<!-- human:notes:end -->\n"
            ),
        ),
    )

    summary = next(note for note in scan_notes(vault) if note.path == "learning/guides/legacy.md")
    assert summary.project == f"/{project.relative_to(vault).as_posix()}"
    assert "project" not in read_document(guide).frontmatter

    first = migrate_current_layout(vault, default_template_root())
    assert any("inherited Course/Project context" in change for change in first)
    assert read_document(guide).frontmatter["project"] == (
        f"/{project.relative_to(vault).as_posix()}"
    )
    assert migrate_current_layout(vault, default_template_root()) == ()

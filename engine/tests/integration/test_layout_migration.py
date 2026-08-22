from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path

import pytest

from okf_workspace.config import default_template_root
from okf_workspace.migration import migrate_current_layout
from okf_workspace.notes import NoteService
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document
from okf_workspace.okf.paths import slugify
from okf_workspace.okf.templates import VAULT_DYNAMIC_DIRECTORIES, initialize_vault
from okf_workspace.okf.validator import validate_bundle

FIXTURES = Path(__file__).parents[1] / "fixtures"


def test_migration_removes_only_empty_legacy_queue_and_updates_agent_policy(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    (vault / "AGENTS.md").write_text(
        "# old\n\n1. Markdown 是权威内容\n6. Original、密钥、运行状态\n",
        encoding="utf-8",
    )
    write_document(
        vault / "learning" / "queue.md",
        OkfDocument(
            {"type": "Learning Queue", "title": "Learning Queue", "status": "stable"},
            "# Learning Queue\n\n当前没有待学习项目。\n",
        ),
    )

    changes = migrate_current_layout(vault, default_template_root())

    assert "AGENTS.md" in changes
    assert not (vault / "learning" / "queue.md").exists()
    assert list(vault.glob("**/index.md")) == [vault / "index.md"]
    assert "$retrieve-vault-context" in (vault / "AGENTS.md").read_text(encoding="utf-8")


def test_migration_replaces_root_navigation_and_removes_nested_indexes(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    (vault / "learning").mkdir(parents=True, exist_ok=True)
    (vault / "knowledge").mkdir(parents=True, exist_ok=True)
    (vault / "learning/index.md").write_text(
        "# Learning\n\n课程、自主学习、学习计划和队列的入口。\n\n",
        encoding="utf-8",
    )
    (vault / "knowledge/index.md").write_text(
        "# Knowledge\n\nConcept 是长期维护的知识；"
        "Reference 是有价值但不要求已学习的参考；Map 只做导航。\n\n",
        encoding="utf-8",
    )

    changes = migrate_current_layout(vault, default_template_root())

    assert any(change.startswith("learning/index.md") for change in changes)
    assert any(change.startswith("knowledge/index.md") for change in changes)
    assert not (vault / "learning/index.md").exists()
    assert not (vault / "knowledge/index.md").exists()
    root_navigation = (vault / "index.md").read_text(encoding="utf-8")
    assert "# Workspace 总目录" in root_navigation
    assert "### Learning" in root_navigation
    assert 'name="current-activity"' not in root_navigation
    assert "learning_status" not in root_navigation
    knowledge_view = (vault / "system/views/Knowledge.md").read_text(encoding="utf-8")
    assert "generated.at" in knowledge_view
    assert "verified.at" in knowledge_view
    assert "ai_unverified" not in knowledge_view
    assert migrate_current_layout(vault, default_template_root()) == ()


def test_migration_repairs_missing_standard_directories_without_restoring_content(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    removed_top_levels = (
        "feeds",
        "inbox",
        "knowledge",
        "learning",
        "life",
        "projects",
        "sources",
    )
    for top_level in removed_top_levels:
        shutil.rmtree(vault / top_level)
    (vault / "self/decisions").rmdir()
    (vault / "self/hypotheses").rmdir()
    personal_note = vault / "self/private.md"
    personal_note.write_text("keep\n", encoding="utf-8")

    changes = migrate_current_layout(vault, default_template_root())

    assert all((vault / relative).is_dir() for relative in VAULT_DYNAMIC_DIRECTORIES)
    assert personal_note.read_text(encoding="utf-8") == "keep\n"
    assert not (vault / "learning/topics").exists()
    assert not (vault / "sources/extracts").exists()
    assert all(not any((vault / relative).iterdir()) for relative in VAULT_DYNAMIC_DIRECTORIES)
    assert any(change.endswith("(created standard directory)") for change in changes)
    assert migrate_current_layout(vault, default_template_root()) == ()


def test_migration_removes_empty_directory_logs_and_names_project_logs(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    (vault / "log.md").write_text("# Directory Update Log\n\n", encoding="utf-8")
    course = vault / "learning/courses/test"
    course.mkdir(parents=True)
    (course / "log.md").write_text("# Directory Update Log\n\n", encoding="utf-8")
    project = vault / "projects/demo"
    project.mkdir(parents=True)
    write_document(
        project / "project.md",
        OkfDocument(
            {"type": "Project", "title": "演示项目", "status": "stable"},
            "# 演示项目\n",
        ),
    )
    (project / "log.md").write_text(
        "# Directory Update Log\n\n## 2026-08-18\n\n- 已完成基线。\n",
        encoding="utf-8",
    )

    migrate_current_layout(vault, default_template_root())

    assert not (vault / "log.md").exists()
    assert not (course / "log.md").exists()
    project_log = (project / "log.md").read_text(encoding="utf-8")
    assert project_log.startswith("# 演示项目 · 项目日志")
    assert "已完成基线" in project_log


def test_migration_converts_real_legacy_knowledge_and_archives_queue_placeholder(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    concepts = vault / "knowledge" / "concepts"
    references = vault / "knowledge" / "references"
    concepts.mkdir(parents=True, exist_ok=True)
    references.mkdir(parents=True, exist_ok=True)
    write_document(
        concepts / "real.md",
        OkfDocument(
            {
                "type": "Knowledge Concept",
                "title": "真实知识",
                "status": "stable",
                "learning_status": "learned",
            },
            "# 真实知识\n\n这是可长期维护的正文。\n",
        ),
    )
    write_document(
        references / "future.md",
        OkfDocument(
            {
                "type": "Reference",
                "title": "以后可能有用",
                "status": "stable",
                "epistemic_status": "reference",
            },
            "# 以后可能有用\n\n保留来源支持的知识。\n",
        ),
    )
    write_document(
        concepts / "placeholder.md",
        OkfDocument(
            {
                "type": "Knowledge Concept",
                "title": "重复学习占位",
                "status": "stable",
            },
            (
                "# 重复学习占位\n\n## 为什么进入学习队列\n\n旧理由\n\n"
                "## 待学习与验证\n\n- [ ] 阅读 Source Extract，并写下自己的理解\n"
            ),
        ),
    )

    migrate_current_layout(vault, default_template_root())

    real = read_document(vault / "knowledge/wiki/real.md")
    future = read_document(vault / "knowledge/wiki/future.md")
    assert real.type == "Wiki" and real.frontmatter.get("studied_at") is not None
    assert future.type == "Wiki" and "studied_at" not in future.frontmatter
    assert "epistemic_status" not in future.frontmatter
    assert not (vault / "archive/legacy-knowledge/placeholder.md").exists()
    assert not concepts.exists()
    assert not references.exists()


def test_migration_normalizes_contract_v1_data_and_external_state_idempotently(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    state = tmp_path / "state"
    source = vault / "sources/records/ai-daily/example.md"
    extract = vault / "sources/extracts/ai-daily/example.md"
    write_document(
        source,
        OkfDocument(
            {
                "type": "Source",
                "title": "Example source",
                "status": "stable",
                "resource": "https://example.test/item",
                "feed_item_id": "example:1",
            },
            "# Example source\n",
        ),
    )
    write_document(
        extract,
        OkfDocument(
            {
                "type": "Source Extract",
                "title": "Example extract",
                "status": "stable",
                "parser": "legacy",
                "sources": [{"id": "source", "resource": "/sources/records/ai-daily/example.md"}],
            },
            "Legacy extract without an H1.\n",
        ),
    )
    write_document(
        vault / "feeds/ai-daily/2026/legacy.md",
        OkfDocument(
            {
                "type": "Feed Edition",
                "title": "Legacy edition",
                "status": "stable",
                "feed": "ai-daily",
                "edition_id": "legacy",
            },
            "# Legacy edition\n",
        ),
    )
    write_document(
        vault / "learning/topics/legacy.md",
        OkfDocument(
            {
                "type": "Learning Note",
                "title": "Legacy learning",
                "status": "draft",
                "learning_status": "active",
                "study_material_status": "ready",
            },
            (
                "# Legacy learning\n\n## 我的笔记\n\nHuman text.\n\n"
                '## 辅助学习材料\n\n<!-- ai:auto:start name="study-material" -->\n'
                "Material.\n"
                "[[sources/extracts/ai-daily/example#Example extract|legacy text]]\n"
                "[[learning/topics/legacy|legacy guide]]\n"
                '<!-- ai:auto:end name="study-material" -->\n'
            ),
        ),
    )
    write_document(
        vault / "life/daily/2026/08/2026-08-20.md",
        OkfDocument(
            {
                "type": "Daily Note",
                "title": "2026-08-20",
                "status": "stable",
                "date": "2026-08-20",
            },
            "# 2026-08-20\n",
        ),
    )
    wiki_path = vault / "knowledge/wiki/legacy-failed.md"
    write_document(
        wiki_path,
        OkfDocument(
            {
                "type": "Wiki",
                "title": "Legacy failed Wiki",
                "description": "Old scaffold",
                "status": "draft",
                "learning_status": "unlearned",
                "sources": [],
                "generated": {"by": "feed-decision", "at": "2026-08-20T00:00:00+08:00"},
            },
            (
                "# Legacy failed Wiki\n\n"
                '<!-- ai:auto:start name="wiki-content" -->\nRaw feed body.\n'
                '<!-- ai:auto:end name="wiki-content" -->\n'
            ),
        ),
    )
    decision_path = state / "feed-decisions/example.json"
    decision_path.parent.mkdir(parents=True)
    decision_path.write_text(
        json.dumps({"item_id": "example:1", "action": "later"}), encoding="utf-8"
    )
    operation_path = state / "operations/op-failed.json"
    operation_path.parent.mkdir(parents=True)
    operation_path.write_text(
        json.dumps(
            {
                "kind": "distill-wiki",
                "target": "knowledge/wiki/legacy-failed.md",
                "status": "failed",
                "updated_at": "2026-08-20T01:00:00+08:00",
            }
        ),
        encoding="utf-8",
    )

    changes = migrate_current_layout(vault, default_template_root(), state)

    migrated_source = read_document(source)
    assert changes
    assert migrated_source.frontmatter["kind"] == "ai-daily"
    assert migrated_source.frontmatter["text"] == "/sources/text/ai-daily/example.md"
    assert "purpose" not in migrated_source.frontmatter
    assert migrated_source.frontmatter["uses"] == [{"purpose": "undecided"}]
    assert migrated_source.frontmatter["ingested_via"] == "feed"
    assert "status" not in migrated_source.frontmatter
    assert "feed_decision" not in migrated_source.frontmatter
    migrated_text = vault / "sources/text/ai-daily/example.md"
    assert not extract.exists()
    assert read_document(migrated_text).type == "Source Text"
    assert read_document(migrated_text).body.lstrip().startswith("# Example extract")
    migrated_edition = read_document(vault / "feeds/ai-daily/2026/legacy.md")
    assert migrated_edition.type == "Digest"
    assert migrated_edition.frontmatter["feed"] == "ai-daily"
    assert migrated_edition.frontmatter["digest_id"] == "legacy"
    migrated_guide = read_document(vault / "learning/guides/legacy.md")
    assert migrated_guide.type == "Study Guide"
    assert "<!-- human:notes:start -->" in migrated_guide.body
    assert "sources/text/ai-daily/example" in migrated_guide.body
    assert "learning/guides/legacy" in migrated_guide.body
    assert "sources/extracts/" not in migrated_guide.body
    assert "learning/topics/" not in migrated_guide.body
    assert not (vault / "learning/topics/legacy.md").exists()
    daily_body = read_document(vault / "life/daily/2026/08/2026-08-20.md").body
    assert 'name="linked-activity"' in daily_body
    assert 'name="organized-daily"' in daily_body
    assert not wiki_path.exists()
    report = validate_bundle(vault)
    assert report.valid, report.issues
    assert migrate_current_layout(vault, default_template_root(), state) == ()


def test_migration_normalizes_ingestion_channels_and_removes_legacy_fields(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    capture = vault / "inbox/captures/2026/08/2026-08-20-120000-web.md"
    source = vault / "sources/records/documents/manual.md"
    inferred_file = vault / "sources/records/documents/remote-manual.md"
    unknown_source = vault / "sources/records/custom/unknown.md"
    inferred_capture = vault / "inbox/captures/2026/08/2026-08-20-120100-direct.md"
    daily = vault / "life/daily/2026/08/2026-08-20.md"
    write_document(
        capture,
        OkfDocument(
            {
                "type": "Capture",
                "title": "Legacy Web Capture",
                "created_at": "2026-08-20T12:00:00+08:00",
                "capture_status": "open",
                "origin": "web-clipper",
            },
            "# Legacy Web Capture\n",
        ),
    )
    write_document(
        source,
        OkfDocument(
            {
                "type": "Source",
                "title": "Legacy Manual Upload",
                "created_at": "2026-08-20T12:00:00+08:00",
                "resource": "okf-original://sha256/example/manual.pdf",
                "kind": "pdf",
                "purpose": "reference",
                "origin": "manual-upload",
            },
            "# Legacy Manual Upload\n",
        ),
    )
    write_document(
        unknown_source,
        OkfDocument(
            {
                "type": "Source",
                "title": "Unknown Source",
                "created_at": "2026-08-20T12:00:00+08:00",
                "resource": "custom://unknown",
                "kind": "custom",
                "purpose": "reference",
                "origin": "unknown",
            },
            "# Unknown Source\n",
        ),
    )
    write_document(
        inferred_file,
        OkfDocument(
            {
                "type": "Source",
                "title": "Remote Manual Document",
                "created_at": "2026-08-20T12:00:00+08:00",
                "resource": "https://example.test/manual.pdf",
                "kind": "pdf",
                "purpose": "reference",
            },
            "# Remote Manual Document\n",
        ),
    )
    write_document(
        inferred_capture,
        OkfDocument(
            {
                "type": "Capture",
                "title": "Existing Direct Capture",
                "created_at": "2026-08-20T12:01:00+08:00",
                "capture_status": "open",
            },
            "# Existing Direct Capture\n",
        ),
    )
    write_document(
        daily,
        OkfDocument(
            {
                "type": "Daily",
                "title": "2026-08-20",
                "created_at": "2026-08-20T12:00:00+08:00",
                "date": "2026-08-20",
                "origin": "quick-capture",
                "ingested_via": "direct-entry",
            },
            "# 2026-08-20\n",
        ),
    )

    migrate_current_layout(vault, default_template_root())

    capture_fields = read_document(capture).frontmatter
    source_fields = read_document(source).frontmatter
    unknown_fields = read_document(unknown_source).frontmatter
    inferred_file_fields = read_document(inferred_file).frontmatter
    inferred_capture_fields = read_document(inferred_capture).frontmatter
    daily_fields = read_document(daily).frontmatter
    assert capture_fields["ingested_via"] == "web-clip"
    assert "capture_status" not in capture_fields
    assert source_fields["ingested_via"] == "file-import"
    assert "origin" not in unknown_fields and "ingested_via" not in unknown_fields
    assert inferred_file_fields["ingested_via"] == "file-import"
    assert inferred_capture_fields["ingested_via"] == "direct-entry"
    assert "capture_status" not in inferred_capture_fields
    assert "origin" not in capture_fields and "origin" not in source_fields
    assert "origin" not in daily_fields and "ingested_via" not in daily_fields
    assert validate_bundle(vault).valid
    assert migrate_current_layout(vault, default_template_root()) == ()


def test_migration_retires_only_legacy_capture_archive_copies(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    reflection = NoteService(vault).create_reflection("已整理想法", "正文只保留在这里。")
    archived_root = vault / "archive/captures/2026/08"
    processed = archived_root / "2026-08-20-120000-processed.md"
    pending = archived_root / "2026-08-20-120100-pending.md"
    unrelated = vault / "archive/reference.md"
    write_document(
        processed,
        OkfDocument(
            {
                "type": "Capture",
                "title": "已整理想法",
                "created_at": "2026-08-20T12:00:00+08:00",
                "capture_status": "processed",
                "processed_into": [f"/{reflection.relative_to(vault).as_posix()}"],
            },
            "# 已整理想法\n\n正文只保留在这里。\n",
        ),
    )
    write_document(
        pending,
        OkfDocument(
            {
                "type": "Capture",
                "title": "尚未处理",
                "created_at": "2026-08-20T12:01:00+08:00",
                "capture_status": "open",
            },
            "# 尚未处理\n",
        ),
    )
    write_document(
        unrelated,
        OkfDocument(
            {
                "type": "Wiki",
                "title": "Archive 中的非 Capture",
                "created_at": "2026-08-20T12:02:00+08:00",
                "description": "必须保留",
            },
            "# Archive 中的非 Capture\n",
        ),
    )
    reflection_document = read_document(reflection)
    reflection_document.frontmatter["sources"] = [
        {"resource": f"/{processed.relative_to(vault).as_posix()}"}
    ]
    write_document(reflection, reflection_document)

    changes = migrate_current_layout(vault, default_template_root())

    assert not processed.exists()
    restored = vault / "inbox/captures/2026/08" / pending.name
    assert restored.is_file()
    assert "capture_status" not in read_document(restored).frontmatter
    assert "sources" not in read_document(reflection).frontmatter
    assert unrelated.is_file()
    assert any("removed retired Capture copy" in change for change in changes)
    assert migrate_current_layout(vault, default_template_root()) == ()


def test_migration_cleans_the_real_legacy_capture_project_log_shape(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    project = NoteService(vault).create_project("uat-project", "UAT 测试项目")
    log = project.with_name("log.md")
    log.write_text(
        (FIXTURES / "migration/legacy-project-log-capture.md").read_text(encoding="utf-8"),
        encoding="utf-8",
        newline="\n",
    )

    changes = migrate_current_layout(vault, default_template_root())

    rendered = log.read_text(encoding="utf-8")
    duplicate = "测试项目可能需要增加一个状态检查步骤。"
    assert rendered.count(duplicate) == 1
    assert "/archive/captures/" not in rendered
    assert "来源：[Capture]" not in rendered
    assert any(
        change == "projects/uat-project/log.md (removed retired Capture link)"
        for change in changes
    )
    assert migrate_current_layout(vault, default_template_root()) == ()


def test_project_log_capture_cleanup_never_guesses_at_user_repetition(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    project = NoteService(vault).create_project("careful", "Careful")
    log = project.with_name("log.md")
    repeated = "这句话是用户可能有意重复的。"
    log.write_text(
        "# Careful · 项目日志\n\n"
        "## 2026-08-22\n\n"
        f"- {repeated}\n\n"
        f"{repeated}\n\n"
        "这里还有额外正文，所以不能证明上一行是系统重复。\n\n"
        "来源：[Capture](/archive/captures/2026/08/legacy.md)\n\n"
        f"- {repeated}\n\n"
        f"{repeated}\n",
        encoding="utf-8",
        newline="\n",
    )

    migrate_current_layout(vault, default_template_root())

    rendered = log.read_text(encoding="utf-8")
    assert rendered.count(repeated) == 4
    assert "这里还有额外正文" in rendered
    assert "/archive/captures/" not in rendered


def test_migration_does_not_consume_archived_capture_for_unsafe_processed_target(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    outside = tmp_path / "outside.md"
    outside.write_text("must not authorize Capture deletion\n", encoding="utf-8")
    archived = vault / "archive/captures/2026/08/unsafe.md"
    write_document(
        archived,
        OkfDocument(
            {
                "type": "Capture",
                "title": "Unsafe legacy target",
                "created_at": "2026-08-20T12:00:00+08:00",
                "capture_status": "processed",
                "processed_into": ["../../outside.md", "not-a-valid-target"],
            },
            "# Unsafe legacy target\n\nThis content must remain recoverable.\n",
        ),
    )

    migrate_current_layout(vault, default_template_root())

    restored = vault / "inbox/captures/2026/08/unsafe.md"
    assert restored.is_file()
    assert "processed_into" not in read_document(restored).frontmatter
    assert outside.read_text(encoding="utf-8") == "must not authorize Capture deletion\n"


def test_migration_manages_only_web_clipper_integration_directory(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    custom = vault / "system/integrations/custom/user-settings.json"
    stale = vault / "system/integrations/web-clipper/old-template.json"
    custom.parent.mkdir(parents=True, exist_ok=True)
    stale.parent.mkdir(parents=True, exist_ok=True)
    custom.write_text('{"keep": true}\n', encoding="utf-8")
    stale.write_text('{"legacy": true}\n', encoding="utf-8")

    migrate_current_layout(vault, default_template_root())

    assert custom.read_text(encoding="utf-8") == '{"keep": true}\n'
    assert not stale.exists()
    assert (vault / "system/integrations/web-clipper/workspace-web-capture.json").is_file()


def test_migration_normalizes_official_default_web_clippings_without_losing_content(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    clipping = vault / "Clippings/Example article.md"
    original_body = (
        "\n## Selected text\n\nKeep this paragraph and ![remote](https://example.com/a.png).\n"
    )
    default_fields = {
        "title": "Example article",
        "source": "https://example.com/article?ref=clipper",
        "author": ["[[Example Author]]"],
        "published": "2026-08-20",
        "created": "2026-08-22",
        "description": "A useful page",
        "tags": ["clippings", "research"],
        "site_name": "Example",
    }
    write_document(
        clipping,
        OkfDocument(default_fields, original_body),
    )
    video = vault / "Clippings/Example video.md"
    video_body = (
        '\n<iframe src="https://player.example.com/video"></iframe>\n\n## Transcript\n\nWords.\n'
    )
    write_document(
        video,
        OkfDocument(
            {
                **default_fields,
                "title": "Example video",
                "source": "https://example.com/video",
            },
            video_body,
        ),
    )

    changes = migrate_current_layout(vault, default_template_root())

    migrated_paths = list((vault / "inbox/captures/2026/08").glob("*-Example-article.md"))
    assert len(migrated_paths) == 1
    migrated = read_document(migrated_paths[0])
    assert migrated.frontmatter["type"] == "Capture"
    assert migrated.frontmatter["title"] == "Example article"
    assert str(migrated.frontmatter["created_at"]).startswith("2026-08-22T")
    assert migrated.frontmatter["ingested_via"] == "web-clip"
    assert migrated.frontmatter["resource"] == "https://example.com/article?ref=clipper"
    assert migrated.frontmatter["author"] == ["[[Example Author]]"]
    assert migrated.frontmatter["published"] == "2026-08-20"
    assert migrated.frontmatter["description"] == "A useful page"
    assert migrated.frontmatter["tags"] == ["clippings", "research"]
    assert migrated.frontmatter["site_name"] == "Example"
    assert "source" not in migrated.frontmatter
    assert "created" not in migrated.frontmatter
    assert "capture_status" not in migrated.frontmatter
    assert migrated.body == "\n# Example article\n" + original_body
    migrated_video_paths = list((vault / "inbox/captures/2026/08").glob("*-Example-video.md"))
    assert len(migrated_video_paths) == 1
    assert read_document(migrated_video_paths[0]).body == "\n# Example video\n" + video_body
    assert not clipping.exists()
    assert not video.exists()
    assert not (vault / "Clippings").exists()
    assert any(
        change.startswith("Clippings/Example article.md -> inbox/captures/") for change in changes
    )
    assert migrate_current_layout(vault, default_template_root()) == ()


def test_default_web_clipping_migration_is_selective_and_never_overwrites(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    clipping = vault / "Clippings/Conflict.md"
    default_fields = {
        "title": "Conflict",
        "source": "https://example.com/conflict",
        "author": None,
        "published": None,
        "created": "2026-08-22",
        "description": "",
        "tags": ["clippings"],
    }
    write_document(clipping, OkfDocument(default_fields, "\nOriginal clipping body.\n"))
    moment = (
        datetime.fromtimestamp(clipping.stat().st_mtime)
        .astimezone()
        .replace(
            year=2026,
            month=8,
            day=22,
        )
    )
    filename = f"{moment:%Y-%m-%d-%H%M%S}-{slugify('Conflict')}.md"
    occupied = vault / "inbox/captures/2026/08" / filename
    write_document(
        occupied,
        OkfDocument(
            {
                "type": "Capture",
                "title": "Existing capture",
                "created_at": moment.isoformat(timespec="seconds"),
                "ingested_via": "direct-entry",
            },
            "\nMust not be overwritten.\n",
        ),
    )
    manual = vault / "Clippings/Manual.md"
    write_document(
        manual,
        OkfDocument({**default_fields, "title": "Manual", "tags": ["personal"]}, "\nKeep.\n"),
    )
    nested = vault / "Clippings/nested/Nested.md"
    write_document(
        nested,
        OkfDocument({**default_fields, "title": "Nested"}, "\nKeep nested.\n"),
    )

    migrate_current_layout(vault, default_template_root())

    assert read_document(occupied).frontmatter["title"] == "Existing capture"
    alternatives = list(occupied.parent.glob(f"{occupied.stem}-legacy-*.md"))
    assert len(alternatives) == 1
    assert read_document(alternatives[0]).frontmatter["resource"] == "https://example.com/conflict"
    assert not clipping.exists()
    assert manual.is_file()
    assert nested.is_file()


def test_migration_adds_only_missing_source_text_h1_and_is_idempotent(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    missing = vault / "sources/text/web/missing.md"
    original_body = "\nLead paragraph.\n\n## Details\n\nKeep all of this.\n"
    fields = {
        "type": "Source Text",
        "title": "Missing visible title",
        "created_at": "2026-08-22T12:00:00+08:00",
        "parser": "obsidian-web-clipper",
        "sources": [{"resource": "/sources/records/web/missing.md"}],
    }
    write_document(missing, OkfDocument(fields, original_body))
    complete = vault / "sources/text/web/complete.md"
    write_document(
        complete,
        OkfDocument({**fields, "title": "Already complete"}, "\n# Existing H1\n\nBody.\n"),
    )
    complete_before = complete.read_bytes()
    other = vault / "sources/text/web/other.md"
    write_document(
        other,
        OkfDocument({**fields, "type": "Wiki", "title": "Not Source Text"}, "\nNo H1.\n"),
    )
    other_body = read_document(other).body

    changes = migrate_current_layout(vault, default_template_root())

    repaired = read_document(missing)
    assert repaired.body == "\n# Missing visible title\n" + original_body
    assert any(change.endswith("missing.md (added missing Source Text H1)") for change in changes)
    assert complete.read_bytes() == complete_before
    assert read_document(other).body == other_body
    assert migrate_current_layout(vault, default_template_root()) == ()


def test_migration_hides_duplicate_editor_title_surfaces_without_losing_preferences(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    app_path = vault / ".obsidian/app.json"
    app_path.write_text(
        json.dumps(
            {
                "showInlineTitle": True,
                "propertiesInDocument": "visible",
                "readableLineLength": False,
            }
        ),
        encoding="utf-8",
    )

    changes = migrate_current_layout(vault, default_template_root())

    settings = json.loads(app_path.read_text(encoding="utf-8"))
    assert settings["showInlineTitle"] is False
    assert settings["propertiesInDocument"] == "hidden"
    assert settings["readableLineLength"] is False
    assert ".obsidian/app.json" in changes


def test_migration_never_overwrites_invalid_obsidian_app_settings(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    app_path = vault / ".obsidian/app.json"
    original = b'{"showInlineTitle": false,\n'
    app_path.write_bytes(original)

    with pytest.raises(ValueError, match="Cannot migrate invalid JSON"):
        migrate_current_layout(vault, default_template_root())

    assert app_path.read_bytes() == original


def test_migration_syncs_managed_workspace_policies(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    policy = vault / "system/policies/content-boundary.md"
    stale = vault / "system/policies/obsolete-policy.md"
    policy.write_text("outdated\n", encoding="utf-8")
    stale.write_text("obsolete\n", encoding="utf-8")

    migrate_current_layout(vault, default_template_root())

    expected = default_template_root() / "system/policies/content-boundary.md"
    assert policy.read_bytes() == expected.read_bytes()
    assert not stale.exists()


def test_migration_upgrades_interactive_template_yaml_without_replacing_body(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    template = vault / "system/templates/interactive/Reflection.md"
    original = template.read_text(encoding="utf-8")
    legacy = original.replace(
        "created_at:",
        "owner: human:owner\nupdated_at: old\ncreated_at:",
    ).replace("## 我观察到什么", "## 我自己的反思结构")
    template.write_text(legacy, encoding="utf-8")

    migrate_current_layout(vault, default_template_root())

    updated = template.read_text(encoding="utf-8")
    assert "owner:" not in updated
    assert "updated_at:" not in updated
    assert "status: stable" not in updated
    assert "created_at:" in updated
    assert "## 我自己的反思结构" in updated


def test_migration_retires_failed_legacy_operation_whose_placeholder_is_gone(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    state = tmp_path / "state"
    operation = state / "operations/op-old.json"
    operation.parent.mkdir(parents=True)
    operation.write_text(
        json.dumps(
            {
                "schema": 4,
                "operation_id": "op-old",
                "kind": "generate-wiki-draft",
                "target": "knowledge/wiki/missing-placeholder.md",
                "learning_status": "unlearned",
                "status": "failed",
                "updated_at": "2026-08-18T00:00:00+08:00",
            }
        ),
        encoding="utf-8",
    )

    migrate_current_layout(vault, default_template_root(), state)

    retired = json.loads(operation.read_text(encoding="utf-8"))
    assert retired["status"] == "superseded"
    assert "learning_status" not in retired

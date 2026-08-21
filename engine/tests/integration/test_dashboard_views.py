from __future__ import annotations

from datetime import date
from pathlib import Path
from typing import cast

from okf_workspace.dashboard.catalog import scan_notes
from okf_workspace.dashboard.views import dashboard_view, today_view
from okf_workspace.feeds import FeedCache, FeedEdition, FeedItem, FeedKind
from okf_workspace.notes import NoteService
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document


def test_dashboard_projections_are_live_markdown_views_with_stale_reminders(
    vault: Path,
    tmp_path: Path,
) -> None:
    notes = NoteService(vault)
    daily = notes.create_daily(date(2026, 8, 17), content="今天继续构建 OKF Brain。")
    capture = notes.create_capture("待处理想法", "这是一段未整理输入。")
    project = notes.create_project("okf-brain", "OKF Brain")
    project.write_text(
        project.read_text(encoding="utf-8").replace(
            "## 当前状态\n\n## 下一步\n",
            "## 当前状态\n\n本地服务已经部署。\n\n## 下一步\n\n完成生产验收。\n",
        ),
        encoding="utf-8",
    )
    notes.append_project_log("okf-brain", "Dashboard 已接入真实数据。")
    decision = project.parent / "decisions" / "use-okf.md"
    decision.parent.mkdir(parents=True)
    decision.write_text("# 使用 OKF\n", encoding="utf-8")
    output = project.parent / "outputs" / "acceptance.md"
    output.parent.mkdir(parents=True)
    output.write_text("# 验收结果\n", encoding="utf-8")
    processed_capture = notes.create_capture("已手工处理", "保留到批量归档。")
    processed_document = read_document(processed_capture)
    processed_document.frontmatter["capture_status"] = "processed"
    write_document(processed_capture, processed_document)
    stale = notes.create_wiki(
        "旧 VPN 配置",
        "这个配置需要复核。",
        stale_after=date(2026, 8, 1),
    )
    private = notes.create_wiki("公开测试 Wiki", "普通知识。")
    self_note = vault / "self" / "identity.md"
    self_note.parent.mkdir(exist_ok=True)
    self_note.write_text(
        "---\ntype: Self\ntitle: 私密自我笔记\nstatus: stable\n---\n\n私密内容。\n",
        encoding="utf-8",
    )

    today = today_view(vault, tmp_path / "state", date(2026, 8, 17))
    inbox = dashboard_view(vault, "inbox")
    projects = dashboard_view(vault, "projects")
    catalog = scan_notes(vault, today=date(2026, 8, 17))
    project_items = cast(list[dict[str, object]], projects["projects"])
    captures = cast(list[dict[str, object]], inbox["captures"])
    processed = cast(list[dict[str, object]], inbox["processed_captures"])
    stale_knowledge = cast(list[dict[str, object]], today["stale_knowledge"])

    assert today["daily"] == {
        "path": daily.relative_to(vault).as_posix(),
        "exists": True,
    }
    assert today["open_inbox_count"] == 1
    assert cast(dict[str, int], today["inbox_by_ingested_via"])["direct-entry"] == 1
    assert any(item["path"] == project.relative_to(vault).as_posix() for item in project_items)
    assert captures[0]["path"] == capture.relative_to(vault).as_posix()
    assert captures[0]["ingested_via"] == "direct-entry"
    assert processed[0]["path"] == processed_capture.relative_to(vault).as_posix()
    assert project_items[0]["current_state"] == "本地服务已经部署。"
    assert project_items[0]["next_action"] == "完成生产验收。"
    assert "Dashboard 已接入真实数据" in cast(str, project_items[0]["recent_log"])
    assert project_items[0]["decisions"] == [decision.relative_to(vault).as_posix()]
    assert project_items[0]["outputs"] == [output.relative_to(vault).as_posix()]
    assert any(item["path"] == stale.relative_to(vault).as_posix() for item in stale_knowledge)
    assert any(note.path == private.relative_to(vault).as_posix() for note in catalog)
    assert all(not note.path.startswith("self/") for note in catalog)


def test_inbox_derives_channel_and_generation_queues_from_real_sources(vault: Path) -> None:
    undecided = vault / "sources/records/custom/legacy.md"
    study = vault / "sources/records/web/study.md"
    for path, title, purpose, channel in (
        (undecided, "旧来源", "undecided", None),
        (study, "网页学习资料", "study", "web-clip"),
    ):
        fields: dict[str, object] = {
            "type": "Source",
            "title": title,
            "created_at": "2026-08-20T12:00:00+08:00",
            "resource": f"https://example.com/{path.stem}",
            "kind": "web",
            "purpose": purpose,
        }
        if channel is not None:
            fields["ingested_via"] = channel
        write_document(path, OkfDocument(fields, f"# {title}\n"))

    inbox = dashboard_view(vault, "inbox")
    pending = cast(list[dict[str, object]], inbox["pending_generation"])
    counts = cast(dict[str, int], inbox["by_ingested_via"])
    stages = cast(dict[str, int], inbox["stage_counts"])

    assert [item["path"] for item in pending] == [study.relative_to(vault).as_posix()]
    assert counts["web-clip"] == 1
    assert counts["unlabeled"] == 1
    assert stages == {"waiting_decision": 1, "waiting_generation": 1}


def test_dashboard_catalog_excludes_runtime_instruction_files(vault: Path) -> None:
    skill = vault / ".agents" / "skills" / "example" / "SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_text(
        "---\nname: example\ndescription: Runtime only.\n---\n# Runtime skill\n",
        encoding="utf-8",
    )

    catalog = scan_notes(vault)

    assert all(not note.path.startswith(".agents/") for note in catalog)


def test_today_feed_projection_lists_every_stream_from_latest_ai_daily_issue(
    vault: Path,
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    cache = FeedCache(state)
    for edition_date, stream in (
        ("2026-08-16", "news"),
        ("2026-08-17", "learning"),
        ("2026-08-17", "news"),
        ("2026-08-17", "hotspot"),
    ):
        edition_id = f"{edition_date}-{stream}"
        cache.put(
            FeedEdition(
                edition_id=edition_id,
                feed=FeedKind.AI_DAILY,
                edition_at=edition_date,
                title=f"AI Daily {edition_date} · {stream}",
                stream=stream,
                items=(
                    FeedItem(
                        item_id=f"{edition_id}:1",
                        feed=FeedKind.AI_DAILY,
                        edition_id=edition_id,
                        title="测试内容",
                        body="完整 Markdown",
                        stream=stream,
                    ),
                ),
            )
        )

    today = today_view(vault, state, date(2026, 8, 17))
    streams = cast(list[dict[str, object]], today["latest_ai_daily_streams"])

    assert [item["section"] for item in streams] == ["hotspot", "news", "learning"]
    assert {item["issued_at"] for item in streams} == {"2026-08-17"}
    assert all(item["item_count"] == 1 for item in streams)

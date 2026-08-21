from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from typing import cast

from okf_workspace.dashboard.views import dashboard_view, today_view
from okf_workspace.feeds.decisions import FeedDecisionService
from okf_workspace.feeds.models import DecisionAction, FeedItem, FeedKind
from okf_workspace.fixtures import generate_fixture_vault
from okf_workspace.notes import NoteService
from okf_workspace.notes.captures import process_capture
from okf_workspace.okf.frontmatter import read_document
from okf_workspace.retrieval.index import SearchIndex
from okf_workspace.retrieval.search import HybridSearcher

EXPECTED = Path(__file__).parents[1] / "golden" / "expected-projections" / "dashboard.json"


def _titles(items: object) -> list[str]:
    assert isinstance(items, list)
    return [str(cast(dict[str, object], item)["title"]) for item in cast(list[object], items)]


def test_generated_vault_supports_the_full_daily_organize_project_feed_and_search_flow(
    tmp_path: Path,
) -> None:
    vault = generate_fixture_vault(tmp_path / "vault")
    state = tmp_path / "state"
    expected = cast(
        dict[str, dict[str, object]],
        json.loads(EXPECTED.read_text(encoding="utf-8")),
    )

    today = today_view(vault, state, date(2026, 8, 17))
    inbox = dashboard_view(vault, "inbox")
    learning = dashboard_view(vault, "learning")
    projects = dashboard_view(vault, "projects")
    knowledge = dashboard_view(vault, "knowledge")
    life = dashboard_view(vault, "life")

    assert cast(dict[str, object], today["daily"])["exists"] is expected["today"]["daily_exists"]
    assert len(cast(list[object], today["tasks"])) == expected["today"]["task_count"]
    assert _titles(today["active_projects"]) == expected["today"]["active_project_titles"]
    assert today["open_inbox_count"] == expected["today"]["open_inbox_count"]
    assert _titles(inbox["captures"]) == expected["inbox"]["open_titles"]
    assert (
        len(cast(list[object], inbox["processed_captures"])) == expected["inbox"]["processed_count"]
    )
    assert _titles(learning["courses"]) == expected["learning"]["active_course_titles"]
    assert len(cast(list[object], learning["lessons"])) == expected["learning"]["lesson_count"]
    for key, expected_key in (
        ("pending_guides", "pending_guide_count"),
        ("ready_guides", "ready_guide_count"),
        ("completed_guides", "completed_guide_count"),
        ("unstudied_wiki", "unstudied_wiki_count"),
    ):
        assert len(cast(list[object], learning[key])) == expected["learning"][expected_key]
    project_items = cast(list[dict[str, object]], projects["projects"])
    assert _titles(project_items) == expected["projects"]["titles"]
    assert str(expected["projects"]["first_recent_log_contains"]) in str(
        project_items[0]["recent_log"]
    )
    assert (
        len(cast(list[object], project_items[0]["decisions"]))
        == expected["projects"]["first_decision_count"]
    )
    assert len(cast(list[object], knowledge["notes"])) == expected["knowledge"]["note_count"]
    assert len(cast(list[object], life["notes"])) == expected["life"]["note_count"]

    capture = cast(list[dict[str, object]], inbox["captures"])[0]
    target, archived = process_capture(vault, str(capture["path"]), destination="reflection")
    assert target.relative_to(vault).as_posix().startswith("life/reflections/")
    assert "但现在还不确定" in read_document(archived).body
    assert dashboard_view(vault, "inbox")["captures"] == []

    NoteService(vault).append_project_log("workspace", "完成一次端到端操作。")
    refreshed_project = cast(
        list[dict[str, object]], dashboard_view(vault, "projects")["projects"]
    )[0]
    assert "完成一次端到端操作" in str(refreshed_project["recent_log"])

    feed_item = FeedItem(
        item_id="e2e:source-only",
        feed=FeedKind.AI_DAILY,
        edition_id="2026-08-17-news",
        title="只作参考的消息",
        body="这条内容验证只保存来源的明确人工决定。",
        stream="news",
    )
    decision = FeedDecisionService(vault, state).decide(feed_item, DecisionAction.SOURCE_ONLY)
    assert decision.source is not None
    assert read_document(Path(decision.source)).frontmatter["uses"] == [{"purpose": "reference"}]

    index = SearchIndex(vault, state / "brain.sqlite")
    index.sync()
    hits = HybridSearcher(index).search(
        "多个虚拟网卡为什么会冲突",
        scope="technical",
        limit=5,
        refresh_index=False,
    )
    assert any(hit.path.endswith("long-technical-note.md") for hit in hits)

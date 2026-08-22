# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false
# pyright: reportUnknownArgumentType=false

from __future__ import annotations

import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from okf_workspace.api import LocalTokenStore, create_app
from okf_workspace.config import BrainPaths
from okf_workspace.feeds import FeedCache, FeedDecisionService
from okf_workspace.feeds.models import FeedEdition, FeedItem, FeedKind
from okf_workspace.importers import DocumentImporter
from okf_workspace.importers.models import ParserExport, ParserName
from okf_workspace.notes import NoteService
from okf_workspace.okf.frontmatter import read_document

FEED_FIXTURES = Path(__file__).parents[1] / "fixtures" / "feeds"


def _client(
    vault: Path,
    tmp_path: Path,
    *,
    importer: DocumentImporter | None = None,
) -> tuple[TestClient, dict[str, str], BrainPaths]:
    paths = BrainPaths(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
    )
    token = LocalTokenStore(paths.state).ensure()
    return (
        TestClient(create_app(paths, document_importer=importer)),
        {"Authorization": f"Bearer {token}"},
        paths,
    )


class StaticParser:
    parser = ParserName.MINERU

    def convert(
        self,
        source: Path,
        working_directory: Path,
        *,
        timeout_seconds: float = 900.0,
    ) -> ParserExport:
        del source, working_directory, timeout_seconds
        return ParserExport(
            markdown="# API 导入文档\n\n这是通过本地 API 导入的完整正文。",
            assets={},
            parser=ParserName.MINERU,
            parser_version="api-fixture",
        )


def test_system_status_can_force_live_service_probes(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    calls: list[bool] = []

    def status(
        _vault: Path,
        _state: Path,
        *,
        refresh_services: bool = False,
    ) -> dict[str, object]:
        calls.append(refresh_services)
        return {"generated_at": "2026-08-22T00:00:00+08:00", "items": []}

    monkeypatch.setattr("okf_workspace.api.app.system_status", status)
    client, headers, _paths = _client(vault, tmp_path)

    assert client.get("/system/status", headers=headers).status_code == 200
    assert (
        client.get("/system/status?refresh_services=true", headers=headers).status_code
        == 200
    )
    assert calls == [False, True]


def test_loopback_api_auth_today_capture_catalog_and_status_update(
    vault: Path,
    tmp_path: Path,
) -> None:
    client, headers, paths = _client(vault, tmp_path)

    assert client.get("/health").json()["status"] == "ok"
    assert client.get("/today").status_code == 401
    today = client.get("/today?target_date=2026-08-17", headers=headers)
    assert today.status_code == 200
    assert today.json()["daily"]["path"] == "life/daily/2026/08/2026-08-17.md"

    created = client.post(
        "/captures",
        headers=headers,
        json={"title": "API 随手记", "content": "未经整理的原始内容"},
    )
    assert created.status_code == 200
    capture_path = created.json()["path"]
    assert capture_path.startswith("inbox/captures/")
    inbox = client.get("/dashboard/inbox", headers=headers).json()
    assert any(item["title"] == "API 随手记" for item in inbox["captures"])
    recommendation = client.get(f"/captures/{capture_path}/recommend", headers=headers).json()
    assert recommendation["destination"] in {
        "reflection",
        "wiki",
        "study-guide",
        "lesson",
        "project-log",
    }
    discarded = client.post(f"/captures/{capture_path}/discard", headers=headers)
    assert discarded.status_code == 200
    assert discarded.json()["capture_deleted"] == capture_path
    assert client.get("/dashboard/inbox", headers=headers).json()["captures"] == []

    organized_capture = client.post(
        "/captures",
        headers=headers,
        json={"title": "API 整理", "content": "只在目标保留一次。"},
    ).json()["path"]
    organized = client.post(
        "/ai/organize",
        headers=headers,
        json={"path": organized_capture, "destination": "reflection"},
    )
    assert organized.status_code == 200
    assert organized.json() == {
        "created_or_updated": "life/reflections/API-整理.md",
        "capture_deleted": organized_capture,
    }
    assert not (vault / organized_capture).exists()

    batch_paths = []
    for index in range(2):
        response = client.post(
            "/captures",
            headers=headers,
            json={"title": f"批量丢弃 {index}", "content": "仍保留原文"},
        )
        batch_paths.append(response.json()["path"])
    batch = client.post(
        "/captures/batch",
        headers=headers,
        json={"action": "discard", "paths": batch_paths},
    )
    assert batch.status_code == 200
    assert batch.json()["count"] == 2
    assert batch.json()["deleted"] == batch_paths

    reflection = client.post(
        "/reflections",
        headers=headers,
        json={"title": "API 反思", "content": "这是我自己的想法。"},
    )
    assert reflection.json()["path"].startswith("life/reflections/")
    course = client.post(
        "/courses",
        headers=headers,
        json={"title": "API 课程", "slug": "api-course"},
    )
    assert course.json()["path"] == "learning/courses/api-course/course.md"
    class_note = client.post(
        "/lessons",
        headers=headers,
        json={
            "course": "api-course",
            "title": "第一课",
            "content": "未经 AI 修改的课堂原始记录。",
        },
    )
    assert class_note.json()["path"].startswith("learning/courses/api-course/lessons/")
    project = client.post(
        "/projects",
        headers=headers,
        json={"title": "API 项目", "slug": "api-project"},
    )
    assert project.json()["path"] == "projects/api-project/project.md"

    wiki = NoteService(vault).create_wiki("API Wiki", "待学习")
    knowledge = client.post(
        f"/notes/{wiki.relative_to(vault).as_posix()}/fields",
        headers=headers,
        json={"studied": True},
    )
    assert knowledge.status_code == 200
    assert read_document(wiki).frontmatter.get("studied_at") is not None
    notes = client.get("/notes", headers=headers).json()
    assert all(not item["path"].startswith("self/") for item in notes)
    assert "E:\\" not in str(notes)

    synchronized = client.post("/index/sync", headers=headers)
    assert synchronized.status_code == 200
    latest_markdown = max(path.stat().st_mtime for path in vault.rglob("*.md"))
    assert paths.search_database.stat().st_mtime >= latest_markdown


def test_obsidian_renderer_cors_preflight_allows_local_authenticated_api(
    vault: Path,
    tmp_path: Path,
) -> None:
    client, headers, _paths = _client(vault, tmp_path)
    preflight = client.options(
        "/today",
        headers={
            "Origin": "app://obsidian.md",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )

    assert preflight.status_code == 200
    assert preflight.headers["access-control-allow-origin"] == "app://obsidian.md"
    assert "authorization" in preflight.headers["access-control-allow-headers"].casefold()
    response = client.get("/today", headers={**headers, "Origin": "app://obsidian.md"})
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == "app://obsidian.md"

    denied = client.options(
        "/today",
        headers={
            "Origin": "https://untrusted.example",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        },
    )
    assert denied.status_code == 400
    assert "access-control-allow-origin" not in denied.headers


def test_feed_api_lists_previews_opens_and_applies_human_decisions_without_absolute_paths(
    vault: Path,
    tmp_path: Path,
) -> None:
    client, headers, paths = _client(vault, tmp_path)
    item = FeedItem(
        item_id="api-feed-1",
        feed=FeedKind.AI_DAILY,
        edition_id="2026-08-17-news",
        title="Obsidian 工具更新",
        body="完整技术文档与配置指南。",
        stream="news",
    )
    second_item = FeedItem(
        item_id="api-feed-2",
        feed=FeedKind.AI_DAILY,
        edition_id=item.edition_id,
        title="第二条工具更新",
        body="第二条轻量摘要来源正文。",
        stream="news",
    )
    FeedCache(paths.state).put(
        FeedEdition(
            edition_id=item.edition_id,
            feed=item.feed,
            edition_at="2026-08-17",
            title="AI Daily",
            stream="news",
            items=(item, second_item),
        )
    )

    digests = client.get("/feeds/ai-daily/digests", headers=headers)
    assert digests.json()[0]["digest_id"] == item.edition_id
    preview = client.get(f"/feeds/ai-daily/digests/{item.edition_id}", headers=headers)
    assert preview.json()["items"][0]["body"] == item.body
    digest = client.get("/dashboard/feeds/summary", headers=headers).json()
    digest_item = digest["ai_daily"][0]["items"][0]
    assert digest_item["title"] == item.title
    assert digest_item["summary"] == item.body
    assert digest_item["block_id"].startswith("feed-")
    assert "body" not in digest_item
    assert [value["title"] for value in digest["ai_daily"][0]["items"]] == [
        item.title,
        second_item.title,
    ]
    opened = client.post(f"/feeds/ai-daily/digests/{item.edition_id}/open", headers=headers)
    assert opened.json()["vault_path"] == "feeds/ai-daily/2026/2026-08-17-news.md"
    removed_recommendation = client.get(
        f"/feeds/ai-daily/items/{item.item_id}/recommend", headers=headers
    )
    assert removed_recommendation.status_code == 404
    rejected = client.post(
        f"/feeds/ai-daily/items/{item.item_id}/decision",
        headers=headers,
        json={"action": "later"},
    )
    assert rejected.status_code == 422
    store = FeedDecisionService(vault, paths.state).store
    assert store.load(item) is None
    assert not (vault / "sources" / "records" / "ai-daily").exists()

    legacy_path = store.path_for(item)
    legacy_path.parent.mkdir(parents=True, exist_ok=True)
    legacy_source = vault / "sources" / "records" / "ai-daily" / "legacy.md"
    legacy_text = vault / "sources" / "text" / "ai-daily" / "legacy.md"
    legacy_path.write_text(
        json.dumps(
            {
                "item_id": item.item_id,
                "action": "later",
                "outputs": {
                    "item_id": item.item_id,
                    "action": "later",
                    "source": str(legacy_source),
                    "source_text": str(legacy_text),
                },
            }
        ),
        encoding="utf-8",
    )
    recovered = client.get(
        f"/feeds/ai-daily/items/{item.item_id}/decision",
        headers=headers,
    )
    assert recovered.status_code == 200
    assert recovered.json() == {
        "item_id": item.item_id,
        "action": "later",
        "source": "sources/records/ai-daily/legacy.md",
        "source_text": "sources/text/ai-daily/legacy.md",
    }

    deferred = client.post(
        f"/feeds/ai-daily/items/{second_item.item_id}/decision",
        headers=headers,
        json={"action": "learn-later"},
    ).json()
    assert deferred["study_guide"] is None
    deferred_source = read_document(vault / deferred["source"])
    assert deferred_source.frontmatter["uses"] == [{"purpose": "study"}]
    assert "purpose" not in deferred_source.frontmatter
    assert "semantic_operation" not in deferred
    assert (
        client.get(
            f"/feeds/ai-daily/items/{second_item.item_id}/decision",
            headers=headers,
        ).json()["study_guide"]
        == deferred["study_guide"]
    )

    assert client.get("/feeds/ai-daily/auto-mode", headers=headers).status_code == 404


def test_feed_api_syncs_configured_v1_producers(vault: Path, tmp_path: Path) -> None:
    client, headers, paths = _client(vault, tmp_path)
    paths.state.mkdir(exist_ok=True)
    (paths.state / "feed-producers.json").write_text(
        json.dumps(
            {
                "ai-daily": {
                    "payload_path": str(FEED_FIXTURES / "ai-daily-v1.json"),
                    "content_map_path": str(FEED_FIXTURES / "ai-daily-content.json"),
                },
                "treehole": {
                    "payload_path": str(FEED_FIXTURES / "treehole-v1.json"),
                },
            }
        ),
        encoding="utf-8",
    )

    synchronized = client.post("/feeds/sync", headers=headers)

    assert synchronized.status_code == 200
    assert {item["feed"] for item in synchronized.json()} == {"ai-daily", "treehole"}


def test_feed_api_reports_partial_sync_failures_without_losing_successes(
    vault: Path,
    tmp_path: Path,
) -> None:
    client, headers, paths = _client(vault, tmp_path)
    paths.state.mkdir(exist_ok=True)
    issue = json.loads((FEED_FIXTURES / "ai-daily-v1.json").read_text(encoding="utf-8"))
    issue["streams"].append(
        {
            "stream": "learning",
            "channels": [{"items": [{"title": "缺少 artifact_id"}]}],
        }
    )
    issue_path = tmp_path / "partial-ai-daily.json"
    issue_path.write_text(json.dumps(issue, ensure_ascii=False), encoding="utf-8")
    (paths.state / "feed-producers.json").write_text(
        json.dumps(
            {
                "ai-daily": {
                    "payload_path": str(issue_path),
                    "content_map_path": str(FEED_FIXTURES / "ai-daily-content.json"),
                },
                "treehole": {"payload_path": str(FEED_FIXTURES / "treehole-v1.json")},
            }
        ),
        encoding="utf-8",
    )

    response = client.post("/feeds/sync", headers=headers)

    assert response.status_code == 200
    results = response.json()
    assert any(
        item["status"] == "ok"
        and item["feed"] == "ai-daily"
        and item["digest_id"] == "2026-08-17-news"
        for item in results
    )
    assert any(item["status"] == "ok" and item["feed"] == "treehole" for item in results)
    assert any(
        item["status"] == "error"
        and item["feed"] == "ai-daily"
        and item["section"] == "learning"
        and "artifact_id" in item["detail"]
        for item in results
    )


def test_feed_dashboard_selects_each_latest_stream_and_pages_subscriptions_stably(
    vault: Path,
    tmp_path: Path,
) -> None:
    client, headers, paths = _client(vault, tmp_path)
    cache = FeedCache(paths.state)

    def put(stream: str, issued_at: str, *, source_name: str | None = None) -> None:
        edition_id = f"{issued_at}-{stream}"
        cache.put(
            FeedEdition(
                edition_id=edition_id,
                feed=FeedKind.AI_DAILY,
                edition_at=issued_at,
                title=f"{stream} {issued_at}",
                stream=stream,
                items=(
                    FeedItem(
                        item_id=f"ai-daily:{stream}:{issued_at}",
                        feed=FeedKind.AI_DAILY,
                        edition_id=edition_id,
                        title=f"{stream} item {issued_at}",
                        body="完整摘要。",
                        url=f"https://{stream}.example/{issued_at}",
                        stream=stream,
                        source_id="source:weekly" if source_name else None,
                        source_name=source_name,
                        native_section="工具" if source_name else None,
                    ),
                ),
            )
        )

    put("hotspot", "2026-08-20")
    put("news", "2026-08-19")
    put("learning", "2026-08-21", source_name="阮一峰《科技爱好者周刊》")
    put("learning", "2026-08-20")
    put("learning", "2026-08-19")

    summary = client.get("/dashboard/feeds/summary", headers=headers).json()
    assert [(edition["section"], edition["issued_at"]) for edition in summary["ai_daily"]] == [
        ("hotspot", "2026-08-20"),
        ("news", "2026-08-19"),
        ("learning", "2026-08-21"),
    ]

    first = client.get(
        "/dashboard/feeds/subscriptions?limit=2",
        headers=headers,
    ).json()
    assert first["section"] == "learning"
    assert [edition["issued_at"] for edition in first["editions"]] == [
        "2026-08-21",
        "2026-08-20",
    ]
    assert first["has_more"] is True
    assert isinstance(first["next_cursor"], str)
    newest_item = first["editions"][0]["items"][0]
    assert newest_item["source"] == "阮一峰《科技爱好者周刊》"
    assert newest_item["source_id"] == "source:weekly"
    assert newest_item["native_section"] == "工具"
    assert newest_item["decision"] is None
    legacy_item = first["editions"][1]["items"][0]
    assert legacy_item["source"] == "learning.example"
    assert legacy_item["source_id"] == "learning.example"

    put("learning", "2026-08-22")
    second = client.get(
        "/dashboard/feeds/subscriptions",
        headers=headers,
        params={"limit": 2, "cursor": first["next_cursor"]},
    ).json()
    assert [edition["issued_at"] for edition in second["editions"]] == ["2026-08-19"]
    assert second["has_more"] is False
    assert second["next_cursor"] is None

    assert (
        client.get(
            "/dashboard/feeds/subscriptions?limit=0",
            headers=headers,
        ).status_code
        == 422
    )
    assert (
        client.get(
            "/dashboard/feeds/subscriptions?cursor=not-a-valid-cursor",
            headers=headers,
        ).status_code
        == 400
    )


def test_feed_summary_does_not_deserialize_old_large_or_broken_editions(
    vault: Path,
    tmp_path: Path,
) -> None:
    client, headers, paths = _client(vault, tmp_path)
    cache = FeedCache(paths.state)
    news_id = "2026-08-22-news"
    cache.put(
        FeedEdition(
            edition_id=news_id,
            feed=FeedKind.AI_DAILY,
            edition_at="2026-08-22",
            title="最新 AI 资讯",
            stream="news",
            items=(
                FeedItem(
                    item_id="news:latest",
                    feed=FeedKind.AI_DAILY,
                    edition_id=news_id,
                    title="最新资讯",
                    body="摘要",
                    stream="news",
                ),
            ),
        )
    )
    treehole_id = "hot-20260822-1100-observer-test"
    cache.put(
        FeedEdition(
            edition_id=treehole_id,
            feed=FeedKind.TREEHOLE,
            edition_at="2026-08-22",
            title="最新树洞",
            items=(
                FeedItem(
                    item_id="treehole:latest",
                    feed=FeedKind.TREEHOLE,
                    edition_id=treehole_id,
                    title="TreeHole #1",
                    body="正文",
                    pid=1,
                ),
            ),
        )
    )
    broken = "{broken" + ("x" * 200_000)
    (cache.root / "ai-daily" / "zzzz-news.json").write_text(broken, encoding="utf-8")
    (cache.root / "treehole" / "zzzz-old.json").write_text(broken, encoding="utf-8")

    response = client.get("/dashboard/feeds/summary", headers=headers)

    assert response.status_code == 200
    summary = response.json()
    assert summary["ai_daily"][0]["digest_id"] == news_id
    assert summary["treehole"]["digest_id"] == treehole_id


def test_conversion_endpoint_hides_original_and_runtime_paths(vault: Path, tmp_path: Path) -> None:
    client, headers, paths = _client(vault, tmp_path)
    record = paths.state / "conversions" / "conv-test" / "status.json"
    record.parent.mkdir(parents=True)
    record.write_text(
        json.dumps(
            {
                "conversion_id": "conv-test",
                "status": "imported",
                "source_sha256": "secret-hash",
                "original_path": "E:/private/original.pdf",
                "outputs": {
                    "export": "E:/private/runtime/export",
                    "source": str(vault / "sources" / "records" / "documents" / "a.md"),
                },
            }
        ),
        encoding="utf-8",
    )

    response = client.get("/documents/conversions/conv-test", headers=headers)
    payload = response.json()

    assert "original_path" not in payload
    assert "source_sha256" not in payload
    assert "export" not in payload["outputs"]
    assert payload["outputs"]["source"] == "sources/records/documents/a.md"


def test_system_can_list_and_retry_failed_conversions(vault: Path, tmp_path: Path) -> None:
    paths = BrainPaths(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
    )
    importer = DocumentImporter(
        vault=paths.vault,
        originals=paths.originals,
        state=paths.state,
        clients={ParserName.MINERU: StaticParser()},
    )
    client, headers, _paths = _client(vault, tmp_path, importer=importer)
    original = tmp_path / "failed.pdf"
    original.write_bytes(b"synthetic-pdf")
    record = paths.state / "conversions" / "conv-failed" / "status.json"
    record.parent.mkdir(parents=True)
    record.write_text(
        json.dumps(
            {
                "conversion_id": "conv-failed",
                "status": "failed",
                "source_sha256": "private-hash",
                "source_filename": "failed.pdf",
                "original_path": str(original),
                "intent": "wiki",
                "quality": "high",
                "parser": "mineru",
                "course": None,
                "project": None,
                "error": "parser unavailable",
                "outputs": {},
                "created_at": "2026-08-17T00:00:00+00:00",
                "updated_at": "2026-08-17T00:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )

    failures = client.get("/documents/conversions?status=failed", headers=headers)

    assert failures.status_code == 200
    assert failures.json()[0]["source_filename"] == "failed.pdf"
    assert "original_path" not in failures.json()[0]
    retried = client.post(
        "/documents/conversions/conv-failed/retry",
        headers=headers,
        json={"parser": "mineru"},
    )
    assert retried.status_code == 200
    assert retried.json()["status"] == "imported"


def test_document_import_endpoint_accepts_upload_and_returns_vault_relative_results(
    vault: Path,
    tmp_path: Path,
) -> None:
    paths = BrainPaths(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
    )
    importer = DocumentImporter(
        vault=paths.vault,
        originals=paths.originals,
        state=paths.state,
        clients={ParserName.MINERU: StaticParser()},
    )
    token = LocalTokenStore(paths.state).ensure()
    client = TestClient(create_app(paths, document_importer=importer))

    response = client.post(
        "/documents/import",
        headers={"Authorization": f"Bearer {token}"},
        data={"intent": "wiki", "quality": "high", "parser": "auto"},
        files={"file": ("manual.pdf", b"synthetic-pdf", "application/pdf")},
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "imported"
    assert payload["source"].startswith("sources/records/documents/")
    assert payload["source_text"].startswith("sources/text/documents/")
    assert "originals" not in str(payload)
    source = read_document(vault / payload["source"])
    assert source.frontmatter["title"] == "API 导入文档"
    assert source.frontmatter["resource"].endswith("/manual.pdf")

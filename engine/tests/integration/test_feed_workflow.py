from __future__ import annotations

import hashlib
import json
import zipfile
from collections.abc import Callable, Iterator, Mapping
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Event
from typing import cast

import pytest

import okf_workspace.feeds.cache as feed_cache_module
from okf_workspace.dashboard.feeds import subscription_sources_dashboard
from okf_workspace.feeds.cache import FeedCache, FeedEditionIndex
from okf_workspace.feeds.decisions import FeedDecisionService
from okf_workspace.feeds.editions import materialize_edition
from okf_workspace.feeds.models import (
    UNATTRIBUTED_SOURCE_ID,
    DecisionAction,
    FeedComment,
    FeedEdition,
    FeedItem,
    FeedKind,
)
from okf_workspace.feeds.sync import FeedSyncer
from okf_workspace.git import GitCheckpointError, create_checkpoint, initialize_repository
from okf_workspace.notes.web_captures import publish_web_capture
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document


def _ai_item(item_id: str, title: str = "AI 工具更新") -> FeedItem:
    return FeedItem(
        item_id=item_id,
        feed=FeedKind.AI_DAILY,
        edition_id="2026-08-17-news",
        title=title,
        body="# 完整内容\n\n这是完整 Markdown，而不是摘要。",
        url="https://example.test/article",
        published_at="2026-08-17T08:00:00+08:00",
        stream="news",
    )


def _learning_edition(
    issued_at: str,
    source_id: str,
    *,
    source_name: str | None = None,
) -> FeedEdition:
    edition_id = f"{issued_at}-learning"
    return FeedEdition(
        edition_id=edition_id,
        feed=FeedKind.AI_DAILY,
        edition_at=issued_at,
        title=f"订阅阅读 {issued_at}",
        stream="learning",
        items=(
            FeedItem(
                item_id=f"{source_id}:{issued_at}",
                feed=FeedKind.AI_DAILY,
                edition_id=edition_id,
                title=f"条目 {issued_at}",
                body="完整摘要",
                stream="learning",
                source_id=source_id,
                source_name=source_name or source_id,
                native_section="文章",
            ),
        ),
    )


def _web_capture(vault: Path, name: str, *, url: str, body: str) -> Path:
    path = vault / "inbox" / "captures" / "2026" / "08" / f"{name}.md"
    write_document(
        path,
        OkfDocument(
            {
                "type": "Capture",
                "title": "跨渠道资料",
                "created_at": "2026-08-20T10:30:00+08:00",
                "capture_status": "open",
                "ingested_via": "web-clip",
                "resource": url,
            },
            f"# 跨渠道资料\n\n{body}\n",
        ),
    )
    return path


def _no_checkpoint(_vault: Path, _message: str) -> None:
    return None


def test_reading_card_prefers_producer_summary_over_long_body(tmp_path: Path) -> None:
    state = tmp_path / "state"
    edition = FeedEdition(
        edition_id="2026-08-23-learning",
        feed=FeedKind.AI_DAILY,
        edition_at="2026-08-23",
        title="订阅阅读",
        stream="learning",
        items=(
            FeedItem(
                item_id="rss:summary",
                feed=FeedKind.AI_DAILY,
                edition_id="2026-08-23-learning",
                title="带全文的 RSS",
                body=(
                    "**摘要：** 这是卡片应该显示的短摘要。\n\n"
                    "**正文：**\n\n这是很长的完整正文，不应拼进卡片摘要。"
                ),
                url="https://example.test/rss",
                stream="learning",
                source_id="rss-source",
                source_name="RSS 来源",
            ),
        ),
    )
    FeedCache(state).put(edition)

    payload = subscription_sources_dashboard(state)
    sources = cast(list[dict[str, object]], payload["sources"])
    preview = cast(list[dict[str, object]], sources[0]["preview_items"])

    assert preview[0]["summary"] == "这是卡片应该显示的短摘要。"


def test_source_migration_does_not_mark_a_concurrent_unknown_item_complete(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = tmp_path / "state"
    syncer = FeedSyncer(state)
    snapshot_taken = Event()
    allow_snapshot = Event()
    original = syncer.cache.iter_stream_indexes_strict
    call_count = 0

    def delayed_indexes(
        feed: FeedKind,
        stream: str,
    ) -> Iterator[FeedEditionIndex]:
        nonlocal call_count
        snapshot = tuple(original(feed, stream))
        call_count += 1
        if call_count == 1:
            snapshot_taken.set()
            assert allow_snapshot.wait(timeout=5)
        return iter(snapshot)

    monkeypatch.setattr(syncer.cache, "iter_stream_indexes_strict", delayed_indexes)
    with ThreadPoolExecutor(max_workers=1) as executor:
        migration = executor.submit(
            syncer._reconcile_learning_source_ids,  # pyright: ignore[reportPrivateUsage]
            [],
            {"Known Source": "known-source"},
            {},
            migration_inputs_complete=True,
            attempted_source_urls=set(),
            unresolved_url_hashes=(),
        )
        assert snapshot_taken.wait(timeout=5)
        legacy_url = "https://legacy.example/new"
        FeedCache(state).put(
            FeedEdition(
                edition_id="2026-08-23-learning",
                feed=FeedKind.AI_DAILY,
                edition_at="2026-08-23",
                title="并发写入",
                stream="learning",
                items=(
                    FeedItem(
                        item_id="legacy:concurrent",
                        feed=FeedKind.AI_DAILY,
                        edition_id="2026-08-23-learning",
                        title="未归属条目",
                        body="正文",
                        url=legacy_url,
                        stream="learning",
                        source_id="legacy.example",
                    ),
                ),
            )
        )
        allow_snapshot.set()
        migration.result(timeout=5)

    marker = state / "feed-cache/metadata/migrations/ai-daily-learning-source-ids.json"
    assert not marker.exists()


def test_source_identity_generation_changes_when_only_candidate_url_changes(
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    cache = FeedCache(state)

    def edition(url: str) -> FeedEdition:
        return FeedEdition(
            edition_id="2026-08-23-learning",
            feed=FeedKind.AI_DAILY,
            edition_at="2026-08-23",
            title="待迁移来源",
            stream="learning",
            items=(
                FeedItem(
                    item_id="legacy:same-identity",
                    feed=FeedKind.AI_DAILY,
                    edition_id="2026-08-23-learning",
                    title="未归属条目",
                    body="正文",
                    url=url,
                    stream="learning",
                    source_id="legacy.example",
                ),
            ),
        )

    cache.put(edition("https://legacy.example/first"))
    before = cache.stream_source_identity_generation(
        FeedKind.AI_DAILY,
        "learning",
    )

    cache.put(edition("https://legacy.example/second"))
    after = cache.stream_source_identity_generation(
        FeedKind.AI_DAILY,
        "learning",
    )

    assert after != before


def test_source_migration_finishes_with_resolved_and_unresolved_items(
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    cache = FeedCache(state)
    resolved_url = "https://known.example/resolved"
    unresolved_url = "https://unknown.example/unresolved"
    edition = FeedEdition(
        edition_id="2026-08-23-learning",
        feed=FeedKind.AI_DAILY,
        edition_at="2026-08-23",
        title="混合来源",
        stream="learning",
        items=tuple(
            FeedItem(
                item_id=f"ai-daily:learning:{hashlib.sha256(url.encode('utf-8')).hexdigest()[:20]}",
                feed=FeedKind.AI_DAILY,
                edition_id="2026-08-23-learning",
                title=title,
                body="正文",
                url=url,
                stream="learning",
                source_id=UNATTRIBUTED_SOURCE_ID,
            )
            for title, url in (
                ("可识别来源", resolved_url),
                ("无法识别来源", unresolved_url),
            )
        ),
    )
    cache.put(edition)
    syncer = FeedSyncer(state)

    with ThreadPoolExecutor(max_workers=1) as executor:
        migration = executor.submit(
            syncer._reconcile_learning_source_ids,  # pyright: ignore[reportPrivateUsage]
            [],
            {"Known Source": "known-source"},
            {resolved_url: ("known-source", "Known Source")},
            migration_inputs_complete=True,
            attempted_source_urls={resolved_url, unresolved_url},
            unresolved_url_hashes=(hashlib.sha256(unresolved_url.encode("utf-8")).hexdigest(),),
        )
        migration.result(timeout=5)

    migrated = cache.get(FeedKind.AI_DAILY, edition.edition_id)
    assert migrated.items[0].source_id == "known-source"
    assert migrated.items[0].source_name == "Known Source"
    assert migrated.items[1].source_id == UNATTRIBUTED_SOURCE_ID
    marker = json.loads(
        (state / "feed-cache/metadata/migrations/ai-daily-learning-source-ids.json").read_text(
            encoding="utf-8"
        )
    )
    assert marker["unresolved_url_hashes"] == [
        hashlib.sha256(unresolved_url.encode("utf-8")).hexdigest()
    ]


def test_cache_is_outside_vault_and_edition_is_lazy(vault: Path, tmp_path: Path) -> None:
    state = tmp_path / "state"
    edition = FeedEdition(
        edition_id="2026-08-17-news",
        feed=FeedKind.AI_DAILY,
        edition_at="2026-08-17",
        title="AI Daily 2026-08-17 · news",
        stream="news",
        items=(_ai_item("daily:1"),),
    )
    cache_path = FeedCache(state).put(edition)
    expected = vault / "feeds" / "ai-daily" / "2026" / "2026-08-17-news.md"
    assert cache_path.is_file()
    assert not expected.exists()

    actual = materialize_edition(vault, FeedCache(state).get(FeedKind.AI_DAILY, edition.edition_id))

    assert actual == expected
    rendered = actual.read_text(encoding="utf-8")
    assert "这是完整 Markdown，而不是摘要" in rendered
    assert "^feed-" in rendered
    assert not (vault / "sources" / "records" / "ai-daily" / "AI-工具更新.md").exists()
    actual.write_text(rendered + "\n我的阅读批注。\n", encoding="utf-8")
    assert (
        materialize_edition(vault, edition).read_text(encoding="utf-8").endswith("我的阅读批注。\n")
    )


def test_ai_daily_urls_are_safe_links_and_legacy_rows_refresh_in_place(vault: Path) -> None:
    item = FeedItem(
        item_id="daily:wechat",
        feed=FeedKind.AI_DAILY,
        edition_id="2026-08-21-learning",
        title="微信 RSS 条目",
        body="完整正文。\n\n## 正文小节\n\n- 原文：这是正文中的人工说明",
        url="https://mp.weixin.qq.com/s?__biz=abc%3D%3D&idx=1",
        stream="learning",
    )
    edition = FeedEdition(
        edition_id=item.edition_id,
        feed=item.feed,
        edition_at="2026-08-21",
        title="订阅阅读",
        stream="learning",
        items=(item,),
    )
    path = materialize_edition(vault, edition)
    rendered = path.read_text(encoding="utf-8")
    safe_row = "- 原文：[打开原文](<https://mp.weixin.qq.com/s?__biz=abc%3D%3D&idx=1>)"
    assert safe_row in rendered

    legacy_row = "- 原文：https://mp.weixin.qq.com/s?__biz=abc%3D%3D&idx=1"
    path.write_text(
        rendered.replace(safe_row, legacy_row) + "\n我的阅读批注。\n",
        encoding="utf-8",
    )

    refreshed = materialize_edition(vault, edition).read_text(encoding="utf-8")

    assert safe_row in refreshed
    assert legacy_row not in refreshed
    assert "- 原文：这是正文中的人工说明" in refreshed
    assert refreshed.endswith("我的阅读批注。\n")

    manually_edited = refreshed.replace(safe_row, "- 原文：我手工修改的来源说明")
    path.write_text(manually_edited, encoding="utf-8")

    preserved = materialize_edition(vault, edition).read_text(encoding="utf-8")

    assert "- 原文：我手工修改的来源说明" in preserved
    assert safe_row not in preserved


def test_feed_cache_put_atomically_replaces_a_complete_json_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = tmp_path / "state"
    edition = FeedEdition(
        edition_id="2026-08-22-learning",
        feed=FeedKind.AI_DAILY,
        edition_at="2026-08-22",
        title="订阅阅读",
        stream="learning",
        items=(_ai_item("atomic:1"),),
    )
    replacements: list[tuple[Path, Path]] = []
    original_replace = feed_cache_module.os.replace
    expected_target = state / "feed-cache" / FeedKind.AI_DAILY.value / f"{edition.edition_id}.json"

    def replace(source: str | Path, target: str | Path) -> None:
        source_path = Path(source)
        target_path = Path(target)
        if target_path == expected_target:
            assert json.loads(source_path.read_text(encoding="utf-8"))["edition_id"] == (
                edition.edition_id
            )
        replacements.append((source_path, target_path))
        original_replace(source_path, target_path)

    monkeypatch.setattr(feed_cache_module.os, "replace", replace)

    target = FeedCache(state).put(edition)

    assert any(replacement_target == target for _source, replacement_target in replacements)
    assert FeedCache(state).get(FeedKind.AI_DAILY, edition.edition_id).title == edition.title
    assert not list(target.parent.glob("*.tmp"))


def test_latest_pointer_compare_and_write_is_serialized_across_writers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = tmp_path / "state"

    def edition(issued_at: str) -> FeedEdition:
        edition_id = f"{issued_at}-learning"
        return FeedEdition(
            edition_id=edition_id,
            feed=FeedKind.AI_DAILY,
            edition_at=issued_at,
            title=edition_id,
            stream="learning",
            items=(
                FeedItem(
                    item_id=f"item:{issued_at}",
                    feed=FeedKind.AI_DAILY,
                    edition_id=edition_id,
                    title=edition_id,
                    body="正文",
                    stream="learning",
                ),
            ),
        )

    older = edition("2026-08-21")
    newer = edition("2026-08-22")
    older_waiting = Event()
    release_older = Event()
    newer_reached_pointer_write = Event()
    original_write = cast(
        Callable[[Path, Mapping[str, object]], None],
        getattr(feed_cache_module, "_write_json_atomic"),  # noqa: B009
    )

    def delayed_write(path: Path, payload: Mapping[str, object]) -> None:
        if path.parent.name == "latest":
            edition_id = payload.get("edition_id")
            if edition_id == older.edition_id:
                older_waiting.set()
                assert release_older.wait(timeout=5)
            elif edition_id == newer.edition_id:
                newer_reached_pointer_write.set()
        original_write(path, payload)

    monkeypatch.setattr(feed_cache_module, "_write_json_atomic", delayed_write)

    with ThreadPoolExecutor(max_workers=2) as executor:
        older_write = executor.submit(FeedCache(state).put, older)
        assert older_waiting.wait(timeout=5)
        newer_write = executor.submit(FeedCache(state).put, newer)
        try:
            # A writer with no compare/write lock reaches this hook and
            # completes before the delayed older writer, causing rollback.
            if newer_reached_pointer_write.wait(timeout=0.2):
                newer_write.result(timeout=5)
        finally:
            release_older.set()
        older_write.result(timeout=5)
        newer_write.result(timeout=5)

    latest = FeedCache(state).latest_edition(FeedKind.AI_DAILY, stream="learning")
    assert latest is not None and latest.edition_id == newer.edition_id


def test_latest_stream_fallback_skips_broken_candidate_and_repairs_pointer(
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    cache = FeedCache(state)
    edition_id = "2026-08-22-learning"
    cache.put(
        FeedEdition(
            edition_id=edition_id,
            feed=FeedKind.AI_DAILY,
            edition_at="2026-08-22",
            title="有效订阅",
            stream="learning",
            items=(
                FeedItem(
                    item_id="valid:learning",
                    feed=FeedKind.AI_DAILY,
                    edition_id=edition_id,
                    title="有效条目",
                    body="正文",
                    stream="learning",
                ),
            ),
        )
    )
    pointer = cache.root / "latest" / "ai-daily-learning.json"
    pointer.write_text("{broken pointer", encoding="utf-8")
    (cache.root / "ai-daily" / "9999-99-99-learning.json").write_text(
        "{broken highest candidate",
        encoding="utf-8",
    )

    latest = cache.latest_edition(FeedKind.AI_DAILY, stream="learning")

    assert latest is not None and latest.edition_id == edition_id
    repaired = json.loads(pointer.read_text(encoding="utf-8"))
    assert repaired["edition_id"] == edition_id
    assert repaired["edition_at"] == "2026-08-22"


def test_pointer_repair_does_not_rollback_a_concurrent_newer_put(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = tmp_path / "state"

    def edition(issued_at: str) -> FeedEdition:
        edition_id = f"{issued_at}-learning"
        return FeedEdition(
            edition_id=edition_id,
            feed=FeedKind.AI_DAILY,
            edition_at=issued_at,
            title=edition_id,
            stream="learning",
            items=(
                FeedItem(
                    item_id=f"repair:{issued_at}",
                    feed=FeedKind.AI_DAILY,
                    edition_id=edition_id,
                    title=edition_id,
                    body="正文",
                    stream="learning",
                ),
            ),
        )

    older = edition("2026-08-21")
    newer = edition("2026-08-22")
    cache = FeedCache(state)
    cache.put(older)
    pointer = cache.root / "latest" / "ai-daily-learning.json"
    pointer.write_text("{broken pointer", encoding="utf-8")
    repair_ready = Event()
    allow_repair = Event()
    original_update = cast(
        Callable[[FeedCache, FeedEdition], None],
        getattr(FeedCache, "_update_latest"),  # noqa: B009
    )

    def delayed_repair(self: FeedCache, candidate: FeedEdition) -> None:
        if candidate.edition_id == older.edition_id:
            repair_ready.set()
            assert allow_repair.wait(timeout=5)
        original_update(self, candidate)

    monkeypatch.setattr(FeedCache, "_update_latest", delayed_repair)

    with ThreadPoolExecutor(max_workers=1) as executor:
        fallback = executor.submit(
            cache.latest_edition,
            FeedKind.AI_DAILY,
            stream="learning",
        )
        assert repair_ready.wait(timeout=5)
        FeedCache(state).put(newer)
        allow_repair.set()
        fallback_result = fallback.result(timeout=5)

    assert fallback_result is not None and fallback_result.edition_id == older.edition_id
    repaired = json.loads(pointer.read_text(encoding="utf-8"))
    assert repaired["edition_id"] == newer.edition_id
    latest = cache.latest_edition(FeedKind.AI_DAILY, stream="learning")
    assert latest is not None and latest.edition_id == newer.edition_id


def test_feed_cache_reads_items_written_before_source_metadata_existed(tmp_path: Path) -> None:
    state = tmp_path / "state"
    target = state / "feed-cache" / "ai-daily" / "2026-08-18-learning.json"
    target.parent.mkdir(parents=True)
    target.write_text(
        json.dumps(
            {
                "edition_id": "2026-08-18-learning",
                "feed": "ai-daily",
                "edition_at": "2026-08-18",
                "title": "旧订阅缓存",
                "stream": "learning",
                "items": [
                    {
                        "item_id": "legacy:learning:1",
                        "feed": "ai-daily",
                        "edition_id": "2026-08-18-learning",
                        "title": "旧条目",
                        "body": "旧缓存没有新增的来源字段。",
                        "url": "https://legacy.example/item",
                        "stream": "learning",
                    }
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    cache = FeedCache(state)
    item = cache.get(FeedKind.AI_DAILY, "2026-08-18-learning").items[0]

    assert item.source_id is None
    assert item.source_name is None
    assert item.native_section is None
    indexes = list(cache.iter_stream_indexes(FeedKind.AI_DAILY, "learning"))
    assert len(indexes) == 1
    assert indexes[0].items[0].source_id == "source:unattributed"
    sidecar = state / "feed-cache/metadata/ai-daily/2026-08-18-learning.json"
    metadata = json.loads(sidecar.read_text(encoding="utf-8"))
    assert "body" not in json.dumps(metadata)
    metadata["items"][0]["source_id"] = "source:corrupted"
    sidecar.write_text(json.dumps(metadata), encoding="utf-8")

    repaired = list(cache.iter_stream_indexes(FeedKind.AI_DAILY, "learning"))
    assert repaired[0].items[0].source_id == "source:unattributed"


def test_source_catalog_concurrent_puts_do_not_lose_counts(tmp_path: Path) -> None:
    state = tmp_path / "state"
    editions = [
        _learning_edition(f"2026-07-{day:02d}", "source:weekly", source_name="Weekly")
        for day in range(1, 25)
    ]

    with ThreadPoolExecutor(max_workers=8) as executor:
        writes = [executor.submit(FeedCache(state).put, edition) for edition in editions]
        for write in writes:
            write.result(timeout=10)

    cache = FeedCache(state)
    summaries = cache.list_stream_source_summaries(FeedKind.AI_DAILY, "learning")

    assert len(summaries) == 1
    assert summaries[0].source_id == "source:weekly"
    assert summaries[0].edition_count == len(editions)
    assert summaries[0].latest_digest_id == "2026-07-24-learning"
    assert summaries[0].edition_ids == tuple(
        f"2026-07-{day:02d}-learning" for day in range(24, 0, -1)
    )
    catalog = json.loads(
        (state / "feed-cache" / "metadata" / "sources" / "ai-daily" / "learning.json").read_text(
            encoding="utf-8"
        )
    )
    assert catalog["complete"] is True
    assert catalog["version"] == 2
    assert catalog["sources"][0]["edition_ids"] == list(summaries[0].edition_ids)


def test_old_cache_source_catalog_seed_is_bounded_and_backfill_is_async(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = tmp_path / "state"
    cache = FeedCache(state)
    cache.put(_learning_edition("2026-08-20", "source:older"))
    cache.put(_learning_edition("2026-08-22", "source:latest"))
    catalog = state / "feed-cache" / "metadata" / "sources" / "ai-daily" / "learning.json"
    catalog.unlink()
    rebuild_started = Event()
    allow_rebuild = Event()
    rebuild_finished = Event()
    get_calls: list[str] = []
    original_get = FeedCache.get

    def tracking_get(self: FeedCache, feed: FeedKind, edition_id: str) -> FeedEdition:
        get_calls.append(edition_id)
        return original_get(self, feed, edition_id)

    def delayed_rebuild(
        self: FeedCache,
        feed: FeedKind,
        stream: str,
    ) -> tuple[object, ...]:
        del self, feed, stream
        rebuild_started.set()
        assert allow_rebuild.wait(timeout=5)
        rebuild_finished.set()
        return ()

    monkeypatch.setattr(FeedCache, "get", tracking_get)
    monkeypatch.setattr(FeedCache, "rebuild_stream_source_catalog", delayed_rebuild)

    status = cache.stream_source_catalog(FeedKind.AI_DAILY, "learning")

    assert [summary.source_id for summary in status.sources] == ["source:latest"]
    assert status.complete is False
    assert status.indexing is True
    assert get_calls == ["2026-08-22-learning"]
    assert rebuild_started.wait(timeout=5)
    payload = subscription_sources_dashboard(state)
    assert payload["catalog_complete"] is False
    assert payload["catalog_indexing"] is True
    assert payload["total_sources"] == 1
    allow_rebuild.set()
    assert rebuild_finished.wait(timeout=5)


def test_source_catalog_rebuild_recovers_corruption_from_compact_sidecars(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = tmp_path / "state"
    cache = FeedCache(state)
    cache.put(_learning_edition("2026-08-20", "source:alpha", source_name="Alpha"))
    cache.put(_learning_edition("2026-08-21", "source:beta", source_name="Beta"))
    cache.put(_learning_edition("2026-08-22", "source:alpha", source_name="Alpha"))
    catalog = state / "feed-cache" / "metadata" / "sources" / "ai-daily" / "learning.json"
    catalog.write_text("{broken catalog", encoding="utf-8")
    body_reads: list[str] = []
    original_get = FeedCache.get

    def tracking_get(self: FeedCache, feed: FeedKind, edition_id: str) -> FeedEdition:
        body_reads.append(edition_id)
        return original_get(self, feed, edition_id)

    monkeypatch.setattr(FeedCache, "get", tracking_get)

    rebuilt = cache.rebuild_stream_source_catalog(FeedKind.AI_DAILY, "learning")
    summaries = cache.list_stream_source_summaries(FeedKind.AI_DAILY, "learning")

    assert body_reads == []
    assert rebuilt == tuple(summaries)
    assert [(summary.source_id, summary.edition_count) for summary in summaries] == [
        ("source:alpha", 2),
        ("source:beta", 1),
    ]
    assert json.loads(catalog.read_text(encoding="utf-8"))["complete"] is True


def test_v1_source_catalog_is_backfilled_to_complete_v2(tmp_path: Path) -> None:
    state = tmp_path / "state"
    cache = FeedCache(state)
    cache.put(_learning_edition("2026-08-20", "source:older"))
    cache.put(_learning_edition("2026-08-22", "source:latest"))
    catalog_path = state / "feed-cache" / "metadata" / "sources" / "ai-daily" / "learning.json"
    legacy = json.loads(catalog_path.read_text(encoding="utf-8"))
    legacy["version"] = 1
    for source in legacy["sources"]:
        source.pop("edition_ids")
    catalog_path.write_text(json.dumps(legacy), encoding="utf-8")

    first = cache.stream_source_catalog(FeedKind.AI_DAILY, "learning")

    assert first.complete is False
    for _attempt in range(100):
        Event().wait(0.01)
        current = cache.stream_source_catalog(FeedKind.AI_DAILY, "learning")
        if current.complete:
            break
    else:
        pytest.fail("v1 Feed source catalog did not finish its v2 backfill")
    assert [source.source_id for source in current.sources] == [
        "source:latest",
        "source:older",
    ]
    assert json.loads(catalog_path.read_text(encoding="utf-8"))["version"] == 2


def test_source_detail_uses_cataloged_edition_ids_without_history_scan(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = tmp_path / "state"
    cache = FeedCache(state)
    for day in range(1, 25):
        cache.put(_learning_edition(f"2026-07-{day:02d}", "source:weekly"))

    def reject_history_scan(
        self: FeedCache,
        feed: FeedKind,
        stream: str,
    ) -> object:
        del self, feed, stream
        raise AssertionError("source detail must use cataloged edition ids")

    monkeypatch.setattr(FeedCache, "iter_stream_indexes", reject_history_scan)

    editions, has_more, catalog, summary = cache.list_stream_source_page(
        FeedKind.AI_DAILY,
        "learning",
        "source:weekly",
        limit=3,
    )

    assert [edition.edition_id for edition in editions] == [
        "2026-07-24-learning",
        "2026-07-23-learning",
        "2026-07-22-learning",
    ]
    assert has_more is True
    assert catalog.complete is True
    assert summary is not None
    assert summary.edition_count == 24


def test_source_overview_rebuilds_after_latest_body_is_deleted(tmp_path: Path) -> None:
    state = tmp_path / "state"
    cache = FeedCache(state)
    cache.put(_learning_edition("2026-08-20", "source:older"))
    cache.put(_learning_edition("2026-08-22", "source:deleted"))
    (cache.root / "ai-daily" / "2026-08-22-learning.json").unlink()

    payload = subscription_sources_dashboard(state)

    assert payload["catalog_complete"] is True
    assert [
        source["source_id"] for source in cast(list[dict[str, object]], payload["sources"])
    ] == ["source:older"]


def test_source_overview_waits_for_catalog_and_body_to_reach_same_generation(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = tmp_path / "state"
    cache = FeedCache(state)
    cache.put(_learning_edition("2026-08-22", "source:old"))
    writer_entered = Event()
    allow_catalog_update = Event()
    original_update = FeedCache._update_source_catalog_locked  # pyright: ignore[reportPrivateUsage]

    def delayed_update(
        self: FeedCache,
        edition: FeedEditionIndex,
        old_edition: FeedEditionIndex | None,
        *,
        replacing_existing: bool,
        stream_was_empty: bool,
    ) -> bool:
        writer_entered.set()
        assert allow_catalog_update.wait(timeout=5)
        return original_update(
            self,
            edition,
            old_edition,
            replacing_existing=replacing_existing,
            stream_was_empty=stream_was_empty,
        )

    monkeypatch.setattr(FeedCache, "_update_source_catalog_locked", delayed_update)
    replacement = _learning_edition("2026-08-22", "source:new")
    with ThreadPoolExecutor(max_workers=2) as executor:
        writer = executor.submit(cache.put, replacement)
        assert writer_entered.wait(timeout=5)
        reader = executor.submit(subscription_sources_dashboard, state)
        Event().wait(0.05)
        assert reader.done() is False
        allow_catalog_update.set()
        writer.result(timeout=5)
        payload = reader.result(timeout=5)

    sources = cast(list[dict[str, object]], payload["sources"])
    assert [source["source_id"] for source in sources] == ["source:new"]
    assert sources[0]["latest_item_count"] == 1
    assert len(cast(list[object], sources[0]["preview_items"])) == 1


def test_treehole_edition_preserves_metrics_media_and_folded_comments(vault: Path) -> None:
    item = FeedItem(
        item_id="treehole:snapshot-1:123",
        feed=FeedKind.TREEHOLE,
        edition_id="snapshot-1",
        title="TreeHole #123",
        body="洞正文",
        pid=123,
        metrics={"reply_count": 4, "peak_score": 9.5},
        media=("assets/123.jpg",),
        comments=(
            FeedComment(
                text="第一条评论",
                cid=101,
                author="Alice",
                published_at="2026-08-17T08:00:00+08:00",
            ),
            FeedComment(
                text="第二条评论",
                cid=102,
                author="Bob",
                is_original_poster=True,
                reply_to_cid=101,
                reply_to_author="Alice",
                reply_to_text="第一条评论",
            ),
        ),
    )
    edition = FeedEdition(
        edition_id="snapshot-1",
        feed=FeedKind.TREEHOLE,
        edition_at="2026-08-17",
        title="树洞热榜 2026-08-17",
        items=(item,),
    )

    path = materialize_edition(vault, edition)
    rendered = path.read_text(encoding="utf-8")

    assert path.relative_to(vault).as_posix() == "feeds/treehole/2026/snapshot-1.md"
    assert "reply_count: 4" in rendered
    assert "![](assets/123.jpg)" in rendered
    assert "> [!comments]- 已抓取评论 (2 条，默认折叠)" in rendered
    assert "**1. Alice · 2026-08-17 08:00 · CID 101**" in rendered
    assert "**2. Bob · 洞主 · CID 102**" in rendered
    assert "↳ 回复 1. Alice (CID 101)：" in rendered
    assert "^treehole-123" in rendered
    assert rendered.index("^treehole-123") < rendered.index("> [!comments]-")


def test_treehole_data_uri_is_materialized_as_excluded_asset(vault: Path) -> None:
    item = FeedItem(
        item_id="treehole:456",
        feed=FeedKind.TREEHOLE,
        edition_id="snapshot-media",
        title="TreeHole #456",
        body="带图正文",
        pid=456,
        media=("data:image/jpeg;base64,/9j/2Q==",),
    )
    edition = FeedEdition(
        edition_id="snapshot-media",
        feed=FeedKind.TREEHOLE,
        edition_at="2026-08-17",
        title="树洞媒体",
        items=(item,),
    )

    rendered = materialize_edition(vault, edition).read_text(encoding="utf-8")

    assert "data:image" not in rendered
    assert "/sources/assets/treehole-media/snapshot-media/" in rendered
    assets = list((vault / "sources" / "assets" / "treehole-media").rglob("*.jpg"))
    assert len(assets) == 1
    assert assets[0].read_bytes() == b"\xff\xd8\xff\xd9"


def test_existing_treehole_note_refreshes_only_generated_comments(vault: Path) -> None:
    old_item = FeedItem(
        item_id="treehole:legacy:123",
        feed=FeedKind.TREEHOLE,
        edition_id="legacy",
        title="TreeHole #123",
        body="洞正文",
        pid=123,
        comments=(FeedComment(text="旧评论"),),
    )
    old_edition = FeedEdition(
        edition_id="legacy",
        feed=FeedKind.TREEHOLE,
        edition_at="2026-08-17",
        title="树洞旧版评论",
        items=(old_item,),
    )
    path = materialize_edition(vault, old_edition)
    content = path.read_text(encoding="utf-8").replace(
        "> [!comments]- 已抓取评论 (1 条，默认折叠)",
        "> [!note]- 评论 (共 1 条，默认折叠)",
    )
    # Simulate a legacy Digest: its navigation/decision anchor followed the
    # whole comment thread, which made Dashboard jumps land at the bottom.
    content = content.replace("^treehole-123\n\n", "")
    path.write_text(
        content.rstrip() + "\n\n^treehole-123\n\n我的阅读批注。\n",
        encoding="utf-8",
    )
    updated_item = FeedItem(
        item_id=old_item.item_id,
        feed=old_item.feed,
        edition_id=old_item.edition_id,
        title=old_item.title,
        body=old_item.body,
        pid=old_item.pid,
        comments=(FeedComment(text="新评论", cid=9, author="Alice"),),
    )

    materialize_edition(
        vault,
        FeedEdition(
            edition_id=old_edition.edition_id,
            feed=old_edition.feed,
            edition_at=old_edition.edition_at,
            title=old_edition.title,
            items=(updated_item,),
        ),
    )

    rendered = path.read_text(encoding="utf-8")
    assert "[!comments]- 已抓取评论" in rendered
    assert "**1. Alice · CID 9**" in rendered
    assert "新评论" in rendered
    assert "旧评论" not in rendered
    assert rendered.index("^treehole-123") < rendered.index("> [!comments]-")
    assert rendered.endswith("我的阅读批注。\n")


def test_existing_treehole_note_refreshes_managed_metrics_without_rewriting_content(
    vault: Path,
) -> None:
    old_item = FeedItem(
        item_id="treehole:8466293",
        feed=FeedKind.TREEHOLE,
        edition_id="metrics-refresh",
        title="TreeHole #8466293",
        body="洞正文\n\n- 指标：这是正文里的人工记录",
        pid=8466293,
        metrics={"reply_count": 15, "like_count": 43, "favorite_count": 3},
        comments=(FeedComment(text="旧评论"),),
    )
    old_edition = FeedEdition(
        edition_id="metrics-refresh",
        feed=FeedKind.TREEHOLE,
        edition_at="2026-08-21",
        title="树洞指标刷新",
        items=(old_item,),
    )
    path = materialize_edition(vault, old_edition)
    path.write_text(
        path.read_text(encoding="utf-8") + "\n我的阅读批注。\n",
        encoding="utf-8",
    )

    corrected_item = FeedItem(
        item_id=old_item.item_id,
        feed=old_item.feed,
        edition_id=old_item.edition_id,
        title=old_item.title,
        body="同步后的正文不应覆盖现有 Digest",
        pid=old_item.pid,
        metrics={"reply_count": 15, "like_count": 3, "favorite_count": 43},
        comments=old_item.comments,
    )

    materialize_edition(
        vault,
        FeedEdition(
            edition_id=old_edition.edition_id,
            feed=old_edition.feed,
            edition_at=old_edition.edition_at,
            title=old_edition.title,
            items=(corrected_item,),
        ),
    )

    rendered = path.read_text(encoding="utf-8")
    assert "- 指标：favorite_count: 43 · like_count: 3 · reply_count: 15" in rendered
    assert "- 指标：favorite_count: 3 · like_count: 43 · reply_count: 15" not in rendered
    assert "- 指标：这是正文里的人工记录" in rendered
    assert "洞正文" in rendered
    assert "同步后的正文不应覆盖现有 Digest" not in rendered
    assert "旧评论" in rendered
    assert rendered.endswith("我的阅读批注。\n")


def test_treehole_comment_refresh_stays_inside_each_item_section(vault: Path) -> None:
    def item(pid: int, comment: str) -> FeedItem:
        return FeedItem(
            item_id=f"treehole:batch:{pid}",
            feed=FeedKind.TREEHOLE,
            edition_id="multi-item",
            title=f"TreeHole #{pid}",
            body=f"洞正文 {pid}",
            pid=pid,
            comments=(FeedComment(text=comment),),
        )

    edition = FeedEdition(
        edition_id="multi-item",
        feed=FeedKind.TREEHOLE,
        edition_at="2026-08-17",
        title="多条树洞",
        items=(item(1, "旧评论一"), item(2, "旧评论二")),
    )
    path = materialize_edition(vault, edition)
    legacy = path.read_text(encoding="utf-8").replace("[!comments]", "[!note]")
    legacy = legacy.replace("^treehole-1", "^treehole-1\n\n第一条的人工批注。")
    path.write_text(legacy, encoding="utf-8")

    materialize_edition(
        vault,
        FeedEdition(
            edition_id=edition.edition_id,
            feed=edition.feed,
            edition_at=edition.edition_at,
            title=edition.title,
            items=(item(1, "新评论一"), item(2, "新评论二")),
        ),
    )

    rendered = path.read_text(encoding="utf-8")
    assert "## TreeHole #1" in rendered
    assert "## TreeHole #2" in rendered
    assert "洞正文 1" in rendered
    assert "洞正文 2" in rendered
    assert "^treehole-1" in rendered
    assert "^treehole-2" in rendered
    assert rendered.index("^treehole-1") < rendered.index("新评论一")
    assert rendered.index("^treehole-2") < rendered.index("新评论二")
    assert "新评论一" in rendered
    assert "新评论二" in rendered
    assert "第一条的人工批注。" in rendered


def test_retained_treehole_archive_enriches_historical_cache(tmp_path: Path) -> None:
    state = tmp_path / "state"
    cache = FeedCache(state)
    edition = FeedEdition(
        edition_id="historical-batch",
        feed=FeedKind.TREEHOLE,
        edition_at="2026-08-16",
        title="历史树洞批次",
        items=(
            FeedItem(
                item_id="treehole:8456471",
                feed=FeedKind.TREEHOLE,
                edition_id="historical-batch",
                title="TreeHole #8456471",
                body="洞正文",
                pid=8456471,
                comments=(FeedComment(text="旧缓存只有文本"),),
            ),
        ),
    )
    cache.put(edition)
    archive = state / "feed-producer-input" / "treehole" / "historical-batch.zip"
    archive.parent.mkdir(parents=True)
    with zipfile.ZipFile(archive, "w") as bundle:
        bundle.writestr(
            "captures/comments.ndjson",
            json.dumps(
                {
                    "pid": 8456471,
                    "cid": 39015797,
                    "raw": {
                        "text": "结构化评论",
                        "name_tag": "Alice",
                        "is_lz": 1,
                        "comment_id": 39015700,
                        "quote": {
                            "cid": 39015700,
                            "name_tag": "Bob",
                            "text": "上游保留的父评论",
                        },
                    },
                },
                ensure_ascii=False,
            ),
        )
        bundle.writestr("media/index.json", json.dumps({"items": []}))

    assert FeedSyncer(state).refresh_treehole_archives() == 1

    comment = cache.get(FeedKind.TREEHOLE, "historical-batch").items[0].comments[0]
    assert comment.text == "结构化评论"
    assert comment.author == "Alice"
    assert comment.cid == 39015797
    assert comment.is_original_poster is True
    assert comment.reply_to_cid == 39015700
    assert comment.reply_to_author == "Bob"
    assert comment.reply_to_text == "上游保留的父评论"


def test_human_decisions_only_materialize_the_selected_outcome(vault: Path, tmp_path: Path) -> None:
    state = tmp_path / "state"
    initialize_repository(vault)
    create_checkpoint(vault, "initial vault")
    service = FeedDecisionService(vault, state)

    ignored_item = _ai_item("state:ignore")
    ignored = service.decide(ignored_item, DecisionAction.IGNORE)
    assert ignored.source is None
    assert service.store.load(ignored_item)["action"] == "ignore"  # type: ignore[index]

    deferred = service.decide(_ai_item("learn-later:1", "稍后学习主题"), DecisionAction.LEARN_LATER)
    assert deferred.source and Path(deferred.source).is_file()
    assert deferred.source_text and Path(deferred.source_text).is_file()
    assert deferred.study_guide is None
    assert "purpose" not in read_document(Path(deferred.source)).frontmatter

    learned = service.decide(_ai_item("learn:1", "可学习主题"), DecisionAction.LEARN_NOW)
    assert learned.source and Path(learned.source).is_file()
    assert learned.source_text and Path(learned.source_text).is_file()
    assert learned.study_guide and not Path(learned.study_guide).exists()
    assert "purpose" not in read_document(Path(learned.source)).frontmatter

    referenced = service.decide(_ai_item("wiki:1", "值得直接沉淀的主题"), DecisionAction.WIKI_NOW)
    assert referenced.source and Path(referenced.source).is_file()
    assert referenced.wiki and not Path(referenced.wiki).exists()
    assert "purpose" not in read_document(Path(referenced.source)).frontmatter
    assert referenced.study_guide is None

    source_only = service.decide(_ai_item("source:1", "只保留来源"), DecisionAction.SOURCE_ONLY)
    assert source_only.source and Path(source_only.source).is_file()
    assert source_only.study_guide is None
    assert source_only.wiki is None


def test_additional_human_feed_decision_is_reflected_in_an_existing_source(
    vault: Path, tmp_path: Path
) -> None:
    service = FeedDecisionService(vault, tmp_path / "state")
    item = _ai_item("decision-sync:1", "人工判断应保持一致")
    first = service.decide(item, DecisionAction.SOURCE_ONLY, checkpoint=False)
    assert first.source is not None

    service.decide(item, DecisionAction.LEARN_LATER, checkpoint=False)

    source = read_document(Path(first.source))
    stored = service.store.load(item)
    assert "purpose" not in source.frontmatter
    assert source.frontmatter["uses"] == [
        {"purpose": "reference"},
        {"purpose": "study"},
    ]
    assert stored is not None and stored["action"] == "learn-later"


def test_learn_still_materializes_when_git_checkpoint_is_unavailable(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def fail_checkpoint(_repository: Path, _message: str) -> None:
        raise GitCheckpointError("git timed out")

    monkeypatch.setattr("okf_workspace.feeds.decisions.create_checkpoint", fail_checkpoint)
    result = FeedDecisionService(vault, tmp_path / "state").decide(
        _ai_item("learn-without-git", "Git 异常时仍然学习"),
        DecisionAction.LEARN_NOW,
    )

    assert result.source and Path(result.source).is_file()
    assert result.source_text and Path(result.source_text).is_file()
    assert result.study_guide and not Path(result.study_guide).exists()
    assert len(result.warnings) == 2


def test_web_then_feed_reuses_source_and_idempotently_appends_feed_details(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "okf_workspace.notes.web_captures._checkpoint",
        _no_checkpoint,
    )
    capture = _web_capture(
        vault,
        "web-first",
        url="https://example.test/shared?id=7&utm_source=browser#top",
        body="## 网页正文\n\n只存在于网页剪藏的正文。",
    )
    published = publish_web_capture(
        vault,
        capture.relative_to(vault).as_posix(),
        intent="source",
    )
    source_before = read_document(published.source)
    text_before = read_document(published.source_text)
    item = FeedItem(
        item_id="treehole:shared:7",
        feed=FeedKind.TREEHOLE,
        edition_id="shared-edition",
        title="跨渠道 Feed 条目",
        body="只存在于 Feed 的正文。",
        url="https://example.test/shared?id=7&utm_medium=feed#comments",
        comments=(FeedComment(text="只存在于 Feed 的评论。", cid=7, author="Alice"),),
    )
    service = FeedDecisionService(vault, tmp_path / "state")

    first = service.decide(item, DecisionAction.SOURCE_ONLY, checkpoint=False)
    first_text = read_document(published.source_text)
    second = service.decide(item, DecisionAction.SOURCE_ONLY, checkpoint=False)
    second_text = read_document(published.source_text)

    assert Path(first.source or "") == published.source
    assert Path(first.source_text or "") == published.source_text
    assert second.source == first.source and second.source_text == first.source_text
    assert not any((vault / "sources/records/treehole").glob("*.md"))
    source_after = read_document(published.source)
    assert source_after.frontmatter["ingested_via"] == "web-clip"
    assert source_after.frontmatter["kind"] == "web"
    assert source_after.frontmatter["resource"] == source_before.frontmatter["resource"]
    assert source_after.body == source_before.body
    assert first_text.frontmatter["parser"] == text_before.frontmatter["parser"]
    assert first_text.frontmatter["sources"] == text_before.frontmatter["sources"]
    assert "只存在于网页剪藏的正文" in second_text.body
    assert second_text.body.count("只存在于 Feed 的正文") == 1
    assert second_text.body.count("只存在于 Feed 的评论") == 1
    assert second_text.body.count("<!-- okf:feed-item:start") == 1
    assert second_text.body == first_text.body


def test_feed_then_web_reuses_source_without_replacing_feed_text(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(
        "okf_workspace.notes.web_captures._checkpoint",
        _no_checkpoint,
    )
    item = FeedItem(
        item_id="treehole:feed-first:8",
        feed=FeedKind.TREEHOLE,
        edition_id="feed-first-edition",
        title="先由 Feed 收录",
        body="Feed 首次保存的独有正文。",
        url="https://example.test/feed-first?id=8",
        comments=(FeedComment(text="Feed 首次保存的独有评论。", cid=8),),
    )
    feed_result = FeedDecisionService(vault, tmp_path / "state").decide(
        item,
        DecisionAction.SOURCE_ONLY,
        checkpoint=False,
    )
    assert feed_result.source is not None and feed_result.source_text is not None
    source_path = Path(feed_result.source)
    text_path = Path(feed_result.source_text)
    source_before = read_document(source_path)
    text_before = read_document(text_path)
    capture = _web_capture(
        vault,
        "feed-first-web",
        url="https://example.test/feed-first?id=8&utm_source=browser#selection",
        body="## 选中内容\n\nWeb 后续补充的独有选区。",
    )

    published = publish_web_capture(
        vault,
        capture.relative_to(vault).as_posix(),
        intent="source",
    )
    repeated_capture = _web_capture(
        vault,
        "feed-first-web-again",
        url="https://example.test/feed-first?id=8&utm_campaign=again#selection",
        body="## 选中内容\n\nWeb 后续补充的独有选区。",
    )
    publish_web_capture(
        vault,
        repeated_capture.relative_to(vault).as_posix(),
        intent="source",
    )

    assert published.reused is True
    assert published.source == source_path and published.source_text == text_path
    source_after = read_document(source_path)
    text_after = read_document(text_path)
    assert source_after.frontmatter["ingested_via"] == "feed"
    assert source_after.frontmatter["kind"] == "treehole"
    assert source_after.frontmatter["resource"] == item.url
    assert source_after.body == source_before.body
    assert text_after.frontmatter["parser"] == text_before.frontmatter["parser"]
    assert text_after.frontmatter["sources"] == text_before.frontmatter["sources"]
    assert "Feed 首次保存的独有正文" in text_after.body
    assert "Feed 首次保存的独有评论" in text_after.body
    assert text_after.body.count("Web 后续补充的独有选区") == 1
    assert text_after.body.count("<!-- okf:web-clip:start") == 1

    text_after.body += "\n人工补充的独有批注。\n"
    write_document(text_path, text_after)
    service = FeedDecisionService(vault, tmp_path / "state")
    service.decide(item, DecisionAction.LEARN_NOW, checkpoint=False)
    service.decide(item, DecisionAction.WIKI_NOW, checkpoint=False)
    final = read_document(text_path)
    assert final.body.count("Web 后续补充的独有选区") == 1
    assert final.body.count("人工补充的独有批注") == 1
    assert final.body.count("Feed 首次保存的独有正文") == 1
    assert final.body.count("Feed 首次保存的独有评论") == 1


@pytest.mark.parametrize(
    ("text_link", "linked_type"),
    [
        ("/knowledge/wiki/not-source-text.md", "Wiki"),
        ("/sources/text/custom/not-source-text.md", "Wiki"),
        ("/sources/text/custom/missing.md", None),
    ],
)
def test_feed_refuses_unsafe_or_invalid_reused_source_text(
    vault: Path,
    tmp_path: Path,
    text_link: str,
    linked_type: str | None,
) -> None:
    source = vault / "sources/records/custom/shared.md"
    write_document(
        source,
        OkfDocument(
            {
                "type": "Source",
                "title": "Existing Source",
                "created_at": "2026-08-20T10:30:00+08:00",
                "resource": "https://example.test/unsafe-shared",
                "kind": "custom",
                "text": text_link,
                "purpose": "reference",
                "ingested_via": "web-clip",
            },
            "# Existing Source\n",
        ),
    )
    linked = vault / text_link.removeprefix("/")
    if linked_type is not None:
        write_document(
            linked,
            OkfDocument(
                {
                    "type": linked_type,
                    "title": "Do not overwrite",
                    "created_at": "2026-08-20T10:30:00+08:00",
                    **({"description": "Wrong target"} if linked_type == "Wiki" else {}),
                },
                "# Do not overwrite\n\n人工内容。\n",
            ),
        )
    source_bytes = source.read_bytes()
    linked_bytes = linked.read_bytes() if linked.is_file() else None
    item = _ai_item("unsafe-reuse", "不安全复用")
    item = FeedItem(
        item_id=item.item_id,
        feed=item.feed,
        edition_id=item.edition_id,
        title=item.title,
        body=item.body,
        url="https://example.test/unsafe-shared#feed",
    )
    service = FeedDecisionService(vault, tmp_path / "state")

    with pytest.raises(ValueError, match="Source Text"):
        service.decide(item, DecisionAction.SOURCE_ONLY, checkpoint=False)

    assert source.read_bytes() == source_bytes
    assert (linked.read_bytes() if linked.is_file() else None) == linked_bytes
    assert not any((vault / "sources/records/ai-daily").glob("*.md"))
    assert service.store.load(item) is None


@pytest.mark.parametrize("url", [None, "feed://custom/item", "mailto:test@example.test"])
def test_non_http_feed_resource_keeps_feed_specific_publication(
    vault: Path,
    tmp_path: Path,
    url: str | None,
) -> None:
    item = FeedItem(
        item_id=f"non-http:{url}",
        feed=FeedKind.AI_DAILY,
        edition_id="non-http-edition",
        title="非网页 Feed",
        body="保持原有 Feed 发布路径。",
        url=url,
    )
    result = FeedDecisionService(vault, tmp_path / "state").decide(
        item,
        DecisionAction.SOURCE_ONLY,
        checkpoint=False,
    )

    assert result.source is not None and result.source_text is not None
    assert Path(result.source).relative_to(vault).as_posix().startswith("sources/records/ai-daily/")
    source = read_document(Path(result.source))
    text = read_document(Path(result.source_text))
    expected = url or f"feed://ai-daily/{item.item_id}"
    assert source.frontmatter["resource"] == expected
    assert source.frontmatter["ingested_via"] == "feed"
    assert text.frontmatter["parser"] == "feed-cache"


def test_cross_channel_feed_pair_rolls_back_when_source_write_fails(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = vault / "sources/records/web/rollback-shared.md"
    source_text = vault / "sources/text/web/rollback-shared.md"
    write_document(
        source,
        OkfDocument(
            {
                "type": "Source",
                "title": "Rollback Shared",
                "created_at": "2026-08-20T10:30:00+08:00",
                "resource": "https://example.test/rollback-shared",
                "kind": "web",
                "text": "/sources/text/web/rollback-shared.md",
                "purpose": "reference",
                "ingested_via": "web-clip",
            },
            "# Rollback Shared\n",
        ),
    )
    write_document(
        source_text,
        OkfDocument(
            {
                "type": "Source Text",
                "title": "Rollback Shared - 完整正文",
                "created_at": "2026-08-20T10:30:00+08:00",
                "parser": "obsidian-web-clipper",
                "sources": [{"resource": "/sources/records/web/rollback-shared.md"}],
            },
            "# Rollback Shared\n\n原始网页正文。\n",
        ),
    )
    previous_source = source.read_bytes()
    previous_text = source_text.read_bytes()
    from okf_workspace.sources import publisher as source_publisher

    original_write = source_publisher.write_document
    calls = 0

    def fail_source_write(
        path: Path,
        document: OkfDocument,
        *,
        create_only: bool = False,
        expected_sha256: str | None = None,
    ) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("simulated Source write failure")
        original_write(path, document, create_only=create_only, expected_sha256=expected_sha256)

    monkeypatch.setattr(source_publisher, "write_document", fail_source_write)
    service = FeedDecisionService(vault, tmp_path / "state")
    item = FeedItem(
        item_id="rollback-shared",
        feed=FeedKind.AI_DAILY,
        edition_id="rollback-edition",
        title="Rollback Shared",
        body="不能留下半次追加。",
        url="https://example.test/rollback-shared#feed",
    )

    with pytest.raises(OSError, match="simulated"):
        service.decide(item, DecisionAction.SOURCE_ONLY, checkpoint=False)

    assert source.read_bytes() == previous_source
    assert source_text.read_bytes() == previous_text
    assert service.store.load(item) is None

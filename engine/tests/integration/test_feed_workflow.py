from __future__ import annotations

import json
import zipfile
from pathlib import Path

import pytest

from okf_workspace.feeds.cache import FeedCache
from okf_workspace.feeds.decisions import FeedDecisionService
from okf_workspace.feeds.editions import materialize_edition
from okf_workspace.feeds.models import DecisionAction, FeedComment, FeedEdition, FeedItem, FeedKind
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
            FeedComment(text="第二条评论", cid=102, author="Bob", is_original_poster=True),
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
    assert "^treehole-123" in rendered


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
    path.write_text(content + "\n我的阅读批注。\n", encoding="utf-8")
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
                    "raw": {"text": "结构化评论", "name_tag": "Alice", "is_lz": 1},
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

    def fail_source_write(path: Path, document: OkfDocument) -> None:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("simulated Source write failure")
        original_write(path, document)

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

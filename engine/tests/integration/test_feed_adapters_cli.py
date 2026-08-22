from __future__ import annotations

import json
from pathlib import Path
from typing import cast

import pytest

from okf_workspace.cli import main
from okf_workspace.feeds.adapters import (
    ai_daily_from_v1,
    ai_daily_markdown_from_v1,
    treehole_from_v1,
)
from okf_workspace.feeds.cache import FeedCache
from okf_workspace.feeds.models import FeedKind
from okf_workspace.feeds.remote import RemoteFeedPuller
from okf_workspace.feeds.sync import FeedSyncer

FIXTURES = Path(__file__).parents[1] / "fixtures" / "feeds"


def _object(path: Path) -> dict[str, object]:
    loaded = cast(object, json.loads(path.read_text(encoding="utf-8")))
    assert isinstance(loaded, dict)
    return cast(dict[str, object], loaded)


def test_v1_payload_adapters_preserve_full_content_pid_metrics_and_media() -> None:
    content = {
        str(key): str(value) for key, value in _object(FIXTURES / "ai-daily-content.json").items()
    }
    ai_daily = ai_daily_from_v1(
        _object(FIXTURES / "ai-daily-v1.json"),
        content_by_artifact=content,
    )[0]
    treehole = treehole_from_v1(_object(FIXTURES / "treehole-v1.json"))

    assert ai_daily.items[0].body.startswith("# 本地 AI 工具")
    assert ai_daily.items[0].url == "https://example.test/ai-tool"
    assert treehole.items[0].pid == 12345
    assert treehole.items[0].item_id == "treehole:12345"
    assert treehole.items[0].metrics["reply_count"] == 18
    assert treehole.items[0].media == ("treehole-media/12345/poster.jpg",)


def test_treehole_pid_remains_the_same_item_across_snapshots() -> None:
    first = _object(FIXTURES / "treehole-v1.json")
    second = dict(first)
    second["snapshot_id"] = "snapshot-later"

    original = treehole_from_v1(first).items[0]
    updated = treehole_from_v1(second).items[0]

    assert original.item_id == updated.item_id == "treehole:12345"
    assert original.edition_id != updated.edition_id


def test_real_v1_markdown_and_nested_treehole_contracts_are_supported() -> None:
    markdown = """---
title: "AI 教程 · 2026-08-16"
date: 2026-08-16
---
# AI 教程
## 来源
### 1. [一个真实条目](https://example.test/item)

完整正文。

图片：[图1](https://example.test/image.jpg)

发布时间：2026-08-15T16:54+08:00
"""
    edition = ai_daily_markdown_from_v1(markdown, stream="learning")
    assert edition.edition_id == "2026-08-16-learning"
    assert edition.items[0].item_id.startswith("ai-daily:learning:")
    assert edition.items[0].body.startswith("完整正文")
    assert edition.items[0].media == ("https://example.test/image.jpg",)

    nested = {
        "event_id": "snapshot-1",
        "snapshot": {
            "id": "snapshot-1",
            "stat_date": "2026-08-16",
            "checkpoint": "23:00",
            "quality": "complete",
            "items": [
                {
                    "pid": 12345,
                    "text": "正文",
                    "timestamp": 1786722240,
                    "best_rank": 1,
                    "peak_score": 50.0,
                    "peak_reply": 18,
                    "peak_likenum": 9,
                    "peak_praise_num": 2,
                }
            ],
        },
    }
    treehole = treehole_from_v1(
        nested,
        comments_by_pid={12345: ("评论",)},
        media_by_pid={12345: ("data:image/jpeg;base64,AA==",)},
    )
    assert treehole.edition_id == "snapshot-1"
    assert treehole.items[0].metrics["reply_count"] == 18
    assert treehole.items[0].metrics["favorite_count"] == 9
    assert treehole.items[0].metrics["like_count"] == 2
    assert [comment.text for comment in treehole.items[0].comments] == ["评论"]
    assert treehole.items[0].media[0].startswith("data:image/jpeg")


def test_learning_markdown_preserves_source_and_native_section_for_h4_items() -> None:
    articles = "\n".join(
        f"#### {index}. [文章 {index}](https://weekly.example/articles/{index})"
        f"\n\n文章摘要 {index}。\n"
        for index in range(1, 11)
    )
    tools = "\n".join(
        f"#### {index}. [工具 {index}](https://weekly.example/tools/{index})"
        f"\n\n工具摘要 {index}。\n"
        for index in range(11, 22)
    )
    markdown = f"""---
title: "AI 教程、工具与总结 · 2026-08-22"
date: 2026-08-22
---
# AI 教程、工具与总结

## 阮一峰《科技爱好者周刊》

> 本次收录 21 条

### 文章

{articles}
### 工具

{tools}
## 逛逛 GitHub

### 22. [一个 RSS 条目](https://github.example/item)

RSS 摘要。
"""

    edition = ai_daily_markdown_from_v1(markdown, stream="learning")

    assert len(edition.items) == 22
    assert edition.items[0].source_name == "阮一峰《科技爱好者周刊》"
    assert edition.items[0].native_section == "文章"
    assert edition.items[9].native_section == "文章"
    assert edition.items[10].native_section == "工具"
    assert "### 工具" not in edition.items[9].body
    assert edition.items[0].source_id == edition.items[20].source_id
    assert edition.items[21].source_name == "逛逛 GitHub"
    assert edition.items[21].native_section is None
    assert edition.items[21].source_id != edition.items[0].source_id


def test_feed_cli_ingest_list_and_open(vault: Path, tmp_path: Path, capsys: object) -> None:
    state = tmp_path / "state"
    assert (
        main(
            [
                "feed",
                "ingest",
                "ai-daily",
                str(FIXTURES / "ai-daily-v1.json"),
                "--content-map",
                str(FIXTURES / "ai-daily-content.json"),
                "--state",
                str(state),
            ]
        )
        == 0
    )
    edition = FeedCache(state).get(FeedKind.AI_DAILY, "2026-08-17-news")
    assert edition.items[0].body.startswith("# 本地 AI 工具")
    assert (
        main(
            [
                "feed",
                "open",
                "ai-daily",
                edition.edition_id,
                "--vault",
                str(vault),
                "--state",
                str(state),
            ]
        )
        == 0
    )
    assert (vault / "feeds" / "ai-daily" / "2026" / "2026-08-17-news.md").is_file()


def test_feed_sync_reuses_external_producer_files(tmp_path: Path) -> None:
    state = tmp_path / "state"
    state.mkdir()
    (state / "feed-producers.json").write_text(
        json.dumps(
            {
                "ai-daily": {
                    "payload_path": str(FIXTURES / "ai-daily-v1.json"),
                    "content_map_path": str(FIXTURES / "ai-daily-content.json"),
                },
                "treehole": {
                    "payload_path": str(FIXTURES / "treehole-v1.json"),
                },
            }
        ),
        encoding="utf-8",
    )

    assert main(["feed", "sync", "all", "--state", str(state)]) == 0

    assert FeedCache(state).list_editions(FeedKind.AI_DAILY)
    assert FeedCache(state).list_editions(FeedKind.TREEHOLE)


def test_feed_sync_isolates_one_ai_stream_and_still_syncs_treehole(tmp_path: Path) -> None:
    state = tmp_path / "state"
    state.mkdir()
    issue = _object(FIXTURES / "ai-daily-v1.json")
    streams = issue["streams"]
    assert isinstance(streams, list)
    cast(list[object], streams).append(
        {
            "stream": "learning",
            "channels": [{"title": "坏数据", "items": [{"title": "缺少 artifact_id"}]}],
        }
    )
    issue_path = tmp_path / "partially-invalid-ai-daily.json"
    issue_path.write_text(json.dumps(issue, ensure_ascii=False), encoding="utf-8")
    (state / "feed-producers.json").write_text(
        json.dumps(
            {
                "ai-daily": {
                    "payload_path": str(issue_path),
                    "content_map_path": str(FIXTURES / "ai-daily-content.json"),
                },
                "treehole": {"payload_path": str(FIXTURES / "treehole-v1.json")},
            }
        ),
        encoding="utf-8",
    )

    syncer = FeedSyncer(state)
    synchronized = syncer.sync_all()

    assert len(synchronized[FeedKind.AI_DAILY]) == 1
    assert len(synchronized[FeedKind.TREEHOLE]) == 1
    assert FeedCache(state).get(FeedKind.AI_DAILY, "2026-08-17-news").items
    assert FeedCache(state).list_editions(FeedKind.TREEHOLE)
    assert [(failure.feed, failure.stream) for failure in syncer.failures] == [
        (FeedKind.AI_DAILY, "learning")
    ]


def test_feed_cli_returns_nonzero_and_prints_partial_sync_failures(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    state = tmp_path / "state"
    state.mkdir()
    issue = _object(FIXTURES / "ai-daily-v1.json")
    streams = issue["streams"]
    assert isinstance(streams, list)
    cast(list[object], streams).append(
        {
            "stream": "learning",
            "channels": [{"items": [{"title": "缺少 artifact_id"}]}],
        }
    )
    issue_path = tmp_path / "partially-invalid-ai-daily.json"
    issue_path.write_text(json.dumps(issue, ensure_ascii=False), encoding="utf-8")
    (state / "feed-producers.json").write_text(
        json.dumps(
            {
                "ai-daily": {"payload_path": str(issue_path)},
                "treehole": {"payload_path": str(FIXTURES / "treehole-v1.json")},
            }
        ),
        encoding="utf-8",
    )

    exit_code = main(["feed", "sync", "all", "--state", str(state)])
    output = json.loads(capsys.readouterr().out)

    assert exit_code == 1
    assert output["ai-daily"] == ["2026-08-17-news"]
    assert output["treehole"]
    assert output["failures"][0]["stream"] == "learning"


def test_sync_all_reports_malformed_treehole_without_losing_ai_daily(
    tmp_path: Path,
) -> None:
    state = tmp_path / "state"
    state.mkdir()
    malformed_treehole = tmp_path / "malformed-treehole.json"
    malformed_treehole.write_text(
        json.dumps({"snapshot": {"items": []}}),
        encoding="utf-8",
    )
    (state / "feed-producers.json").write_text(
        json.dumps(
            {
                "ai-daily": {"payload_path": str(FIXTURES / "ai-daily-v1.json")},
                "treehole": {"payload_path": str(malformed_treehole)},
            }
        ),
        encoding="utf-8",
    )

    syncer = FeedSyncer(state)
    synchronized = syncer.sync_all()

    assert synchronized[FeedKind.AI_DAILY]
    assert synchronized[FeedKind.TREEHOLE] == ()
    assert syncer.failures[0].feed is FeedKind.TREEHOLE
    assert syncer.failures[0].stream is None


def test_remote_ai_sync_reports_each_missing_expected_stream(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    state = tmp_path / "state"
    state.mkdir()
    (state / "feed-producers.json").write_text(
        json.dumps(
            {
                "ai-daily": {
                    "remote_kind": "ai-daily-bridge-v1",
                    "ssh_alias": "producer",
                }
            }
        ),
        encoding="utf-8",
    )
    news_markdown = """---
date: 2026-08-22
title: AI 资讯
---
# AI 资讯

## 1. [唯一返回的资讯](https://example.test/news)

资讯正文。
"""

    def pull_news_only(
        _puller: RemoteFeedPuller,
        alias: str,
    ) -> tuple[tuple[str, str], ...]:
        assert alias == "producer"
        return (("news", news_markdown),)

    monkeypatch.setattr(RemoteFeedPuller, "ai_daily", pull_news_only)

    exit_code = main(["feed", "sync", "all", "--state", str(state)])
    output = json.loads(capsys.readouterr().out)

    assert exit_code == 1
    assert output["ai-daily"] == ["2026-08-22-news"]
    assert [failure["stream"] for failure in output["failures"]] == [
        "hotspot",
        "learning",
    ]
    assert all("no document" in failure["detail"] for failure in output["failures"])
    assert FeedCache(state).get(FeedKind.AI_DAILY, "2026-08-22-news").items

from __future__ import annotations

import hashlib
import io
import json
import subprocess
import sys
from contextlib import redirect_stdout
from pathlib import Path
from typing import cast

import pytest

import okf_workspace.feeds.remote as feed_remote
from okf_workspace.cli import main
from okf_workspace.dashboard.feeds import (
    subscription_dashboard,
    subscription_sources_dashboard,
)
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


def test_learning_markdown_prefers_producer_source_id() -> None:
    markdown = """---
title: AI 学习
date: 2026-08-22
---
# AI 学习

## 阮一峰《科技爱好者周刊》

### 1. [一个条目](https://weekly.example/item)

摘要。
"""

    edition = ai_daily_markdown_from_v1(
        markdown,
        stream="learning",
        source_ids_by_name={"阮一峰《科技爱好者周刊》": "ruanyf-weekly"},
    )

    assert edition.items[0].source_id == "ruanyf-weekly"


def test_remote_ai_daily_carries_unique_valid_registry_ids(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    payload = {
        "documents": [
            {
                "stream": "learning",
                "markdown": "---\ndate: 2026-08-22\n---\n# Learning\n",
            }
        ],
        "sources": [
            {"source_id": "weekly-source", "source_name": "周刊"},
            {"source_id": "other-source", "source_name": "冲突来源"},
            {"source_id": "second-source", "source_name": "冲突来源"},
            {"source_id": "INVALID ID", "source_name": "无效来源"},
        ],
        "registry_errors": [],
    }
    puller = RemoteFeedPuller(tmp_path)
    def remote_python(_alias: str, _script: str, *, sudo: bool = False) -> str:
        if "requested = set" in _script:
            return json.dumps(
                {
                    "hints": [
                        {
                            "url_digest": hashlib.sha256(
                                b"https://weekly.example/legacy"
                            ).hexdigest(),
                            "source_name": "周刊",
                        }
                    ],
                    "warnings": [],
                }
            )
        return json.dumps(payload)

    monkeypatch.setattr(puller, "_python", remote_python)

    documents = puller.ai_daily("producer")

    assert len(documents) == 1
    assert documents[0][0] == "learning"
    assert puller.ai_daily_source_ids_by_name == {"周刊": "weekly-source"}
    assert puller.ai_daily_registry_complete is True
    hints, complete, unresolved_hashes = puller.ai_daily_history_source_hints(
        "producer",
        {"https://weekly.example/legacy"},
    )
    assert complete is True
    assert unresolved_hashes == ()
    assert hints == {
        "https://weekly.example/legacy": ("weekly-source", "周刊")
    }
    assert puller.ai_daily_registry_warnings == (
        "source name maps to multiple ids: 冲突来源",
    )

    unresolved_url = "https://private.example/feed?token=do-not-log"
    unresolved, complete, unresolved_hashes = puller.ai_daily_history_source_hints(
        "producer",
        {unresolved_url},
    )
    assert unresolved == {}
    assert complete is True
    assert unresolved_hashes == (
        hashlib.sha256(unresolved_url.encode("utf-8")).hexdigest(),
    )
    assert unresolved_url not in "\n".join(puller.ai_daily_registry_warnings)
    assert any(
        warning.startswith("item URL hash has no stable source:")
        for warning in puller.ai_daily_registry_warnings
    )


def test_remote_ai_script_reads_seed_and_runtime_source_registries() -> None:
    seed = "/opt/ai-daily-bridge/config/bridge-sources.yaml"
    runtime = "/srv/ai-daily/bridge/config/sources.yaml"

    assert (seed, runtime) == feed_remote.AI_DAILY_REGISTRY_PATHS
    remote_source = Path(feed_remote.__file__).read_text(encoding="utf-8")
    assert "and source.get('enabled', True)" not in remote_source
    assert "candidate.casefold() in allowed_sources" in remote_source


def test_remote_ai_script_never_exposes_malformed_registry_content(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    secret = "token=must-not-escape"

    class FakeYaml:
        @staticmethod
        def safe_load(_content: str) -> object:
            raise ValueError(
                f"invalid registry line https://private.example/rss?{secret}"
            )

    monkeypatch.setitem(sys.modules, "yaml", FakeYaml)
    registry = tmp_path / "sources.yaml"
    registry.write_text(
        f"sources: [https://private.example/rss?{secret}\n",
        encoding="utf-8",
    )
    outbox = tmp_path / "outbox"
    outbox.mkdir()
    (outbox / "ai-learning-2026-08-23.md").write_text(
        "---\ndate: 2026-08-23\n---\n# AI 学习\n",
        encoding="utf-8",
    )
    script = feed_remote._AI_DAILY_SCRIPT  # pyright: ignore[reportPrivateUsage]
    script = script.replace(
        "Path('/srv/ai-daily/bridge/outbox')",
        f"Path({str(outbox)!r})",
    ).replace(
        repr(feed_remote.AI_DAILY_REGISTRY_PATHS),
        repr((str(registry),)),
    )
    output = io.StringIO()
    with redirect_stdout(output):
        exec(compile(script, "<ai-daily>", "exec"), {})

    payload = json.loads(output.getvalue())
    rendered = json.dumps(payload, ensure_ascii=False)
    assert payload["registry_errors"]
    assert secret not in rendered
    assert "https://private.example" not in rendered


def test_remote_history_hint_does_not_leak_source_across_unknown_h2(
    tmp_path: Path,
) -> None:
    target_url = "https://weekly.example/target"
    (tmp_path / "ai-learning-2026-08-20.md").write_text(
        """## Known Source

#### 1. [Earlier](https://weekly.example/earlier)

Earlier body.

## Unregistered Source

#### 2. [Target](https://weekly.example/target)

Target body.
""",
        encoding="utf-8",
    )
    script = feed_remote._AI_DAILY_HISTORY_HINTS_SCRIPT  # pyright: ignore[reportPrivateUsage]
    script = script.replace(
        "Path('/srv/ai-daily/bridge/outbox')",
        f"Path({str(tmp_path)!r})",
    ).replace(
        "__URL_DIGESTS__",
        repr((hashlib.sha256(target_url.encode("utf-8")).hexdigest(),)),
    ).replace("__SOURCE_NAMES__", repr(("known source",)))
    output = io.StringIO()
    with redirect_stdout(output):
        exec(compile(script, "<history-hints>", "exec"), {})

    payload = json.loads(output.getvalue())
    assert payload["hints"] == []


def test_remote_feed_timeout_is_reported_without_escaping_sync_boundary(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    def timeout(*_args: object, **_kwargs: object) -> object:
        raise subprocess.TimeoutExpired(cmd="ssh", timeout=60)

    monkeypatch.setattr(feed_remote.subprocess, "run", timeout)
    puller = RemoteFeedPuller(tmp_path)

    with pytest.raises(RuntimeError, match="timed out after 60 seconds"):
        puller._python(  # pyright: ignore[reportPrivateUsage]
            "producer", "print('ok')", sudo=True
        )


def test_sync_upgrades_legacy_source_id_and_keeps_renamed_history(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
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

    def learning_markdown(issue_date: str, source_name: str) -> str:
        return f"""---
title: AI 学习
date: {issue_date}
---
# AI 学习

## {source_name}

### 1. [{issue_date} 条目](https://weekly.example/{issue_date})

摘要。
"""

    cache = FeedCache(state)
    legacy = ai_daily_markdown_from_v1(
        learning_markdown("2026-08-20", "旧周刊"),
        stream="learning",
    )
    legacy_source_id = legacy.items[0].source_id
    assert legacy_source_id is not None
    assert legacy_source_id != "weekly-source"
    cache.put(legacy)

    current = [learning_markdown("2026-08-21", "旧周刊")]

    def pull_current(
        _puller: RemoteFeedPuller,
        alias: str,
        _script: str,
        *,
        sudo: bool = False,
    ) -> str:
        assert alias == "producer"
        assert sudo is True
        source_name = "新周刊" if "新周刊" in current[0] else "旧周刊"
        return json.dumps(
            {
                "documents": [
                    {
                        "stream": "learning",
                        "markdown": current[0],
                    }
                ],
                "sources": [
                    {
                        "source_id": "weekly-source",
                        "source_name": source_name,
                    }
                ],
            }
        )

    monkeypatch.setattr(RemoteFeedPuller, "_python", pull_current)
    FeedSyncer(state).sync(FeedKind.AI_DAILY)

    upgraded = cache.get(FeedKind.AI_DAILY, "2026-08-20-learning")
    assert upgraded.items[0].source_id == "weekly-source"

    same_registry_syncer = FeedSyncer(state)

    def reject_repeated_history_scan(*_args: object, **_kwargs: object) -> object:
        raise AssertionError("an unchanged source registry must not rescan Feed history")

    monkeypatch.setattr(
        same_registry_syncer.cache,
        "iter_stream_indexes",
        reject_repeated_history_scan,
    )
    same_registry_syncer.sync(FeedKind.AI_DAILY)

    current[0] = learning_markdown("2026-08-22", "新周刊")
    FeedSyncer(state).sync(FeedKind.AI_DAILY)

    overview = subscription_sources_dashboard(state)
    assert overview["total_sources"] == 1
    sources = overview["sources"]
    assert isinstance(sources, list)
    source = cast(dict[str, object], sources[0])
    assert source["source_id"] == "weekly-source"
    assert source["source_name"] == "新周刊"
    assert source["edition_count"] == 3

    detail = subscription_dashboard(state, source_id="weekly-source")
    editions = detail["editions"]
    assert isinstance(editions, list)
    assert [
        cast(dict[str, object], edition)["digest_id"]
        for edition in cast(list[object], editions)
    ] == [
        "2026-08-22-learning",
        "2026-08-21-learning",
        "2026-08-20-learning",
    ]


def test_sync_repairs_unattributed_history_from_exact_remote_item_hint(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
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
    legacy_url = "https://mp.weixin.qq.com/s?__biz=legacy&idx=1"
    future_legacy_url = "https://mp.weixin.qq.com/s?__biz=future&idx=2"
    legacy = ai_daily_markdown_from_v1(
        f"""---
title: AI 学习
date: 2026-08-20
---
# AI 学习

## 最新条目

### 1. [历史条目]({legacy_url})

历史正文。
""",
        stream="learning",
    )
    assert legacy.items[0].source_name is None
    assert legacy.items[0].source_id == "mp.weixin.qq.com"
    FeedCache(state).put(legacy)

    current_markdown = """---
title: AI 学习
date: 2026-08-21
---
# AI 学习

## 逛逛GitHub

#### 1. [新条目](https://weekly.example/current)

新正文。
"""

    def pull_current(
        _puller: RemoteFeedPuller,
        _alias: str,
        _script: str,
        *,
        sudo: bool = False,
    ) -> str:
        assert sudo is True
        if "requested = set" in _script:
            return json.dumps(
                {
                    "hints": [
                        {
                            "url_digest": hashlib.sha256(
                                legacy_url.encode("utf-8")
                            ).hexdigest(),
                            "source_name": "逛逛GitHub",
                        },
                        {
                            "url_digest": hashlib.sha256(
                                future_legacy_url.encode("utf-8")
                            ).hexdigest(),
                            "source_name": "逛逛GitHub",
                        },
                    ],
                    "warnings": [],
                }
            )
        return json.dumps(
            {
                "documents": [{"stream": "learning", "markdown": current_markdown}],
                "sources": [
                    {"source_id": "guangguang-github", "source_name": "逛逛GitHub"}
                ],
            }
        )

    monkeypatch.setattr(RemoteFeedPuller, "_python", pull_current)

    FeedSyncer(state).sync(FeedKind.AI_DAILY)

    repaired = FeedCache(state).get(FeedKind.AI_DAILY, legacy.edition_id)
    assert repaired.items[0].source_id == "guangguang-github"
    assert repaired.items[0].source_name == "逛逛GitHub"

    future_legacy = ai_daily_markdown_from_v1(
        f"""---
title: AI 学习
date: 2026-08-19
---
# AI 学习

## 最新条目

### 1. [稍后写入的历史条目]({future_legacy_url})

稍后写入。
""",
        stream="learning",
    )
    FeedCache(state).put(future_legacy)
    FeedSyncer(state).sync(FeedKind.AI_DAILY)
    repaired_future = FeedCache(state).get(
        FeedKind.AI_DAILY,
        future_legacy.edition_id,
    )
    assert repaired_future.items[0].source_id == "guangguang-github"
    assert repaired_future.items[0].source_name == "逛逛GitHub"

    overview = subscription_sources_dashboard(state)
    assert overview["total_sources"] == 1


def test_source_migration_never_marks_corrupt_history_complete(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
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
    broken = state / "feed-cache/ai-daily/2026-08-19-learning.json"
    broken.parent.mkdir(parents=True)
    broken.write_text("{broken", encoding="utf-8")
    current = """---
title: AI 学习
date: 2026-08-23
---
# AI 学习

## 逛逛GitHub

#### 1. [新条目](https://weekly.example/current)

新正文。
"""

    def pull_current(
        _puller: RemoteFeedPuller,
        _alias: str,
        _script: str,
        *,
        sudo: bool = False,
    ) -> str:
        assert sudo is True
        return json.dumps(
            {
                "documents": [{"stream": "learning", "markdown": current}],
                "sources": [
                    {"source_id": "guangguang-github", "source_name": "逛逛GitHub"}
                ],
            }
        )

    monkeypatch.setattr(RemoteFeedPuller, "_python", pull_current)

    syncer = FeedSyncer(state)
    syncer.sync(FeedKind.AI_DAILY)

    marker = (
        state
        / "feed-cache/metadata/migrations/ai-daily-learning-source-ids.json"
    )
    assert not marker.exists()
    assert any(failure.stream == "learning" for failure in syncer.failures)


def test_incomplete_registry_does_not_apply_partial_stable_ids(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
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
    current = """---
title: AI 学习
date: 2026-08-23
---
# AI 学习

## Known Source

#### 1. [当前条目](https://known.example/article)

正文。
"""

    def pull_current(
        _puller: RemoteFeedPuller,
        _alias: str,
        _script: str,
        *,
        sudo: bool = False,
    ) -> str:
        assert sudo is True
        return json.dumps(
            {
                "documents": [{"stream": "learning", "markdown": current}],
                "sources": [
                    {"source_id": "known-source", "source_name": "Known Source"}
                ],
                "registry_errors": ["/srv/config/sources.yaml: ParserError"],
            }
        )

    monkeypatch.setattr(RemoteFeedPuller, "_python", pull_current)

    syncer = FeedSyncer(state)
    syncer.sync(FeedKind.AI_DAILY)

    stored = FeedCache(state).get(FeedKind.AI_DAILY, "2026-08-23-learning")
    assert stored.items[0].source_id != "known-source"
    assert stored.items[0].source_name == "Known Source"
    marker = (
        state
        / "feed-cache/metadata/migrations/ai-daily-learning-source-ids.json"
    )
    assert not marker.exists()
    assert any(failure.stream == "learning" for failure in syncer.failures)


def test_incomplete_history_scan_does_not_apply_partial_source_hints(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
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
    candidate_url = "https://unknown.example/candidate"
    current = f"""---
title: AI 学习
date: 2026-08-23
---
# AI 学习

## 最新条目

#### 1. [候选条目]({candidate_url})

正文。
"""

    def pull_current(
        _puller: RemoteFeedPuller,
        _alias: str,
        script: str,
        *,
        sudo: bool = False,
    ) -> str:
        assert sudo is True
        if "requested = set" in script:
            return json.dumps(
                {
                    "hints": [
                        {
                            "url_digest": hashlib.sha256(
                                candidate_url.encode("utf-8")
                            ).hexdigest(),
                            "source_name": "Known Source",
                        }
                    ],
                    "warnings": ["unreadable history file (sha256:deadbeef)"],
                }
            )
        return json.dumps(
            {
                "documents": [{"stream": "learning", "markdown": current}],
                "sources": [
                    {"source_id": "known-source", "source_name": "Known Source"}
                ],
            }
        )

    monkeypatch.setattr(RemoteFeedPuller, "_python", pull_current)

    syncer = FeedSyncer(state)
    syncer.sync(FeedKind.AI_DAILY)

    stored = FeedCache(state).get(FeedKind.AI_DAILY, "2026-08-23-learning")
    assert stored.items[0].source_id == "unknown.example"
    assert stored.items[0].source_name is None
    marker = (
        state
        / "feed-cache/metadata/migrations/ai-daily-learning-source-ids.json"
    )
    assert not marker.exists()
    assert any(failure.stream == "learning" for failure in syncer.failures)


def test_unmatched_source_hint_is_not_rescanned_every_daily_sync(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
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
    unknown_url = "https://unknown.example/article"
    current = f"""---
title: AI 学习
date: 2026-08-23
---
# AI 学习

## 最新条目

#### 1. [未知来源条目]({unknown_url})

正文。
"""
    history_calls = 0

    def pull_current(
        _puller: RemoteFeedPuller,
        _alias: str,
        script: str,
        *,
        sudo: bool = False,
    ) -> str:
        nonlocal history_calls
        assert sudo is True
        if "requested = set" in script:
            history_calls += 1
            return json.dumps({"hints": [], "warnings": []})
        return json.dumps(
            {
                "documents": [{"stream": "learning", "markdown": current}],
                "sources": [
                    {"source_id": "known-source", "source_name": "已知来源"}
                ],
            }
        )

    monkeypatch.setattr(RemoteFeedPuller, "_python", pull_current)

    for _attempt in range(4):
        FeedSyncer(state).sync(FeedKind.AI_DAILY)

    assert history_calls == 2
    marker = json.loads(
        (
            state
            / "feed-cache/metadata/migrations/ai-daily-learning-source-ids.json"
        ).read_text(encoding="utf-8")
    )
    assert marker["unresolved_url_hashes"] == [
        hashlib.sha256(unknown_url.encode("utf-8")).hexdigest()
    ]


def test_source_history_is_not_scanned_without_a_valid_registry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
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
    current = """---
title: AI 学习
date: 2026-08-23
---
# AI 学习

## 最新条目

#### 1. [尚无注册来源](https://unknown.example/article)

正文。
"""
    history_calls = 0

    def pull_current(
        _puller: RemoteFeedPuller,
        _alias: str,
        script: str,
        *,
        sudo: bool = False,
    ) -> str:
        nonlocal history_calls
        assert sudo is True
        if "requested = set" in script:
            history_calls += 1
            return json.dumps({"hints": [], "warnings": []})
        return json.dumps(
            {
                "documents": [{"stream": "learning", "markdown": current}],
                "sources": [],
            }
        )

    monkeypatch.setattr(RemoteFeedPuller, "_python", pull_current)

    for _attempt in range(2):
        FeedSyncer(state).sync(FeedKind.AI_DAILY)

    assert history_calls == 0


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

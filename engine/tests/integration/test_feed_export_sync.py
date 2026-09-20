from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path
from typing import cast

import pytest

from okf_workspace.dashboard.feeds import feed_dashboard
from okf_workspace.feeds import FeedCache, FeedKind, FeedSyncer
from okf_workspace.feeds.remote import RemoteFeedPuller, RemoteProtocolError
from okf_workspace.feeds.subscriptions import ManagementSource, SourceRegistryMirror


def _markdown(date: str, stream: str, title: str) -> str:
    return f"""---
date: {date}
title: {title}
---
# {title}

## 1. [{title} 条目](https://example.test/{stream}/{date})

正文。
"""


def _cursor(sequence: int) -> dict[str, str]:
    return {
        "recorded_at": f"2026-08-23T06:5{sequence}:00+00:00",
        "artifact_id": f"artifact-{sequence}",
    }


def _document(sequence: int, stream: str, markdown: str) -> dict[str, object]:
    encoded = markdown.encode("utf-8")
    return {
        "cursor": _cursor(sequence),
        "stream": stream,
        "name": f"{stream}-2026-08-{20 + sequence}.md",
        "issued_at": f"2026-08-{20 + sequence}",
        "content_sha256": hashlib.sha256(encoded).hexdigest(),
        "size_bytes": len(encoded),
        "markdown": markdown,
    }


def _source() -> dict[str, object]:
    return {
        "source_id": "feed-0123456789abcdef01234567",
        "source_name": "Example Weekly",
        "canonical_url": "https://feeds.example.test",
        "url_redacted": True,
        "adapter": "rss",
        "enabled": True,
        "required": False,
        "added_at": "2026-08-23T06:00:00+00:00",
        "content_mode": "summary",
        "content_max_chars": 12000,
        "status": "enabled",
        "last_success_at": "2026-08-23T06:40:00+00:00",
        "last_error_at": None,
        "last_error": None,
    }


def _state(tmp_path: Path, *, papers_enabled: bool = False) -> Path:
    state = tmp_path / "state"
    state.mkdir()
    (state / "feed-producers.json").write_text(
        json.dumps(
            {
                "ai-daily": {
                    "remote_kind": "ai-daily-bridge-v1",
                    "feed_export_ssh_alias": "ai-daily-feed-export",
                    "source_admin_ssh_alias": "ai-daily-source-admin",
                    "papers_enabled": papers_enabled,
                }
            }
        ),
        encoding="utf-8",
    )
    return state


def _papers_markdown(date: str) -> str:
    return f"""---
date: {date}
title: AI Papers of the Week
---

## Top AI Papers of the Week (August 11 - August 17) - 2026
| **Paper** | **Links** |
| --- | --- |
| 1) **First Paper** - First description. | [Paper](https://arxiv.org/abs/2608.00001) |
| 2) **Second Paper** - Second description. | [Paper](https://example.org/paper?id=2) |
"""


def test_remote_feed_export_can_request_only_papers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def forced_json(
        _puller: RemoteFeedPuller,
        alias: str,
        *,
        protocol: str,
        action: str,
        payload: dict[str, object],
        max_response_bytes: int,
    ) -> tuple[dict[str, object], None]:
        captured.update(
            alias=alias,
            protocol=protocol,
            action=action,
            payload=payload,
            max_response_bytes=max_response_bytes,
        )
        return {"documents": []}, None

    monkeypatch.setattr(RemoteFeedPuller, "_forced_json", forced_json)

    RemoteFeedPuller(tmp_path).feed_export(
        "ai-daily-feed-export",
        after=None,
        streams=("papers",),
        include_registry=False,
    )

    assert captured["protocol"] == "feed-export.v1"
    assert cast(dict[str, object], captured["payload"])["streams"] == ["papers"]
    assert cast(dict[str, object], captured["payload"])["include_registry"] is False


def test_papers_sync_uses_an_independent_cursor_and_does_not_replace_registry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = _state(tmp_path, papers_enabled=True)
    core_cursor_path = state / "feed-sync" / "ai-daily-export-cursor.json"
    core_cursor_path.parent.mkdir(parents=True)
    core_cursor_payload = {
        "version": 1,
        "producer_fingerprint": hashlib.sha256(
            b"okf-feed-export-v1\0ai-daily-feed-export"
        ).hexdigest(),
        "cursor": _cursor(3),
        "updated_at": "2026-08-23T07:00:00+00:00",
    }
    core_cursor_path.write_text(json.dumps(core_cursor_payload), encoding="utf-8")
    SourceRegistryMirror(state).replace(
        "a" * 64,
        (ManagementSource.parse(_source()),),
    )
    calls: list[tuple[object, object, bool]] = []
    papers = _document(1, "papers", _papers_markdown("2026-08-21"))

    def export(
        _puller: RemoteFeedPuller,
        _alias: str,
        *,
        after: object,
        limit: int,
        include_registry: bool,
        streams: tuple[str, ...] | None = None,
    ) -> dict[str, object]:
        assert limit == 30
        calls.append((streams, after, include_registry))
        if streams == ("papers",):
            return {
                "documents": [papers],
                "next_cursor": _cursor(1),
                "has_more": False,
                "stream_status": {"papers": {"status": "ok", "sources": []}},
            }
        assert streams is None
        assert after == _cursor(3)
        return {
            "documents": [],
            "next_cursor": _cursor(3),
            "has_more": False,
            "stream_status": {
                stream: {"status": "ok", "sources": []}
                for stream in ("hotspot", "news", "learning")
            },
            "registry": {"revision": "a" * 64, "sources": [_source()]},
        }

    monkeypatch.setattr(RemoteFeedPuller, "feed_export", export)

    editions = FeedSyncer(state).sync(FeedKind.AI_DAILY)

    assert [edition.stream for edition in editions] == ["papers"]
    assert calls == [
        (None, _cursor(3), True),
        (("papers",), None, False),
    ]
    assert json.loads(core_cursor_path.read_text(encoding="utf-8")) == core_cursor_payload
    papers_cursor = json.loads(
        (state / "feed-sync" / "ai-daily-papers-export-cursor.json").read_text(encoding="utf-8")
    )
    assert papers_cursor["cursor"] == _cursor(1)
    assert (
        FeedCache(state).latest_edition(
            FeedKind.AI_DAILY,
            stream="papers",
        )
        is not None
    )
    assert SourceRegistryMirror(state).load().registry_revision == "a" * 64


def test_empty_papers_page_still_advances_only_the_papers_cursor(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = _state(tmp_path, papers_enabled=True)

    def export(
        _puller: RemoteFeedPuller,
        _alias: str,
        *,
        after: object,
        limit: int,
        include_registry: bool,
        streams: tuple[str, ...] | None = None,
    ) -> dict[str, object]:
        assert limit == 30
        if streams == ("papers",):
            assert after is None and include_registry is False
            return {
                "documents": [],
                "next_cursor": _cursor(2),
                "has_more": False,
                "stream_status": {"papers": {"status": "ok", "sources": []}},
            }
        assert streams is None and after is None and include_registry is True
        return {
            "documents": [],
            "next_cursor": None,
            "has_more": False,
            "stream_status": {
                stream: {"status": "ok", "sources": []}
                for stream in ("hotspot", "news", "learning")
            },
        }

    monkeypatch.setattr(RemoteFeedPuller, "feed_export", export)

    assert FeedSyncer(state).sync(FeedKind.AI_DAILY) == ()
    assert not (state / "feed-sync" / "ai-daily-export-cursor.json").exists()
    assert json.loads(
        (state / "feed-sync" / "ai-daily-papers-export-cursor.json").read_text(encoding="utf-8")
    )["cursor"] == _cursor(2)


def test_invalid_papers_page_does_not_discard_a_valid_core_page(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = _state(tmp_path, papers_enabled=True)
    news = _document(1, "news", _markdown("2026-08-21", "news", "AI 资讯"))
    papers = _document(2, "papers", _papers_markdown("2026-08-22"))
    papers["content_sha256"] = "0" * 64

    def export(
        _puller: RemoteFeedPuller,
        _alias: str,
        *,
        after: object,
        limit: int,
        include_registry: bool,
        streams: tuple[str, ...] | None = None,
    ) -> dict[str, object]:
        assert after is None and limit == 30
        if streams == ("papers",):
            assert include_registry is False
            return {
                "documents": [papers],
                "next_cursor": _cursor(2),
                "has_more": False,
                "stream_status": {"papers": {"status": "ok", "sources": []}},
            }
        assert streams is None and include_registry is True
        return {
            "documents": [news],
            "next_cursor": _cursor(1),
            "has_more": False,
            "stream_status": {
                stream: {"status": "ok", "sources": []}
                for stream in ("hotspot", "news", "learning")
            },
        }

    monkeypatch.setattr(RemoteFeedPuller, "feed_export", export)
    syncer = FeedSyncer(state)

    editions = syncer.sync(FeedKind.AI_DAILY)

    assert [edition.edition_id for edition in editions] == ["2026-08-21-news"]
    assert [(failure.stream, failure.detail) for failure in syncer.failures] == [
        ("papers", "AI Daily export document checksum is invalid")
    ]
    assert FeedCache(state).latest_edition(FeedKind.AI_DAILY, stream="news") is not None
    assert FeedCache(state).latest_edition(FeedKind.AI_DAILY, stream="papers") is None
    health = cast(dict[str, object], feed_dashboard(state)["stream_health"])
    assert cast(dict[str, object], health["papers"])["phase"] == "parse"
    assert cast(dict[str, object], health["news"])["status"] == "ok"


def test_papers_health_survives_other_lane_updates_and_recovers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = _state(tmp_path, papers_enabled=True)
    fail_papers = True

    def export(
        _puller: RemoteFeedPuller,
        _alias: str,
        *,
        streams: tuple[str, ...] | None = None,
        **_arguments: object,
    ) -> dict[str, object]:
        if streams == ("papers",) and fail_papers:
            raise OSError("remote transport unavailable")
        selected = streams or ("hotspot", "news", "learning")
        return {
            "documents": [],
            "next_cursor": None,
            "has_more": False,
            "stream_status": {stream: {"status": "ok", "sources": []} for stream in selected},
        }

    monkeypatch.setattr(RemoteFeedPuller, "feed_export", export)
    FeedSyncer(state).sync(FeedKind.AI_DAILY)
    health = cast(dict[str, object], feed_dashboard(state)["stream_health"])
    papers = cast(dict[str, object], health["papers"])
    assert papers["status"] == "error" and papers["phase"] == "transport"
    assert papers["last_error_at"] is not None
    from okf_workspace.feeds.health import commit_stream_status

    commit_stream_status(state, {"news": {"status": "ok", "sources": []}})
    assert cast(dict[str, object], feed_dashboard(state)["stream_health"])["papers"] == papers
    fail_papers = False
    FeedSyncer(state).sync(FeedKind.AI_DAILY)
    healthy = cast(
        dict[str, object], cast(dict[str, object], feed_dashboard(state)["stream_health"])["papers"]
    )
    assert healthy["status"] == "ok" and healthy["message"] is None
    assert healthy["last_success_at"] is not None


def test_core_transport_failure_still_attempts_papers(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = _state(tmp_path, papers_enabled=True)

    def export(
        _puller: RemoteFeedPuller,
        _alias: str,
        *,
        streams: tuple[str, ...] | None = None,
        **_arguments: object,
    ) -> dict[str, object]:
        if streams is None:
            raise OSError("core transport unavailable")
        return {
            "documents": [_document(1, "papers", _papers_markdown("2026-08-21"))],
            "next_cursor": _cursor(1),
            "has_more": False,
            "stream_status": {"papers": {"status": "ok", "sources": []}},
        }

    monkeypatch.setattr(RemoteFeedPuller, "feed_export", export)
    syncer = FeedSyncer(state)
    assert [edition.stream for edition in syncer.sync(FeedKind.AI_DAILY)] == ["papers"]
    assert {failure.stream for failure in syncer.failures} == {"hotspot", "news", "learning"}


def test_forced_json_transport_passes_no_remote_command_or_secret_in_errors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def run(*args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        captured["args"] = args
        captured["kwargs"] = kwargs
        request = json.loads(cast(str, kwargs["input"]))
        return subprocess.CompletedProcess(
            args=[],
            returncode=0,
            stdout=json.dumps(
                {
                    "protocol": "source-admin.v1",
                    "request_id": request["request_id"],
                    "ok": True,
                    "registry_revision": "a" * 64,
                    "result": {"sources": [], "count": 0},
                }
            )
            + "\n",
            stderr="",
        )

    monkeypatch.setattr(subprocess, "run", run)
    result, revision = RemoteFeedPuller(tmp_path).source_admin(
        "source-admin-alias",
        "list",
        {},
    )
    assert result == {"sources": [], "count": 0}
    assert revision == "a" * 64
    invocation = cast(tuple[object, ...], captured["args"])[0]
    assert cast(list[str], invocation)[-1] == "source-admin-alias"
    assert "source-admin.sh" not in cast(list[str], invocation)
    assert cast(dict[str, object], captured["kwargs"])["shell"] is False
    assert (
        json.loads(cast(str, cast(dict[str, object], captured["kwargs"])["input"]))["action"]
        == "list"
    )

    def rejected(*_args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        request = json.loads(cast(str, kwargs["input"]))
        return subprocess.CompletedProcess(
            args=[],
            returncode=2,
            stdout=json.dumps(
                {
                    "protocol": "source-admin.v1",
                    "request_id": request["request_id"],
                    "ok": False,
                    "registry_revision": "b" * 64,
                    "error": {
                        "code": "revision_conflict",
                        "message": "expected URL must not be logged",
                        "retryable": False,
                    },
                }
            )
            + "\n",
            stderr="",
        )

    monkeypatch.setattr(subprocess, "run", rejected)
    with pytest.raises(RemoteProtocolError) as structured:
        RemoteFeedPuller(tmp_path).source_admin(
            "source-admin-alias",
            "disable",
            {"source_id": "feed-0123456789abcdef01234567"},
        )
    assert structured.value.code == "revision_conflict"
    assert structured.value.retryable is False
    assert structured.value.registry_revision == "b" * 64
    assert "URL" not in str(structured.value)

    def failed(*_args: object, **_kwargs: object) -> subprocess.CompletedProcess[str]:
        return subprocess.CompletedProcess(
            args=[],
            returncode=255,
            stdout="",
            stderr="ssh: token=super-secret url=https://private.example/feed",
        )

    monkeypatch.setattr(subprocess, "run", failed)
    with pytest.raises(RemoteProtocolError) as raised:
        RemoteFeedPuller(tmp_path).source_admin(
            "source-admin-alias",
            "preview",
            {"url": "https://private.example/feed?token=super-secret"},
        )
    assert raised.value.code == "remote_unavailable"
    assert "secret" not in str(raised.value)
    assert "private.example" not in str(raised.value)


@pytest.mark.parametrize("protocol", ["source-admin.v1", "feed-export.v1"])
def test_forced_json_preserves_retryable_structured_rc1_errors(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    protocol: str,
) -> None:
    def failed(*_args: object, **kwargs: object) -> subprocess.CompletedProcess[str]:
        request = json.loads(cast(str, kwargs["input"]))
        return subprocess.CompletedProcess(
            args=[],
            returncode=1,
            stdout=json.dumps(
                {
                    "protocol": protocol,
                    "request_id": request["request_id"],
                    "ok": False,
                    "error": {
                        "code": "internal_error",
                        "message": "safe remote detail",
                        "retryable": True,
                    },
                }
            )
            + "\n",
            stderr="",
        )

    monkeypatch.setattr(subprocess, "run", failed)
    puller = RemoteFeedPuller(tmp_path)
    with pytest.raises(RemoteProtocolError) as raised:
        if protocol == "source-admin.v1":
            puller.source_admin("source-admin-alias", "list", {})
        else:
            puller.feed_export("feed-export-alias", after=None)

    assert raised.value.code == "internal_error"
    assert raised.value.retryable is True


def test_incremental_export_pulls_all_pages_commits_cursor_and_mirrors_registry(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = _state(tmp_path)
    first = _document(1, "hotspot", _markdown("2026-08-21", "hotspot", "中国热点"))
    second = _document(2, "news", _markdown("2026-08-22", "news", "AI 资讯"))
    third = _document(3, "learning", _markdown("2026-08-23", "learning", "订阅阅读"))
    calls: list[object] = []

    def export(
        _puller: RemoteFeedPuller,
        alias: str,
        *,
        after: object,
        limit: int,
        include_registry: bool,
    ) -> dict[str, object]:
        assert alias == "ai-daily-feed-export"
        assert limit == 30
        assert include_registry is True
        calls.append(after)
        if after is None:
            return {
                "documents": [first, second],
                "next_cursor": _cursor(2),
                "has_more": True,
                "stream_status": {
                    stream: {"status": "ok", "sources": []}
                    for stream in ("hotspot", "news", "learning")
                },
                "registry": {"revision": "a" * 64, "sources": [_source()]},
            }
        if after == _cursor(2):
            return {
                "documents": [third],
                "next_cursor": _cursor(3),
                "has_more": False,
                "stream_status": {
                    stream: {"status": "ok", "sources": []}
                    for stream in ("hotspot", "news", "learning")
                },
                "registry": {"revision": "a" * 64, "sources": [_source()]},
            }
        assert after == _cursor(3)
        return {
            "documents": [],
            "next_cursor": _cursor(3),
            "has_more": False,
            "stream_status": {
                stream: {"status": "ok", "sources": []}
                for stream in ("hotspot", "news", "learning")
            },
            "registry": {"revision": "a" * 64, "sources": [_source()]},
        }

    monkeypatch.setattr(RemoteFeedPuller, "feed_export", export)
    first_sync = FeedSyncer(state)
    editions = first_sync.sync(FeedKind.AI_DAILY)
    assert [edition.edition_id for edition in editions] == [
        "2026-08-21-hotspot",
        "2026-08-22-news",
        "2026-08-23-learning",
    ]
    assert first_sync.failures == ()
    assert calls == [None, _cursor(2)]
    assert FeedCache(state).get(FeedKind.AI_DAILY, "2026-08-21-hotspot").items
    assert SourceRegistryMirror(state).load().registry_revision == "a" * 64
    cursor_payload = json.loads(
        (state / "feed-sync" / "ai-daily-export-cursor.json").read_text(encoding="utf-8")
    )
    assert cursor_payload["cursor"] == _cursor(3)
    assert "ai-daily-feed-export" not in json.dumps(cursor_payload)

    second_sync = FeedSyncer(state)
    assert second_sync.sync(FeedKind.AI_DAILY) == ()
    assert calls[-1] == _cursor(3)


def test_incremental_export_does_not_advance_cursor_until_entire_page_is_valid(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = _state(tmp_path)
    good = _document(1, "news", _markdown("2026-08-21", "news", "AI 资讯"))
    bad = _document(2, "learning", _markdown("2026-08-22", "learning", "订阅阅读"))
    bad["content_sha256"] = "0" * 64

    def export(
        _puller: RemoteFeedPuller,
        _alias: str,
        *,
        after: object,
        limit: int,
        include_registry: bool,
    ) -> dict[str, object]:
        assert after is None
        assert limit == 30 and include_registry is True
        return {
            "documents": [good, bad],
            "next_cursor": _cursor(2),
            "has_more": False,
            "stream_status": {},
        }

    monkeypatch.setattr(RemoteFeedPuller, "feed_export", export)
    syncer = FeedSyncer(state)
    with pytest.raises(ValueError, match="checksum"):
        syncer.sync(FeedKind.AI_DAILY)
    assert not (state / "feed-sync" / "ai-daily-export-cursor.json").exists()
    assert not FeedCache(state).list_editions(FeedKind.AI_DAILY)


def test_incremental_export_commits_partial_stream_health_without_losing_documents(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = _state(tmp_path)
    news = _document(1, "news", _markdown("2026-08-21", "news", "AI 资讯"))

    def export(
        _puller: RemoteFeedPuller,
        _alias: str,
        *,
        after: object,
        limit: int,
        include_registry: bool,
    ) -> dict[str, object]:
        assert after is None
        assert limit == 30 and include_registry is True
        return {
            "documents": [news],
            "next_cursor": _cursor(1),
            "has_more": False,
            "stream_status": {
                "hotspot": {"status": "ok", "sources": []},
                "news": {"status": "ok", "sources": []},
                "learning": {
                    "status": "error",
                    "sources": [
                        {
                            "source_id": "feed-0123456789abcdef01234567",
                            "status": "error",
                            "last_success_at": None,
                            "last_error_at": "2026-08-23T06:50:00+00:00",
                            "last_error": "upstream timeout",
                            "last_error_type": "ReadTimeout" + "X" * 100,
                        }
                    ],
                },
            },
        }

    monkeypatch.setattr(RemoteFeedPuller, "feed_export", export)
    syncer = FeedSyncer(state)
    assert [value.edition_id for value in syncer.sync(FeedKind.AI_DAILY)] == ["2026-08-21-news"]
    assert [(failure.stream, failure.detail) for failure in syncer.failures] == [
        ("learning", "AI Daily remote stream is error")
    ]
    assert (state / "feed-sync" / "ai-daily-export-cursor.json").is_file()
    summary = feed_dashboard(state)
    sync_status = cast(dict[str, object], summary["ai_daily_sync"])
    streams = cast(dict[str, object], sync_status["streams"])
    learning = cast(dict[str, object], streams["learning"])
    assert learning["status"] == "error"
    assert "upstream timeout" in json.dumps(learning)
    assert "ReadTimeout" + "X" * 100 in json.dumps(learning)


def test_incremental_export_accepts_a_later_sequence_with_an_earlier_timestamp(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = _state(tmp_path)
    fingerprint = hashlib.sha256(b"okf-feed-export-v1\0ai-daily-feed-export").hexdigest()
    cursor_path = state / "feed-sync" / "ai-daily-export-cursor.json"
    cursor_path.parent.mkdir(parents=True)
    cursor_path.write_text(
        json.dumps(
            {
                "version": 1,
                "producer_fingerprint": fingerprint,
                "cursor": _cursor(3),
                "updated_at": "2026-08-23T07:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )

    def export(
        _puller: RemoteFeedPuller,
        _alias: str,
        *,
        after: object,
        limit: int,
        include_registry: bool,
    ) -> dict[str, object]:
        assert after == _cursor(3)
        assert limit == 30 and include_registry is True
        return {
            "documents": [],
            "next_cursor": _cursor(2),
            "has_more": False,
            "stream_status": {
                stream: {"status": "ok", "sources": []}
                for stream in ("hotspot", "news", "learning")
            },
        }

    monkeypatch.setattr(RemoteFeedPuller, "feed_export", export)
    assert FeedSyncer(state).sync(FeedKind.AI_DAILY) == ()
    assert json.loads(cursor_path.read_text(encoding="utf-8"))["cursor"] == _cursor(2)


def test_incremental_export_rejects_documents_without_cursor_progress(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state = _state(tmp_path)
    fingerprint = hashlib.sha256(b"okf-feed-export-v1\0ai-daily-feed-export").hexdigest()
    cursor_path = state / "feed-sync" / "ai-daily-export-cursor.json"
    cursor_path.parent.mkdir(parents=True)
    cursor_path.write_text(
        json.dumps(
            {
                "version": 1,
                "producer_fingerprint": fingerprint,
                "cursor": _cursor(3),
                "updated_at": "2026-08-23T07:00:00+00:00",
            }
        ),
        encoding="utf-8",
    )
    replayed = _document(
        4,
        "learning",
        _markdown("2026-08-24", "learning", "不应提交的重复页面"),
    )

    def export(
        _puller: RemoteFeedPuller,
        _alias: str,
        *,
        after: object,
        limit: int,
        include_registry: bool,
    ) -> dict[str, object]:
        assert after == _cursor(3)
        assert limit == 30 and include_registry is True
        return {
            "documents": [replayed],
            "next_cursor": _cursor(3),
            "has_more": False,
            "stream_status": {
                stream: {"status": "ok", "sources": []}
                for stream in ("hotspot", "news", "learning")
            },
        }

    monkeypatch.setattr(RemoteFeedPuller, "feed_export", export)
    with pytest.raises(ValueError, match="did not advance"):
        FeedSyncer(state).sync(FeedKind.AI_DAILY)

    assert json.loads(cursor_path.read_text(encoding="utf-8"))["cursor"] == _cursor(3)
    assert not (state / "feed-cache" / "ai-daily" / "2026-08-24-learning.json").exists()


def test_legacy_duplicate_source_names_are_omitted_without_blocking_sync() -> None:
    first_payload = _source()
    first_payload["source_id"] = "feed-111111111111111111111111"
    first_payload["source_name"] = "Shared Weekly"
    second_payload = _source()
    second_payload["source_id"] = "feed-222222222222222222222222"
    second_payload["source_name"] = "shared weekly"

    mapping = FeedSyncer._source_ids_by_name(  # pyright: ignore[reportPrivateUsage]
        (
            ManagementSource.parse(first_payload),
            ManagementSource.parse(second_payload),
        )
    )

    assert mapping == {}

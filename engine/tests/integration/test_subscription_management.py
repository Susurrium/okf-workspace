# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false
# pyright: reportUnknownArgumentType=false

from __future__ import annotations

import json
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

import pytest
from fastapi.testclient import TestClient

from okf_workspace.api import LocalTokenStore, create_app
from okf_workspace.config import BrainPaths
from okf_workspace.feeds import FeedCache
from okf_workspace.feeds.models import FeedEdition, FeedItem, FeedKind
from okf_workspace.feeds.remote import RemoteFeedPuller, RemoteProtocolError
from okf_workspace.feeds.subscriptions import SourceRegistryMirror


def _client(vault: Path, tmp_path: Path) -> tuple[TestClient, dict[str, str], BrainPaths]:
    paths = BrainPaths(
        vault=vault,
        originals=tmp_path / "originals",
        state=tmp_path / "state",
    )
    paths.state.mkdir(parents=True, exist_ok=True)
    (paths.state / "feed-producers.json").write_text(
        json.dumps(
            {
                "ai-daily": {
                    "remote_kind": "ai-daily-bridge-v1",
                    "source_admin_ssh_alias": "ai-daily-source-admin",
                    "feed_export_ssh_alias": "ai-daily-feed-export",
                }
            }
        ),
        encoding="utf-8",
    )
    token = LocalTokenStore(paths.state).ensure()
    return (
        TestClient(create_app(paths)),
        {"Authorization": f"Bearer {token}"},
        paths,
    )


def _source(
    source_id: str = "feed-0123456789abcdef01234567",
    *,
    name: str = "Example Weekly",
    enabled: bool = True,
    status: str = "enabled",
) -> dict[str, object]:
    return {
        "source_id": source_id,
        "source_name": name,
        "canonical_url": "https://feeds.example.test",
        "url_redacted": True,
        "adapter": "rss",
        "enabled": enabled,
        "required": False,
        "added_at": "2026-08-23T06:00:00+00:00",
        "content_mode": "summary",
        "content_max_chars": 12000,
        "status": status,
        "last_success_at": None,
        "last_error_at": None,
        "last_error": None,
        "last_error_type": None,
    }


def _preview(revision: str) -> dict[str, object]:
    return {
        "preview_id": "preview-opaque-1",
        "expires_at": (datetime.now(UTC) + timedelta(minutes=10)).isoformat(),
        "detected_adapter": "rss",
        "detected_from": "content-type",
        "canonical_url": "https://feeds.example.test",
        "url_redacted": True,
        "source_id": "feed-0123456789abcdef01234567",
        "source_name": "Example Weekly",
        "existing_source_id": None,
        "entries": [
            {
                "title": "Issue 1",
                "url": "https://feeds.example.test/issues/1",
                "published_at": "2026-08-23T01:00:00+00:00",
            }
        ],
        "defaults": {
            "include_existing": False,
            "content_mode": "summary",
            "content_max_chars": 12000,
        },
        "capabilities": {
            "content_modes": ["summary", "full"],
            "can_include_existing": True,
        },
        "warnings": [],
        "_revision": revision,
    }


def test_subscription_api_preview_confirm_is_cas_bound_and_idempotent(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, headers, paths = _client(vault, tmp_path)
    first_revision = "a" * 64
    second_revision = "b" * 64
    calls: list[tuple[str, dict[str, object]]] = []

    def source_admin(
        _puller: RemoteFeedPuller,
        alias: str,
        action: str,
        payload: dict[str, object],
    ) -> tuple[dict[str, object], str]:
        assert alias == "ai-daily-source-admin"
        calls.append((action, payload))
        if action == "preview":
            preview = _preview(first_revision)
            preview.pop("_revision")
            return preview, first_revision
        if action == "add":
            assert payload["preview_id"] == "preview-opaque-1"
            assert payload["expected_registry_revision"] == first_revision
            source = _source()
            source["canonical_url"] = "https://feeds.example.test"
            return {
                "source": source,
                "existing_items_marked_seen": 3,
                "next_run_will_include_current": False,
            }, second_revision
        raise AssertionError(action)

    monkeypatch.setattr(RemoteFeedPuller, "source_admin", source_admin)

    preview_response = client.post(
        "/feeds/subscriptions/preview",
        headers=headers,
        json={"url": "https://feeds.example.test/example.xml", "adapter": "auto"},
    )
    assert preview_response.status_code == 200
    preview = preview_response.json()
    assert preview["registry_revision"] == first_revision
    assert preview["preview_id"] == "preview-opaque-1"
    preview_files = list((paths.state / "feed-subscriptions" / "previews").glob("*.json"))
    assert len(preview_files) == 1
    assert "example.xml" not in preview_files[0].name

    request = {
        "preview_id": preview["preview_id"],
        "expected_registry_revision": first_revision,
        "idempotency_key": "dashboard-add-1",
        "include_existing": False,
        "content_mode": "summary",
        "content_max_chars": 12000,
    }
    confirmed = client.post("/feeds/subscriptions/confirm", headers=headers, json=request)
    assert confirmed.status_code == 200
    assert confirmed.json()["registry_revision"] == second_revision
    assert confirmed.json()["source"]["source_id"] == _source()["source_id"]
    assert confirmed.json()["existing_items_marked_seen"] == 3

    repeated = client.post("/feeds/subscriptions/confirm", headers=headers, json=request)
    assert repeated.status_code == 200
    assert repeated.json() == confirmed.json()
    assert [action for action, _payload in calls] == ["preview", "add"]

    conflict = client.post(
        "/feeds/subscriptions/confirm",
        headers=headers,
        json={**request, "content_mode": "full"},
    )
    assert conflict.status_code == 409
    assert conflict.json()["detail"]["code"] == "idempotency_conflict"

    mirror = SourceRegistryMirror(paths.state).load()
    assert mirror.registry_revision == second_revision
    assert mirror.sources[0].source_id == _source()["source_id"]


def test_subscription_preview_accepts_the_real_remote_duplicate_and_warning_fields(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, headers, _paths = _client(vault, tmp_path)
    revision = "a" * 64

    def source_admin(
        _puller: RemoteFeedPuller,
        _alias: str,
        action: str,
        _payload: dict[str, object],
    ) -> tuple[dict[str, object], str]:
        assert action == "preview"
        value = _preview(revision)
        value.pop("_revision")
        value["existing_source_id"] = "feed-0123456789abcdef01234567"
        value["warnings"] = [
            "这个来源已经存在",
            "remote token=https://private.example/feed?token=super-secret",
        ]
        return value, revision

    monkeypatch.setattr(RemoteFeedPuller, "source_admin", source_admin)

    response = client.post(
        "/feeds/subscriptions/preview",
        headers=headers,
        json={"url": "https://feeds.example.test/example.xml"},
    )

    assert response.status_code == 200
    assert response.json()["existing_source_id"] == "feed-0123456789abcdef01234567"
    assert response.json()["warnings"] == [
        "这个来源已经存在",
        "来源更新失败，详情已隐藏",
    ]
    assert "super-secret" not in response.text


def test_subscription_preview_rejects_a_source_path_projection(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, headers, _paths = _client(vault, tmp_path)
    revision = "a" * 64

    def source_admin(
        _puller: RemoteFeedPuller,
        _alias: str,
        action: str,
        _payload: dict[str, object],
    ) -> tuple[dict[str, object], str]:
        assert action == "preview"
        value = _preview(revision)
        value.pop("_revision")
        value["canonical_url"] = "https://feeds.example.test/PATH-SECRET"
        return value, revision

    monkeypatch.setattr(RemoteFeedPuller, "source_admin", source_admin)
    response = client.post(
        "/feeds/subscriptions/preview",
        headers=headers,
        json={"url": "https://feeds.example.test/PATH-SECRET"},
    )

    assert response.status_code == 502
    assert response.json()["detail"]["code"] == "invalid_response"
    assert "PATH-SECRET" not in response.text


def test_subscription_api_exposes_stale_mirror_and_mutations_preserve_tombstone(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, headers, paths = _client(vault, tmp_path)
    source_id = "feed-aaaaaaaaaaaaaaaaaaaaaaaa"
    revisions = iter(("b" * 64, "c" * 64, "d" * 64))
    calls: list[str] = []

    def source_admin(
        _puller: RemoteFeedPuller,
        _alias: str,
        action: str,
        payload: dict[str, object],
    ) -> tuple[dict[str, object], str]:
        calls.append(action)
        revision = next(revisions)
        legacy_source = _source(source_id)
        legacy_source["added_at"] = None
        legacy_source["adapter"] = "ruanyf_weekly"
        legacy_source["last_error_type"] = "ReadTimeout"
        if action == "list":
            return {"sources": [legacy_source], "count": 1}, revision
        if action == "disable":
            assert payload["source_id"] == source_id
            legacy_source["enabled"] = False
            legacy_source["status"] = "disabled"
            return {"source": legacy_source}, revision
        if action == "remove":
            assert payload["confirm"] is True
            return {
                "source_id": source_id,
                "removed": True,
                "historical_state_retained": True,
            }, revision
        raise AssertionError(action)

    monkeypatch.setattr(RemoteFeedPuller, "source_admin", source_admin)

    listed = client.get("/feeds/subscriptions", headers=headers)
    assert listed.status_code == 200
    assert listed.json()["remote_status"] == "current"
    assert listed.json()["sources"][0]["status"] == "enabled"
    assert listed.json()["sources"][0]["added_at"] is None
    assert listed.json()["sources"][0]["adapter"] == "ruanyf_weekly"
    assert listed.json()["sources"][0]["last_error_type"] == "ReadTimeout"

    disabled = client.post(
        f"/feeds/subscriptions/{source_id}/disable",
        headers=headers,
        json={
            "expected_registry_revision": "b" * 64,
            "idempotency_key": "disable-1",
        },
    )
    assert disabled.status_code == 200
    assert disabled.json()["source"]["enabled"] is False

    removed = client.post(
        f"/feeds/subscriptions/{source_id}/remove",
        headers=headers,
        json={
            "expected_registry_revision": "c" * 64,
            "idempotency_key": "remove-1",
            "confirm": True,
        },
    )
    assert removed.status_code == 200
    assert removed.json()["historical_state_retained"] is True
    assert SourceRegistryMirror(paths.state).load().sources[0].status == "removed"

    def offline(
        _puller: RemoteFeedPuller,
        _alias: str,
        _action: str,
        _payload: dict[str, object],
    ) -> tuple[dict[str, object], str]:
        raise RemoteProtocolError("remote_unavailable", "unavailable", retryable=True)

    monkeypatch.setattr(RemoteFeedPuller, "source_admin", offline)
    stale = client.get("/feeds/subscriptions", headers=headers)
    assert stale.status_code == 200
    assert stale.json()["remote_status"] == "stale"
    assert stale.json()["error"] == {
        "code": "remote_unavailable",
        "message": "订阅服务暂时不可用",
        "retryable": True,
    }
    assert stale.json()["sources"][0]["status"] == "removed"
    assert calls == ["list", "disable", "remove"]


def test_subscription_preview_expiry_cas_conflict_and_remote_errors_are_explicit(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    client, headers, paths = _client(vault, tmp_path)
    revision = "a" * 64

    def preview_only(
        _puller: RemoteFeedPuller,
        _alias: str,
        action: str,
        _payload: dict[str, object],
    ) -> tuple[dict[str, object], str]:
        assert action == "preview"
        value = _preview(revision)
        value.pop("_revision")
        return value, revision

    monkeypatch.setattr(RemoteFeedPuller, "source_admin", preview_only)
    preview_id = client.post(
        "/feeds/subscriptions/preview",
        headers=headers,
        json={"url": "https://feeds.example.test/example.xml"},
    ).json()["preview_id"]

    preview_path = next((paths.state / "feed-subscriptions" / "previews").glob("*.json"))
    stored = cast(dict[str, object], json.loads(preview_path.read_text(encoding="utf-8")))
    stored["expires_at"] = (datetime.now(UTC) - timedelta(seconds=1)).isoformat()
    preview_path.write_text(json.dumps(stored), encoding="utf-8")
    expired = client.post(
        "/feeds/subscriptions/confirm",
        headers=headers,
        json={
            "preview_id": preview_id,
            "expected_registry_revision": revision,
            "idempotency_key": "expired-1",
        },
    )
    assert expired.status_code == 410
    assert expired.json()["detail"]["code"] == "preview_expired"

    missing = client.post(
        "/feeds/subscriptions/confirm",
        headers=headers,
        json={
            "preview_id": "unknown-preview",
            "expected_registry_revision": revision,
            "idempotency_key": "missing-1",
        },
    )
    assert missing.status_code == 404
    assert missing.json()["detail"]["code"] == "preview_not_found"


@pytest.mark.parametrize(
    ("code", "retryable", "status_code"),
    (
        ("unsafe_url", False, 400),
        ("source_exists", False, 409),
        ("source_name_conflict", False, 409),
        ("invalid_source_name", False, 422),
        ("discovery_failed", False, 422),
        ("registry_unavailable", True, 503),
        ("command_rejected", False, 403),
    ),
)
def test_subscription_remote_errors_keep_their_public_code_and_status(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    code: str,
    retryable: bool,
    status_code: int,
) -> None:
    client, headers, _paths = _client(vault, tmp_path)

    def rejected(
        _puller: RemoteFeedPuller,
        _alias: str,
        _action: str,
        _payload: dict[str, object],
    ) -> tuple[dict[str, object], str]:
        raise RemoteProtocolError(code, "must not be exposed", retryable=retryable)

    monkeypatch.setattr(RemoteFeedPuller, "source_admin", rejected)
    response = client.post(
        "/feeds/subscriptions/preview",
        headers=headers,
        json={"url": "https://feeds.example.test/example.xml"},
    )
    assert response.status_code == status_code
    assert response.json()["detail"]["code"] == code
    assert response.json()["detail"]["retryable"] is retryable or status_code == 503
    assert "must not be exposed" not in response.text


def test_subscription_list_marks_a_local_mirror_unconfigured(
    vault: Path,
    tmp_path: Path,
) -> None:
    client, headers, paths = _client(vault, tmp_path)
    SourceRegistryMirror(paths.state).replace("a" * 64, [_source()])
    (paths.state / "feed-producers.json").write_text(
        json.dumps({"ai-daily": {"remote_kind": "ai-daily-bridge-v1"}}),
        encoding="utf-8",
    )

    response = client.get("/feeds/subscriptions", headers=headers)

    assert response.status_code == 200
    assert response.json()["remote_status"] == "unconfigured"
    assert response.json()["error"]["code"] == "unconfigured"
    assert response.json()["sources"][0]["source_id"] == _source()["source_id"]


def test_reading_source_overview_merges_registry_empty_disabled_and_removed_cards(
    vault: Path,
    tmp_path: Path,
) -> None:
    client, headers, paths = _client(vault, tmp_path)
    active_id = "feed-111111111111111111111111"
    waiting_id = "feed-222222222222222222222222"
    disabled_id = "feed-333333333333333333333333"
    removed_id = "feed-444444444444444444444444"
    empty_removed_id = "feed-555555555555555555555555"
    active = _source(active_id, name="Active")
    waiting = _source(waiting_id, name="Waiting")
    disabled = _source(disabled_id, name="Disabled", enabled=False, status="disabled")
    removed = _source(removed_id, name="Removed")
    empty_removed = _source(empty_removed_id, name="Empty Removed")
    mirror = SourceRegistryMirror(paths.state)
    mirror.replace(
        "e" * 64,
        [active, waiting, disabled, removed, empty_removed],
    )
    mirror.remove("f" * 64, cast(str, removed["source_id"]))
    mirror.remove("0" * 64, cast(str, empty_removed["source_id"]))

    edition = FeedEdition(
        edition_id="2026-08-23-learning",
        feed=FeedKind.AI_DAILY,
        edition_at="2026-08-23",
        title="订阅阅读",
        stream="learning",
        items=(
            FeedItem(
                item_id="active-item",
                feed=FeedKind.AI_DAILY,
                edition_id="2026-08-23-learning",
                title="Active item",
                body="Body",
                stream="learning",
                source_id=active_id,
                source_name="Active",
            ),
            FeedItem(
                item_id="legacy-item",
                feed=FeedKind.AI_DAILY,
                edition_id="2026-08-23-learning",
                title="Legacy item",
                body="Body",
                stream="learning",
                source_id="legacy-source",
                source_name="Legacy",
            ),
            FeedItem(
                item_id="removed-item",
                feed=FeedKind.AI_DAILY,
                edition_id="2026-08-23-learning",
                title="Removed historical item",
                body="Body",
                stream="learning",
                source_id=removed_id,
                source_name="Removed",
            ),
        ),
    )
    FeedCache(paths.state).put(edition)

    response = client.get(
        "/dashboard/feeds/subscription-sources",
        headers=headers,
        params={"limit": 8},
    )
    assert response.status_code == 200
    page = response.json()
    assert page["registry_revision"] == "0" * 64
    cards = {value["source_id"]: value for value in page["sources"]}
    assert cards[active_id]["status"] == "active"
    assert cards[active_id]["registry_managed"] is True
    assert cards["legacy-source"]["status"] == "active"
    assert cards["legacy-source"]["registry_managed"] is False
    assert cards[removed_id]["status"] == "removed"
    assert cards[removed_id]["latest_digest_id"] == "2026-08-23-learning"
    assert empty_removed_id not in cards
    for source_id, status in (
        (waiting_id, "waiting"),
        (disabled_id, "disabled"),
    ):
        card = cards[source_id]
        assert card["status"] == status
        assert card["latest_digest_id"] is None
        assert card["latest_issued_at"] is None
        assert card["latest_revision"] is None
        assert card["latest_item_count"] == 0
        assert card["preview_items"] == []

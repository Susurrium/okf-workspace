"""Compact, complete Feed projections for fast Dashboard scanning."""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import re
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import TypeGuard, cast
from urllib.parse import urlparse

from okf_workspace.feeds import FeedCache, FeedEdition, FeedItem, FeedKind
from okf_workspace.feeds.cache import FeedSourceCatalogStale
from okf_workspace.feeds.decisions import FeedDecisionStore
from okf_workspace.feeds.editions import item_block_id
from okf_workspace.feeds.models import (
    UNATTRIBUTED_SOURCE_ID,
    UNATTRIBUTED_SOURCE_NAME,
    reading_source_id,
)
from okf_workspace.feeds.subscriptions import ManagementSource, SourceRegistryMirror

_MARKDOWN_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]+\)")
_MARKDOWN_DECORATION = re.compile(r"[#>*_`~-]+")
_PRODUCER_SUMMARY = re.compile(r"(?m)^\*\*摘要：\*\*[ \t]*(?P<value>.+?)[ \t]*$")
_CURSOR_VERSION = 1
_CURSOR_DOMAIN = b"okf-feed-dashboard-cursor-v1\0"
_READING_SNAPSHOT_DOMAIN = b"okf-reading-source-item-snapshot-v1\0"
_READING_PROJECTION_DOMAIN = b"okf-reading-source-projection-v1\0"
_READING_ITEM_PROJECTION_MAX_BYTES = 64 * 1024
_READING_PAGE_PROJECTION_MAX_BYTES = 1024 * 1024


class FeedProjectionTooLarge(ValueError):
    """A bounded Dashboard projection would exceed its transport contract."""


def _excerpt(body: str, *, limit: int = 220) -> str:
    producer_summary = _PRODUCER_SUMMARY.search(body)
    visible = (
        producer_summary.group("value").strip()
        if producer_summary is not None
        else " ".join(
            line.strip()
            for line in body.splitlines()
            if line.strip() and not line.strip().startswith("<!--")
        )
    )
    visible = _MARKDOWN_LINK.sub(r"\1", visible)
    return _MARKDOWN_DECORATION.sub(" ", visible).strip()[:limit]


def _decision(store: FeedDecisionStore, value: FeedItem) -> str | None:
    try:
        stored = store.load(value)
    except (OSError, ValueError):
        return None
    action = stored.get("action") if stored is not None else None
    return str(action) if action else None


def _item(value: FeedItem, decisions: FeedDecisionStore) -> dict[str, object]:
    hostname = urlparse(value.url).netloc if value.url else ""
    declared_source_name = value.source_name.strip() if value.source_name else ""
    if value.stream == "learning":
        source_id = reading_source_id(value)
        source_name = (
            UNATTRIBUTED_SOURCE_NAME
            if source_id == UNATTRIBUTED_SOURCE_ID
            else (declared_source_name or hostname or source_id)
        )
    else:
        source_id = value.source_id or hostname or None
        source_name = declared_source_name or hostname or None
    return {
        "item_id": value.item_id,
        "block_id": item_block_id(value),
        "title": value.title,
        "summary": _excerpt(value.body),
        "url": value.url,
        "source": source_name or "",
        "source_id": source_id,
        "source_name": source_name,
        "native_section": value.native_section,
        "published_at": value.published_at,
        "section": value.stream,
        "pid": value.pid,
        "metrics": value.metrics,
        "comment_count": len(value.comments),
        "media_count": len(value.media),
        "decision": _decision(decisions, value),
    }


def _digest(value: FeedEdition, decisions: FeedDecisionStore) -> dict[str, object]:
    return {
        "digest_id": value.edition_id,
        "issued_at": value.edition_at,
        "title": value.title,
        "section": value.stream,
        "quality": value.quality,
        "quality_reason": value.quality_reason,
        "item_count": len(value.items),
        "items": [_item(item, decisions) for item in value.items],
    }


def _canonical_cursor_payload(payload: Mapping[str, object]) -> bytes:
    return json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _canonical_json_bytes(value: object) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _reading_item_snapshot(items: list[FeedItem]) -> str:
    payload = [item.item_id for item in items]
    return hashlib.sha256(
        _READING_SNAPSHOT_DOMAIN + _canonical_json_bytes(payload)
    ).hexdigest()


def _reading_projection_revision(
    source_id: str,
    digest_id: str,
    items: list[FeedItem],
) -> str:
    payload = {
        "source_id": source_id,
        "digest_id": digest_id,
        "items": [
            {
                "item_id": item.item_id,
                "title": item.title,
                "body": item.body,
                "url": item.url,
                "published_at": item.published_at,
                "stream": item.stream,
                "source_id": item.source_id,
                "source_name": item.source_name,
                "native_section": item.native_section,
                "pid": item.pid,
                "metrics": item.metrics,
                "comment_count": len(item.comments),
                "media_count": len(item.media),
            }
            for item in items
        ],
    }
    return hashlib.sha256(
        _READING_PROJECTION_DOMAIN + _canonical_json_bytes(payload)
    ).hexdigest()


def _bounded_reading_item_projection(
    item: FeedItem,
    decisions: FeedDecisionStore,
) -> dict[str, object]:
    projection = _item(item, decisions)
    encoded_size = len(_canonical_json_bytes(projection))
    if encoded_size > _READING_ITEM_PROJECTION_MAX_BYTES:
        raise FeedProjectionTooLarge(
            "Reading item projection exceeds "
            f"{_READING_ITEM_PROJECTION_MAX_BYTES} bytes: {item.item_id} "
            f"({encoded_size} bytes)"
        )
    return projection


def _bounded_reading_page(payload: dict[str, object]) -> dict[str, object]:
    encoded_size = len(_canonical_json_bytes(payload))
    if encoded_size > _READING_PAGE_PROJECTION_MAX_BYTES:
        raise FeedProjectionTooLarge(
            "Reading page projection exceeds "
            f"{_READING_PAGE_PROJECTION_MAX_BYTES} bytes ({encoded_size} bytes)"
        )
    return payload


def _encode_cursor(payload: Mapping[str, object]) -> str:
    canonical = _canonical_cursor_payload(payload)
    envelope: dict[str, object] = {
        "payload": dict(payload),
        "checksum": hashlib.sha256(_CURSOR_DOMAIN + canonical).hexdigest(),
    }
    encoded = json.dumps(
        envelope,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return base64.urlsafe_b64encode(encoded).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> dict[str, object]:
    try:
        padding = "=" * (-len(cursor) % 4)
        decoded = base64.b64decode(
            cursor + padding,
            altchars=b"-_",
            validate=True,
        ).decode("utf-8")
        loaded = cast(object, json.loads(decoded))
    except (UnicodeDecodeError, ValueError) as error:
        raise ValueError("invalid Feed page cursor") from error
    if not isinstance(loaded, dict):
        raise ValueError("invalid Feed page cursor")
    envelope = cast(Mapping[str, object], loaded)
    payload_value = envelope.get("payload")
    checksum = envelope.get("checksum")
    if not isinstance(payload_value, dict) or not isinstance(checksum, str):
        raise ValueError("invalid Feed page cursor")
    payload = cast(dict[str, object], payload_value)
    expected = hashlib.sha256(_CURSOR_DOMAIN + _canonical_cursor_payload(payload)).hexdigest()
    if not hmac.compare_digest(checksum, expected):
        raise ValueError("invalid Feed page cursor")
    return payload


def _encode_subscription_cursor(edition_id: str, source_id: str | None) -> str:
    return _encode_cursor(
        {
            "version": _CURSOR_VERSION,
            "kind": "subscriptions",
            "edition_id": edition_id,
            "source_id": source_id,
        }
    )


def _decode_subscription_cursor(cursor: str, source_id: str | None) -> str:
    payload = _decode_cursor(cursor)
    if set(payload) != {"version", "kind", "edition_id", "source_id"}:
        raise ValueError("invalid Feed page cursor")
    edition_id = payload.get("edition_id")
    cursor_source_id = payload.get("source_id")
    if (
        payload.get("version") != _CURSOR_VERSION
        or payload.get("kind") != "subscriptions"
        or not isinstance(edition_id, str)
        or not edition_id.endswith("-learning")
        or any(value in edition_id for value in ("/", "\\", ".."))
        or (cursor_source_id is not None and not isinstance(cursor_source_id, str))
    ):
        raise ValueError("invalid Feed page cursor")
    if cursor_source_id != source_id:
        raise ValueError("Feed page cursor does not match the requested source")
    return edition_id


@dataclass(slots=True)
class _ReadingSource:
    source_id: str
    source_name: str
    latest_issued_at: str | None
    latest_digest_id: str | None
    latest_item_count: int
    latest_native_section_counts: dict[str, int]
    edition_count: int
    latest_quality: str | None
    latest_quality_reason: str | None
    status: str
    registry_managed: bool
    enabled: bool | None
    registry_status: str | None
    canonical_url: str | None
    url_redacted: bool | None
    adapter: str | None
    required: bool | None
    last_success_at: str | None
    last_error_at: str | None
    last_error_type: str | None
    last_error: str | None


def _encode_source_cursor(source: _ReadingSource, query: str) -> str:
    return _encode_cursor(
        {
            "version": _CURSOR_VERSION,
            "kind": "subscription-sources",
            "query": query,
            "unattributed": source.source_id == UNATTRIBUTED_SOURCE_ID,
            "latest_issued_at": source.latest_issued_at or "",
            "source_id": source.source_id,
        }
    )


def _decode_source_cursor(cursor: str, query: str) -> tuple[bool, str, str]:
    payload = _decode_cursor(cursor)
    if set(payload) != {
        "version",
        "kind",
        "query",
        "unattributed",
        "latest_issued_at",
        "source_id",
    }:
        raise ValueError("invalid Feed source cursor")
    unattributed = payload.get("unattributed")
    latest_issued_at = payload.get("latest_issued_at")
    source_id = payload.get("source_id")
    cursor_query = payload.get("query")
    if (
        payload.get("version") != _CURSOR_VERSION
        or payload.get("kind") != "subscription-sources"
        or not isinstance(unattributed, bool)
        or not isinstance(latest_issued_at, str)
        or not isinstance(source_id, str)
        or not source_id
        or not isinstance(cursor_query, str)
    ):
        raise ValueError("invalid Feed source cursor")
    if cursor_query != query:
        raise ValueError("Feed source cursor does not match the requested query")
    if unattributed != (source_id == UNATTRIBUTED_SOURCE_ID):
        raise ValueError("invalid Feed source cursor")
    return unattributed, latest_issued_at, source_id


def _encode_source_items_cursor(
    source_id: str,
    digest_id: str,
    next_index: int,
    item_snapshot: str,
    projection_revision: str,
) -> str:
    return _encode_cursor(
        {
            "version": _CURSOR_VERSION,
            "kind": "subscription-source-latest-items",
            "source_id": source_id,
            "digest_id": digest_id,
            "next_index": next_index,
            "item_snapshot": item_snapshot,
            "projection_revision": projection_revision,
        }
    )


def _decode_source_items_cursor(
    cursor: str,
    source_id: str,
) -> tuple[str, int, str, str]:
    payload = _decode_cursor(cursor)
    if set(payload) != {
        "version",
        "kind",
        "source_id",
        "digest_id",
        "next_index",
        "item_snapshot",
        "projection_revision",
    }:
        raise ValueError("invalid Reading source item cursor")
    digest_id = payload.get("digest_id")
    next_index = payload.get("next_index")
    item_snapshot = payload.get("item_snapshot")
    projection_revision = payload.get("projection_revision")
    if (
        payload.get("version") != _CURSOR_VERSION
        or payload.get("kind") != "subscription-source-latest-items"
        or payload.get("source_id") != source_id
        or not isinstance(digest_id, str)
        or not digest_id
        or not isinstance(next_index, int)
        or isinstance(next_index, bool)
        or next_index < 1
        or next_index > 1_000_000
        or not _is_sha256(item_snapshot)
        or not _is_sha256(projection_revision)
    ):
        raise ValueError("invalid Reading source item cursor")
    return digest_id, next_index, item_snapshot, projection_revision


def _is_sha256(value: object) -> TypeGuard[str]:
    return (
        isinstance(value, str)
        and len(value) == 64
        and all(character in "0123456789abcdef" for character in value)
    )


def _comes_after_source_cursor(
    source: _ReadingSource,
    cursor: tuple[bool, str, str],
) -> bool:
    cursor_unattributed, cursor_latest, cursor_source_id = cursor
    unattributed = source.source_id == UNATTRIBUTED_SOURCE_ID
    if unattributed != cursor_unattributed:
        return unattributed and not cursor_unattributed
    source_latest = source.latest_issued_at or ""
    if source_latest != cursor_latest:
        return source_latest < cursor_latest
    return source.source_id > cursor_source_id


def _source_card(
    decisions: FeedDecisionStore,
    source: _ReadingSource,
    edition: FeedEdition | None,
) -> dict[str, object]:
    preview_items: list[dict[str, object]] = []
    matching_items: list[FeedItem] = []
    pending_decision_count = source.latest_item_count
    if edition is not None:
        pending_decision_count = 0
        for item in edition.items:
            if reading_source_id(item) != source.source_id:
                continue
            matching_items.append(item)
            projection = _bounded_reading_item_projection(item, decisions)
            if projection["decision"] is None:
                pending_decision_count += 1
            if len(preview_items) < 3:
                preview_items.append(projection)
    latest_revision = (
        _reading_projection_revision(
            source.source_id,
            source.latest_digest_id,
            matching_items,
        )
        if source.latest_digest_id is not None and edition is not None
        else None
    )
    return {
        "source_id": source.source_id,
        "source_name": source.source_name,
        "latest_issued_at": source.latest_issued_at,
        "latest_digest_id": source.latest_digest_id,
        "latest_revision": latest_revision,
        # The following three fields intentionally describe only the latest
        # edition. Historical undecided items must not inflate a source card.
        "latest_item_count": source.latest_item_count,
        "pending_decision_count": pending_decision_count,
        "native_section_counts": source.latest_native_section_counts,
        "edition_count": source.edition_count,
        "quality": source.latest_quality,
        "quality_reason": source.latest_quality_reason,
        "preview_items": preview_items,
        "status": source.status,
        "registry_managed": source.registry_managed,
        "enabled": source.enabled,
        "registry_status": source.registry_status,
        "canonical_url": source.canonical_url,
        "url_redacted": source.url_redacted,
        "adapter": source.adapter,
        "required": source.required,
        "last_success_at": source.last_success_at,
        "last_error_at": source.last_error_at,
        "last_error_type": source.last_error_type,
        "last_error": source.last_error,
    }


@dataclass(slots=True)
class _RegistryMetadata:
    status: str
    registry_managed: bool
    enabled: bool | None
    registry_status: str | None
    canonical_url: str | None
    url_redacted: bool | None
    adapter: str | None
    required: bool | None
    last_success_at: str | None
    last_error_at: str | None
    last_error_type: str | None
    last_error: str | None


def _registry_metadata(source: ManagementSource | None) -> _RegistryMetadata:
    if source is None:
        return _RegistryMetadata(
            status="active",
            registry_managed=False,
            enabled=None,
            registry_status=None,
            canonical_url=None,
            url_redacted=None,
            adapter=None,
            required=None,
            last_success_at=None,
            last_error_at=None,
            last_error_type=None,
            last_error=None,
        )
    status = (
        "removed"
        if source.status == "removed"
        else "disabled"
        if not source.enabled or source.status == "disabled"
        else "active"
    )
    return _RegistryMetadata(
        status=status,
        registry_managed=True,
        enabled=source.enabled,
        registry_status=source.status,
        canonical_url=source.canonical_url,
        url_redacted=source.url_redacted,
        adapter=source.adapter,
        required=source.required,
        last_success_at=source.last_success_at,
        last_error_at=source.last_error_at,
        last_error_type=source.last_error_type,
        last_error=source.last_error,
    )


def feed_dashboard(state: Path) -> dict[str, object]:
    cache = FeedCache(state)
    decisions = FeedDecisionStore(state)
    streams = [
        edition
        for stream in ("hotspot", "news", "learning")
        if (edition := cache.latest_edition(FeedKind.AI_DAILY, stream=stream)) is not None
    ]
    papers = cache.latest_edition(FeedKind.AI_DAILY, stream="papers")
    treehole = cache.latest_edition(FeedKind.TREEHOLE)
    ai_daily_sync: dict[str, object] | None = None
    sync_status_path = state / "feed-sync" / "ai-daily-stream-status.json"
    try:
        if sync_status_path.stat().st_size <= 1024 * 1024:
            sync_status_value = cast(
                object, json.loads(sync_status_path.read_text(encoding="utf-8"))
            )
            if isinstance(sync_status_value, dict):
                sync_status = cast(Mapping[str, object], sync_status_value)
                if (
                    sync_status.get("version") == 1
                    and isinstance(sync_status.get("updated_at"), str)
                    and isinstance(sync_status.get("streams"), dict)
                ):
                    ai_daily_sync = {
                        "updated_at": sync_status["updated_at"],
                        "streams": sync_status["streams"],
                    }
    except (FileNotFoundError, OSError, ValueError):
        pass
    return {
        "ai_daily": [_digest(edition, decisions) for edition in streams],
        "ai_papers": _digest(papers, decisions) if papers else None,
        "ai_daily_sync": ai_daily_sync,
        "treehole": _digest(treehole, decisions) if treehole else None,
    }


def subscription_sources_dashboard(
    state: Path,
    *,
    limit: int = 8,
    cursor: str | None = None,
    query: str | None = None,
) -> dict[str, object]:
    """Return a stable page of Reading sources and bounded latest-edition previews."""

    if not 1 <= limit <= 8:
        raise ValueError("Reading source page limit must be between 1 and 8")
    normalized_query = (query or "").strip().casefold()
    cursor_value = _decode_source_cursor(cursor, normalized_query) if cursor is not None else None
    cache = FeedCache(state)
    decisions = FeedDecisionStore(state)
    try:
        registry = SourceRegistryMirror(state).load()
    except (OSError, ValueError):
        registry = None
    registry_sources = (
        {value.source_id: value for value in registry.sources}
        if registry is not None
        else {}
    )
    for attempt in range(2):
        try:
            with cache.locked_stream_source_catalog(
                FeedKind.AI_DAILY,
                "learning",
            ) as catalog:
                summaries = list(catalog.sources)
                all_sources: list[_ReadingSource] = []
                for value in summaries:
                    managed = registry_sources.get(value.source_id)
                    metadata = _registry_metadata(managed)
                    all_sources.append(
                        _ReadingSource(
                            source_id=value.source_id,
                            source_name=(
                                managed.source_name if managed is not None else value.source_name
                            ),
                            latest_issued_at=value.latest_issued_at,
                            latest_digest_id=value.latest_digest_id,
                            latest_item_count=value.latest_item_count,
                            latest_native_section_counts=dict(
                                value.latest_native_section_counts
                            ),
                            edition_count=value.edition_count,
                            latest_quality=value.latest_quality,
                            latest_quality_reason=value.latest_quality_reason,
                            status=metadata.status,
                            registry_managed=metadata.registry_managed,
                            enabled=metadata.enabled,
                            registry_status=metadata.registry_status,
                            canonical_url=metadata.canonical_url,
                            url_redacted=metadata.url_redacted,
                            adapter=metadata.adapter,
                            required=metadata.required,
                            last_success_at=metadata.last_success_at,
                            last_error_at=metadata.last_error_at,
                            last_error_type=metadata.last_error_type,
                            last_error=metadata.last_error,
                        )
                    )
                content_ids = {value.source_id for value in all_sources}
                for managed in registry_sources.values():
                    if managed.source_id in content_ids:
                        continue
                    if managed.status == "removed":
                        continue
                    metadata = _registry_metadata(managed)
                    if metadata.status == "active":
                        metadata.status = "waiting"
                    all_sources.append(
                        _ReadingSource(
                            source_id=managed.source_id,
                            source_name=managed.source_name,
                            latest_issued_at=None,
                            latest_digest_id=None,
                            latest_item_count=0,
                            latest_native_section_counts={},
                            edition_count=0,
                            latest_quality=None,
                            latest_quality_reason=None,
                            status=metadata.status,
                            registry_managed=metadata.registry_managed,
                            enabled=metadata.enabled,
                            registry_status=metadata.registry_status,
                            canonical_url=metadata.canonical_url,
                            url_redacted=metadata.url_redacted,
                            adapter=metadata.adapter,
                            required=metadata.required,
                            last_success_at=metadata.last_success_at,
                            last_error_at=metadata.last_error_at,
                            last_error_type=metadata.last_error_type,
                            last_error=metadata.last_error,
                        )
                    )
                known = [
                    value
                    for value in all_sources
                    if value.source_id != UNATTRIBUTED_SOURCE_ID
                ]
                known.sort(key=lambda value: value.source_id)
                known.sort(
                    key=lambda value: value.latest_issued_at or "",
                    reverse=True,
                )
                unattributed = [
                    value
                    for value in all_sources
                    if value.source_id == UNATTRIBUTED_SOURCE_ID
                ]
                all_sources = known + unattributed
                matched = [
                    source
                    for source in all_sources
                    if not normalized_query or normalized_query in source.source_name.casefold()
                ]
                matched_sources = len(matched)
                if cursor_value is not None:
                    matched = [
                        source
                        for source in matched
                        if _comes_after_source_cursor(source, cursor_value)
                    ]
                page = matched[: limit + 1]
                has_more = len(page) > limit
                visible = page[:limit]
                summaries_by_id = {value.source_id: value for value in summaries}
                content_visible = [
                    value for value in visible if value.source_id in summaries_by_id
                ]
                latest_editions = cache.load_source_latest_editions_locked(
                    FeedKind.AI_DAILY,
                    "learning",
                    catalog,
                    (summaries_by_id[value.source_id] for value in content_visible),
                )
                return _bounded_reading_page({
                    "section": "learning",
                    "latest_items_pagination": True,
                    "registry_revision": (
                        registry.registry_revision if registry is not None else None
                    ),
                    "registry_updated_at": (
                        registry.updated_at if registry is not None else None
                    ),
                    "catalog_complete": catalog.complete,
                    "catalog_indexing": catalog.indexing,
                    "sources": [
                        _source_card(
                            decisions,
                            source,
                            (
                                latest_editions[source.latest_digest_id]
                                if source.latest_digest_id is not None
                                else None
                            ),
                        )
                        for source in visible
                    ],
                    "total_sources": len(all_sources),
                    "matched_sources": matched_sources,
                    "next_cursor": _encode_source_cursor(
                        visible[-1],
                        normalized_query,
                    )
                    if has_more and visible
                    else None,
                    "has_more": has_more,
                })
        except FeedSourceCatalogStale:
            if attempt:
                raise
            cache.rebuild_stream_source_catalog(FeedKind.AI_DAILY, "learning")
    raise AssertionError("unreachable Feed source catalog retry")


def subscription_source_latest_items_dashboard(
    state: Path,
    source_id: str,
    *,
    limit: int = 40,
    cursor: str | None = None,
) -> dict[str, object]:
    """Return one bounded page from a Reading source's current latest edition."""

    normalized_source_id = source_id.strip()
    if not normalized_source_id:
        raise ValueError("Reading source id must not be empty")
    if len(normalized_source_id) > 500:
        raise ValueError("Reading source id must not exceed 500 characters")
    if not 1 <= limit <= 50:
        raise ValueError("Reading source item page limit must be between 1 and 50")
    decoded = (
        _decode_source_items_cursor(cursor, normalized_source_id)
        if cursor is not None
        else None
    )
    cache = FeedCache(state)
    decisions = FeedDecisionStore(state)
    for attempt in range(2):
        try:
            with cache.locked_stream_source_catalog(
                FeedKind.AI_DAILY,
                "learning",
            ) as catalog:
                summary = next(
                    (
                        value
                        for value in catalog.sources
                        if value.source_id == normalized_source_id
                    ),
                    None,
                )
                if summary is None:
                    raise KeyError(normalized_source_id)
                edition = cache.load_source_latest_editions_locked(
                    FeedKind.AI_DAILY,
                    "learning",
                    catalog,
                    (summary,),
                )[summary.latest_digest_id]
                matching = [
                    item
                    for item in edition.items
                    if reading_source_id(item) == normalized_source_id
                ]
                if len(matching) != summary.latest_item_count:
                    raise FeedSourceCatalogStale(
                        "Feed source latest item count does not match its catalog"
                    )
                item_snapshot = _reading_item_snapshot(matching)
                projection_revision = _reading_projection_revision(
                    normalized_source_id,
                    summary.latest_digest_id,
                    matching,
                )
                start = 0
                if decoded is not None:
                    digest_id, start, cursor_snapshot, cursor_revision = decoded
                    if digest_id != summary.latest_digest_id:
                        raise ValueError("Reading source latest edition changed")
                    if (
                        cursor_snapshot != item_snapshot
                        or cursor_revision != projection_revision
                        or start > len(matching)
                    ):
                        raise ValueError("Reading source item cursor no longer matches its edition")
                page = matching[start : start + limit]
                next_index = start + len(page)
                has_more = next_index < len(matching)
                projected_items = [
                    _bounded_reading_item_projection(item, decisions) for item in page
                ]
                return _bounded_reading_page({
                    "source_id": normalized_source_id,
                    "digest_id": summary.latest_digest_id,
                    "latest_revision": projection_revision,
                    "issued_at": summary.latest_issued_at,
                    "item_count": len(matching),
                    "items": projected_items,
                    "next_cursor": _encode_source_items_cursor(
                        normalized_source_id,
                        summary.latest_digest_id,
                        next_index,
                        item_snapshot,
                        projection_revision,
                    )
                    if has_more and page
                    else None,
                    "has_more": has_more,
                })
        except FeedSourceCatalogStale:
            if attempt:
                raise
            cache.rebuild_stream_source_catalog(FeedKind.AI_DAILY, "learning")
    raise AssertionError("unreachable Reading source item retry")


def subscription_dashboard(
    state: Path,
    *,
    limit: int = 20,
    cursor: str | None = None,
    source_id: str | None = None,
) -> dict[str, object]:
    """Return a stable page of AI Daily learning editions for Reading."""

    if not 1 <= limit <= 50:
        raise ValueError("Feed page limit must be between 1 and 50")
    normalized_source_id = source_id.strip() if source_id is not None else None
    if source_id is not None and not normalized_source_id:
        raise ValueError("Reading source id must not be empty")
    after = _decode_subscription_cursor(cursor, normalized_source_id) if cursor else None
    cache = FeedCache(state)
    if normalized_source_id is None:
        editions, has_more = cache.list_stream_page(
            FeedKind.AI_DAILY,
            "learning",
            after_edition_id=after,
            limit=limit,
        )
        source_summary = None
        catalog_complete: bool | None = None
        catalog_indexing: bool | None = None
    else:
        editions, has_more, catalog, source_summary = cache.list_stream_source_page(
            FeedKind.AI_DAILY,
            "learning",
            normalized_source_id,
            after_edition_id=after,
            limit=limit,
        )
        catalog_complete = catalog.complete
        catalog_indexing = catalog.indexing
    decisions = FeedDecisionStore(state)
    return {
        "section": "learning",
        "source_id": normalized_source_id,
        "catalog_complete": catalog_complete,
        "catalog_indexing": catalog_indexing,
        "total_editions": max(
            source_summary.edition_count if source_summary is not None else 0,
            len(editions),
        )
        if normalized_source_id is not None
        else None,
        "editions": [_digest(edition, decisions) for edition in editions],
        "next_cursor": _encode_subscription_cursor(
            editions[-1].edition_id,
            normalized_source_id,
        )
        if has_more and editions
        else None,
        "has_more": has_more,
    }

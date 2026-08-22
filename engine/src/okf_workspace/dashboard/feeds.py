"""Compact, complete Feed projections for fast Dashboard scanning."""

from __future__ import annotations

import base64
import re
from pathlib import Path
from urllib.parse import urlparse

from okf_workspace.feeds import FeedCache, FeedEdition, FeedItem, FeedKind
from okf_workspace.feeds.decisions import FeedDecisionStore
from okf_workspace.feeds.editions import item_block_id

_MARKDOWN_LINK = re.compile(r"!?\[([^\]]*)\]\([^)]+\)")
_MARKDOWN_DECORATION = re.compile(r"[#>*_`~-]+")


def _excerpt(body: str, *, limit: int = 220) -> str:
    visible = " ".join(
        line.strip()
        for line in body.splitlines()
        if line.strip() and not line.strip().startswith("<!--")
    )
    visible = _MARKDOWN_LINK.sub(r"\1", visible)
    return _MARKDOWN_DECORATION.sub(" ", visible).strip()[:limit]


def _decision(store: FeedDecisionStore, value: FeedItem) -> str | None:
    stored = store.load(value)
    action = stored.get("action") if stored is not None else None
    return str(action) if action else None


def _item(value: FeedItem, decisions: FeedDecisionStore) -> dict[str, object]:
    hostname = urlparse(value.url).netloc if value.url else ""
    source = value.source_name or hostname
    return {
        "item_id": value.item_id,
        "block_id": item_block_id(value),
        "title": value.title,
        "summary": _excerpt(value.body),
        "url": value.url,
        "source": source,
        "source_id": value.source_id or hostname or None,
        "source_name": value.source_name or hostname or None,
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


def _encode_cursor(edition_id: str) -> str:
    return base64.urlsafe_b64encode(edition_id.encode("utf-8")).decode("ascii").rstrip("=")


def _decode_cursor(cursor: str) -> str:
    try:
        padding = "=" * (-len(cursor) % 4)
        edition_id = base64.b64decode(
            cursor + padding,
            altchars=b"-_",
            validate=True,
        ).decode("utf-8")
    except (UnicodeDecodeError, ValueError) as error:
        raise ValueError("invalid Feed page cursor") from error
    if not edition_id.endswith("-learning") or any(
        value in edition_id for value in ("/", "\\", "..")
    ):
        raise ValueError("invalid Feed page cursor")
    return edition_id


def feed_dashboard(state: Path) -> dict[str, object]:
    cache = FeedCache(state)
    decisions = FeedDecisionStore(state)
    streams = [
        edition
        for stream in ("hotspot", "news", "learning")
        if (edition := cache.latest_edition(FeedKind.AI_DAILY, stream=stream)) is not None
    ]
    treehole = cache.latest_edition(FeedKind.TREEHOLE)
    return {
        "ai_daily": [_digest(edition, decisions) for edition in streams],
        "treehole": _digest(treehole, decisions) if treehole else None,
    }


def subscription_dashboard(
    state: Path,
    *,
    limit: int = 20,
    cursor: str | None = None,
) -> dict[str, object]:
    """Return a stable page of AI Daily learning editions for Reading."""

    if not 1 <= limit <= 50:
        raise ValueError("Feed page limit must be between 1 and 50")
    after = _decode_cursor(cursor) if cursor else None
    cache = FeedCache(state)
    editions, has_more = cache.list_stream_page(
        FeedKind.AI_DAILY,
        "learning",
        after_edition_id=after,
        limit=limit,
    )
    decisions = FeedDecisionStore(state)
    return {
        "section": "learning",
        "editions": [_digest(edition, decisions) for edition in editions],
        "next_cursor": _encode_cursor(editions[-1].edition_id)
        if has_more and editions
        else None,
        "has_more": has_more,
    }

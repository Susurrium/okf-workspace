"""Compact, complete Feed projections for fast Dashboard scanning."""

from __future__ import annotations

import re
from pathlib import Path
from urllib.parse import urlparse

from okf_workspace.feeds import FeedCache, FeedEdition, FeedItem, FeedKind
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


def _item(value: FeedItem) -> dict[str, object]:
    source = urlparse(value.url).netloc if value.url else ""
    return {
        "item_id": value.item_id,
        "block_id": item_block_id(value),
        "title": value.title,
        "summary": _excerpt(value.body),
        "url": value.url,
        "source": source,
        "published_at": value.published_at,
        "section": value.stream,
        "pid": value.pid,
        "metrics": value.metrics,
        "comment_count": len(value.comments),
        "media_count": len(value.media),
    }


def _digest(value: FeedEdition) -> dict[str, object]:
    return {
        "digest_id": value.edition_id,
        "issued_at": value.edition_at,
        "title": value.title,
        "section": value.stream,
        "quality": value.quality,
        "quality_reason": value.quality_reason,
        "item_count": len(value.items),
        "items": [_item(item) for item in value.items],
    }


def feed_dashboard(state: Path) -> dict[str, object]:
    cache = FeedCache(state)
    ai_editions = cache.list_editions(FeedKind.AI_DAILY)
    latest_ai_date = ai_editions[0].edition_at if ai_editions else None
    streams = [edition for edition in ai_editions if edition.edition_at == latest_ai_date]
    stream_order = {"hotspot": 0, "news": 1, "learning": 2}
    streams.sort(key=lambda edition: stream_order.get(edition.stream or "", 99))
    treehole = cache.list_editions(FeedKind.TREEHOLE)
    return {
        "ai_daily": [_digest(edition) for edition in streams],
        "treehole": _digest(treehole[0]) if treehole else None,
    }

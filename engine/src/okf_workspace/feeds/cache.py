"""Store producer payloads outside the Vault; materialize only on user access."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import asdict
from pathlib import Path
from typing import cast

from .models import FeedComment, FeedEdition, FeedItem, FeedKind


def _optional_int(value: object) -> int | None:
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        return None
    try:
        return int(value)
    except ValueError:
        return None


def _item(payload: Mapping[str, object]) -> FeedItem:
    feed = FeedKind(str(payload["feed"]))
    comments_value = payload.get("comments", [])
    media_value = payload.get("media", [])
    metrics_value = payload.get("metrics", {})
    return FeedItem(
        item_id=str(payload["item_id"]),
        feed=feed,
        edition_id=str(payload["edition_id"]),
        title=str(payload["title"]),
        body=str(payload["body"]),
        url=str(payload["url"]) if payload.get("url") else None,
        published_at=(str(payload["published_at"]) if payload.get("published_at") else None),
        stream=str(payload["stream"]) if payload.get("stream") else None,
        pid=_optional_int(payload.get("pid")),
        metrics={
            str(key): value
            for key, value in cast(Mapping[object, object], metrics_value).items()
            if isinstance(value, (float, int, str)) and not isinstance(value, bool)
        }
        if isinstance(metrics_value, Mapping)
        else {},
        comments=tuple(_comment(value) for value in cast(list[object], comments_value))
        if isinstance(comments_value, list)
        else (),
        media=tuple(
            str(value) for value in cast(list[object], media_value) if isinstance(value, str)
        )
        if isinstance(media_value, list)
        else (),
    )


def _comment(value: object) -> FeedComment:
    if isinstance(value, str):
        return FeedComment(text=value)
    if not isinstance(value, dict):
        raise ValueError("feed comment must be a string or object")
    payload = cast(Mapping[str, object], value)
    media = payload.get("media", [])
    return FeedComment(
        text=str(payload.get("text") or ""),
        cid=_optional_int(payload.get("cid")),
        author=str(payload["author"]) if payload.get("author") else None,
        is_original_poster=bool(payload.get("is_original_poster", False)),
        published_at=(str(payload["published_at"]) if payload.get("published_at") else None),
        media=tuple(str(item) for item in cast(list[object], media) if isinstance(item, str))
        if isinstance(media, list)
        else (),
    )


class FeedCache:
    def __init__(self, state_root: Path) -> None:
        self.root = state_root.resolve() / "feed-cache"

    def _path(self, feed: FeedKind, edition_id: str) -> Path:
        if not edition_id or any(value in edition_id for value in ("/", "\\", "..")):
            raise ValueError(f"unsafe edition id: {edition_id!r}")
        return self.root / feed.value / f"{edition_id}.json"

    def put(self, edition: FeedEdition) -> Path:
        target = self._path(edition.feed, edition.edition_id)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(
            json.dumps(asdict(edition), ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
            newline="\n",
        )
        return target

    def get(self, feed: FeedKind, edition_id: str) -> FeedEdition:
        path = self._path(feed, edition_id)
        loaded_object = cast(object, json.loads(path.read_text(encoding="utf-8")))
        if not isinstance(loaded_object, dict):
            raise ValueError(f"invalid feed edition: {path}")
        payload = cast(Mapping[str, object], loaded_object)
        items_value = payload.get("items")
        if not isinstance(items_value, list):
            raise ValueError(f"feed edition has no items: {path}")
        return FeedEdition(
            edition_id=str(payload["edition_id"]),
            feed=FeedKind(str(payload["feed"])),
            edition_at=str(payload["edition_at"]),
            title=str(payload["title"]),
            items=tuple(
                _item(cast(Mapping[str, object], item))
                for item in cast(list[object], items_value)
                if isinstance(item, dict)
            ),
            stream=str(payload["stream"]) if payload.get("stream") else None,
            quality=str(payload["quality"]) if payload.get("quality") else None,
            quality_reason=(
                str(payload["quality_reason"]) if payload.get("quality_reason") else None
            ),
        )

    def list_editions(self, feed: FeedKind) -> list[FeedEdition]:
        directory = self.root / feed.value
        if not directory.is_dir():
            return []
        editions = [self.get(feed, path.stem) for path in directory.glob("*.json")]
        return sorted(editions, key=lambda edition: edition.edition_at, reverse=True)

    def find_item(self, feed: FeedKind, item_id: str) -> FeedItem:
        for edition in self.list_editions(feed):
            for item in edition.items:
                if item.item_id == item_id:
                    return item
        raise KeyError(item_id)

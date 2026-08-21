"""Pull existing external feed producer outputs into the rebuildable cache."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import replace
from pathlib import Path
from typing import cast

import httpx

from .adapters import ai_daily_from_v1, ai_daily_markdown_from_v1, treehole_from_v1
from .cache import FeedCache
from .models import FeedEdition, FeedKind
from .remote import RemoteFeedPuller, treehole_capture_context


class FeedSyncer:
    def __init__(self, state: Path) -> None:
        self.state = state.resolve()
        self.config_path = self.state / "feed-producers.json"
        self.cache = FeedCache(self.state)

    def _config(self) -> Mapping[str, object]:
        if not self.config_path.is_file():
            raise FileNotFoundError(
                "feed producer config is missing; create State/feed-producers.json"
            )
        loaded = cast(object, json.loads(self.config_path.read_text(encoding="utf-8")))
        if not isinstance(loaded, dict):
            raise ValueError("feed-producers.json must contain a JSON object")
        return cast(Mapping[str, object], loaded)

    def _payload(self, config: Mapping[str, object]) -> dict[str, object]:
        path_value = config.get("payload_path")
        if isinstance(path_value, str) and path_value:
            raw = Path(path_value).expanduser().resolve().read_text(encoding="utf-8")
        else:
            url = config.get("url")
            if not isinstance(url, str) or not url:
                raise ValueError("producer requires payload_path or url")
            headers: dict[str, str] = {}
            token_file = config.get("token_file")
            if isinstance(token_file, str) and token_file:
                token = Path(token_file).expanduser().read_text(encoding="utf-8").strip()
                headers["Authorization"] = f"Bearer {token}"
            raw = httpx.get(url, headers=headers, timeout=20).text
        loaded = cast(object, json.loads(raw))
        if not isinstance(loaded, dict):
            raise ValueError("feed producer payload must be a JSON object")
        return cast(dict[str, object], loaded)

    def _content_map(self, config: Mapping[str, object]) -> dict[str, str]:
        value = config.get("content_map_path")
        if not isinstance(value, str) or not value:
            return {}
        loaded = cast(
            object,
            json.loads(Path(value).expanduser().resolve().read_text(encoding="utf-8")),
        )
        if not isinstance(loaded, dict):
            raise ValueError("AI Daily content map must be a JSON object")
        return {
            str(key): str(content) for key, content in cast(Mapping[object, object], loaded).items()
        }

    def sync(self, feed: FeedKind) -> tuple[FeedEdition, ...]:
        feed_config = self._config().get(feed.value)
        if not isinstance(feed_config, dict):
            raise ValueError(f"producer is not configured: {feed.value}")
        config = cast(Mapping[str, object], feed_config)
        remote_kind = config.get("remote_kind")
        ssh_alias = config.get("ssh_alias")
        if isinstance(remote_kind, str):
            if not isinstance(ssh_alias, str) or not ssh_alias:
                raise ValueError("remote producer requires ssh_alias")
            puller = RemoteFeedPuller(self.state)
            if feed is FeedKind.AI_DAILY and remote_kind == "ai-daily-bridge-v1":
                editions = [
                    ai_daily_markdown_from_v1(markdown, stream=stream)
                    for stream, markdown in puller.ai_daily(ssh_alias)
                ]
            elif feed is FeedKind.TREEHOLE and remote_kind == "treehole-observer-v1":
                payload, captures = puller.treehole(ssh_alias)
                comments, media = treehole_capture_context(captures)
                editions = [
                    treehole_from_v1(
                        payload,
                        comments_by_pid=comments,
                        media_by_pid=media,
                    )
                ]
            else:
                raise ValueError(f"unsupported remote producer: {remote_kind}")
        else:
            payload = self._payload(config)
            editions = (
                ai_daily_from_v1(
                    payload,
                    content_by_artifact=self._content_map(config),
                )
                if feed is FeedKind.AI_DAILY
                else [treehole_from_v1(payload)]
            )
        for edition in editions:
            self.cache.put(edition)
        if feed is FeedKind.TREEHOLE:
            self.refresh_treehole_archives()
        return tuple(editions)

    def refresh_treehole_archives(self) -> int:
        """Enrich historical cached batches from retained V1 capture archives."""

        refreshed = 0
        archive_root = self.state / "feed-producer-input" / "treehole"
        if not archive_root.is_dir():
            return refreshed
        for archive in sorted(archive_root.glob("*.zip")):
            try:
                edition = self.cache.get(FeedKind.TREEHOLE, archive.stem)
                comments, media = treehole_capture_context(archive)
            except (FileNotFoundError, KeyError, OSError, ValueError):
                continue
            items = tuple(
                replace(
                    item,
                    comments=comments.get(item.pid, item.comments) if item.pid is not None else (),
                    media=media.get(item.pid, item.media) if item.pid is not None else item.media,
                )
                for item in edition.items
            )
            self.cache.put(replace(edition, items=items))
            refreshed += 1
        return refreshed

    def sync_all(self) -> dict[FeedKind, tuple[FeedEdition, ...]]:
        configured = self._config()
        return {
            feed: self.sync(feed)
            for feed in FeedKind
            if isinstance(configured.get(feed.value), dict)
        }

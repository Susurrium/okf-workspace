"""Pull existing external feed producer outputs into the rebuildable cache."""

from __future__ import annotations

import json
import subprocess
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import cast

import httpx

from .adapters import ai_daily_from_v1, ai_daily_markdown_from_v1, treehole_from_v1
from .cache import FeedCache
from .models import FeedEdition, FeedKind
from .remote import RemoteFeedPuller, treehole_capture_context

_AI_DAILY_STREAMS = ("hotspot", "news", "learning")


@dataclass(frozen=True, slots=True)
class FeedSyncFailure:
    feed: FeedKind
    stream: str | None
    detail: str


class FeedSyncer:
    def __init__(self, state: Path) -> None:
        self.state = state.resolve()
        self.config_path = self.state / "feed-producers.json"
        self.cache = FeedCache(self.state)
        self._failures: list[FeedSyncFailure] = []

    @property
    def failures(self) -> tuple[FeedSyncFailure, ...]:
        return tuple(self._failures)

    def _record_failure(
        self,
        feed: FeedKind,
        error: BaseException,
        *,
        stream: str | None = None,
    ) -> None:
        detail = " ".join(str(error).split()) or error.__class__.__name__
        self._failures.append(
            FeedSyncFailure(feed=feed, stream=stream, detail=detail[:300])
        )

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

    def _sync(self, feed: FeedKind) -> tuple[FeedEdition, ...]:
        failure_count = len(self._failures)
        feed_config = self._config().get(feed.value)
        if not isinstance(feed_config, dict):
            raise ValueError(f"producer is not configured: {feed.value}")
        config = cast(Mapping[str, object], feed_config)
        remote_kind = config.get("remote_kind")
        ssh_alias = config.get("ssh_alias")
        editions: list[FeedEdition]
        if isinstance(remote_kind, str):
            if not isinstance(ssh_alias, str) or not ssh_alias:
                raise ValueError("remote producer requires ssh_alias")
            puller = RemoteFeedPuller(self.state)
            if feed is FeedKind.AI_DAILY and remote_kind == "ai-daily-bridge-v1":
                editions = []
                documents = puller.ai_daily(ssh_alias)
                returned_streams = {stream for stream, _markdown in documents}
                for missing_stream in _AI_DAILY_STREAMS:
                    if missing_stream not in returned_streams:
                        self._record_failure(
                            feed,
                            ValueError("AI Daily producer returned no document"),
                            stream=missing_stream,
                        )
                for stream, markdown in documents:
                    try:
                        editions.append(ai_daily_markdown_from_v1(markdown, stream=stream))
                    except (KeyError, TypeError, ValueError) as error:
                        self._record_failure(feed, error, stream=stream)
                if not editions and len(self._failures) == failure_count:
                    raise ValueError("AI Daily producer returned no valid stream")
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
            if feed is FeedKind.AI_DAILY:
                streams_value = payload.get("streams")
                if not isinstance(streams_value, list):
                    raise ValueError("AI Daily issue has no streams")
                content_map = self._content_map(config)
                editions = []
                for stream_object in cast(list[object], streams_value):
                    if not isinstance(stream_object, dict):
                        self._record_failure(
                            feed,
                            TypeError("AI Daily stream must be an object"),
                        )
                        continue
                    stream_name = (
                        str(cast(Mapping[str, object], stream_object).get("stream") or "")
                    )
                    isolated_payload = dict(payload)
                    isolated_payload["streams"] = [stream_object]
                    try:
                        editions.extend(
                            ai_daily_from_v1(
                                isolated_payload,
                                content_by_artifact=content_map,
                            )
                        )
                    except (KeyError, TypeError, ValueError) as error:
                        self._record_failure(feed, error, stream=stream_name)
                if not editions and len(self._failures) == failure_count:
                    raise ValueError("AI Daily producer returned no valid stream")
            else:
                editions = [treehole_from_v1(payload)]
        stored: list[FeedEdition] = []
        for edition in editions:
            try:
                self.cache.put(edition)
            except OSError as error:
                self._record_failure(feed, error, stream=edition.stream)
            else:
                stored.append(edition)
        if feed is FeedKind.TREEHOLE and stored:
            self.refresh_treehole_archives()
        return tuple(stored)

    def sync(self, feed: FeedKind) -> tuple[FeedEdition, ...]:
        self._failures.clear()
        return self._sync(feed)

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
        self._failures.clear()
        synchronized: dict[FeedKind, tuple[FeedEdition, ...]] = {}
        for feed in FeedKind:
            if not isinstance(configured.get(feed.value), dict):
                continue
            try:
                synchronized[feed] = self._sync(feed)
            except (
                KeyError,
                OSError,
                RuntimeError,
                TypeError,
                ValueError,
                httpx.HTTPError,
                subprocess.SubprocessError,
            ) as error:
                self._record_failure(feed, error)
                synchronized[feed] = ()
        return synchronized

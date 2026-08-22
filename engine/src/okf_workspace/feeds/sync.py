"""Pull existing external feed producer outputs into the rebuildable cache."""

from __future__ import annotations

import hashlib
import json
import os
import subprocess
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass, replace
from pathlib import Path
from typing import cast

import httpx

from .adapters import (
    ai_daily_from_v1,
    ai_daily_markdown_from_v1,
    legacy_source_identity,
    treehole_from_v1,
)
from .cache import FeedCache
from .models import (
    UNATTRIBUTED_SOURCE_ID,
    FeedEdition,
    FeedItem,
    FeedKind,
    reading_source_id,
)
from .remote import RemoteFeedPuller, treehole_capture_context

_AI_DAILY_STREAMS = ("hotspot", "news", "learning")
_SOURCE_ID_MIGRATION_VERSION = 1


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

    def _reconcile_learning_source_ids(
        self,
        incoming: list[FeedEdition],
        source_ids_by_name: Mapping[str, str],
    ) -> None:
        """Canonicalize incoming items and migrate legacy history once per registry.

        Producer registry IDs are the identity authority.  A checksum marker
        makes the unbounded historical pass a one-time migration instead of a
        cost paid by every daily sync.  When the registry or its aliases change,
        the checksum changes and history is reconciled once more.
        """

        stable_ids = {
            name.strip().casefold(): source_id.strip()
            for name, source_id in source_ids_by_name.items()
            if name.strip() and source_id.strip()
        }
        if not stable_ids:
            return

        def upgrade(edition: FeedEdition) -> FeedEdition | None:
            if edition.stream != "learning":
                return None
            changed = False
            items: list[FeedItem] = []
            for item in edition.items:
                name = item.source_name.strip() if item.source_name else ""
                stable_id = stable_ids.get(name.casefold()) if name else None
                if (
                    stable_id is not None
                    and reading_source_id(item) != stable_id
                    and reading_source_id(item)
                    in {
                        UNATTRIBUTED_SOURCE_ID,
                        legacy_source_identity(name, item.url),
                    }
                ):
                    item = replace(item, source_id=stable_id)
                    changed = True
                items.append(item)
            return replace(edition, items=tuple(items)) if changed else None

        for position, edition in enumerate(incoming):
            upgraded = upgrade(edition)
            if upgraded is not None:
                incoming[position] = upgraded

        canonical_registry = json.dumps(
            sorted(stable_ids.items()),
            ensure_ascii=False,
            separators=(",", ":"),
        ).encode("utf-8")
        registry_checksum = hashlib.sha256(canonical_registry).hexdigest()
        marker = (
            self.state
            / "feed-cache"
            / "metadata"
            / "migrations"
            / "ai-daily-learning-source-ids.json"
        )
        try:
            loaded = cast(object, json.loads(marker.read_text(encoding="utf-8")))
        except (FileNotFoundError, OSError, ValueError):
            loaded = None
        marker_payload: Mapping[str, object] = (
            cast(Mapping[str, object], loaded)
            if isinstance(loaded, dict)
            else {}
        )
        if (
            marker_payload.get("version") == _SOURCE_ID_MIGRATION_VERSION
            and marker_payload.get("registry_checksum") == registry_checksum
        ):
            return

        indexes = tuple(self.cache.iter_stream_indexes(FeedKind.AI_DAILY, "learning"))
        cache_was_rewritten = False
        migration_failed = False
        for index in indexes:
            needs_upgrade = any(
                item.source_name
                and (stable_id := stable_ids.get(item.source_name.casefold())) is not None
                and item.source_id == legacy_source_identity(item.source_name, None)
                and item.source_id != stable_id
                for item in index.items
            )
            if not needs_upgrade:
                continue
            try:
                edition = self.cache.get(FeedKind.AI_DAILY, index.edition_id)
            except (FileNotFoundError, KeyError, OSError, ValueError):
                continue
            upgraded = upgrade(edition)
            if upgraded is None:
                continue
            try:
                self.cache.put(
                    upgraded,
                    schedule_source_catalog_rebuild=False,
                )
            except OSError as error:
                migration_failed = True
                self._record_failure(
                    FeedKind.AI_DAILY,
                    error,
                    stream="learning",
                )
            else:
                cache_was_rewritten = True
        if cache_was_rewritten:
            try:
                self.cache.rebuild_stream_source_catalog(
                    FeedKind.AI_DAILY,
                    "learning",
                )
            except (KeyError, OSError, ValueError) as error:
                migration_failed = True
                self._record_failure(
                    FeedKind.AI_DAILY,
                    error,
                    stream="learning",
                )
        if migration_failed:
            return
        try:
            marker.parent.mkdir(parents=True, exist_ok=True)
            descriptor, temporary_name = tempfile.mkstemp(
                prefix=f".{marker.name}.",
                suffix=".tmp",
                dir=marker.parent,
            )
            temporary = Path(temporary_name)
            try:
                with os.fdopen(
                    descriptor,
                    "w",
                    encoding="utf-8",
                    newline="\n",
                ) as handle:
                    json.dump(
                        {
                            "version": _SOURCE_ID_MIGRATION_VERSION,
                            "registry_checksum": registry_checksum,
                        },
                        handle,
                        ensure_ascii=True,
                        indent=2,
                    )
                    handle.write("\n")
                    handle.flush()
                    os.fsync(handle.fileno())
                os.replace(temporary, marker)
            finally:
                temporary.unlink(missing_ok=True)
        except OSError as error:
            self._record_failure(
                FeedKind.AI_DAILY,
                error,
                stream="learning",
            )

    def _sync(self, feed: FeedKind) -> tuple[FeedEdition, ...]:
        failure_count = len(self._failures)
        feed_config = self._config().get(feed.value)
        if not isinstance(feed_config, dict):
            raise ValueError(f"producer is not configured: {feed.value}")
        config = cast(Mapping[str, object], feed_config)
        remote_kind = config.get("remote_kind")
        ssh_alias = config.get("ssh_alias")
        editions: list[FeedEdition]
        source_ids_by_name: Mapping[str, str] = {}
        if isinstance(remote_kind, str):
            if not isinstance(ssh_alias, str) or not ssh_alias:
                raise ValueError("remote producer requires ssh_alias")
            puller = RemoteFeedPuller(self.state)
            if feed is FeedKind.AI_DAILY and remote_kind == "ai-daily-bridge-v1":
                editions = []
                documents = puller.ai_daily(ssh_alias)
                source_ids_by_name = puller.ai_daily_source_ids_by_name
                for warning in puller.ai_daily_registry_warnings:
                    self._record_failure(
                        feed,
                        ValueError(f"AI Daily source registry: {warning}"),
                        stream="learning",
                    )
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
                        editions.append(
                            ai_daily_markdown_from_v1(
                                markdown,
                                stream=stream,
                                source_ids_by_name=(
                                    source_ids_by_name
                                    if stream == "learning"
                                    else None
                                ),
                            )
                        )
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
        if feed is FeedKind.AI_DAILY:
            self._reconcile_learning_source_ids(editions, source_ids_by_name)
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

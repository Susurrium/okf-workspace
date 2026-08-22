"""Store producer payloads outside the Vault; materialize only on user access."""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import tempfile
import threading
from collections import Counter
from collections.abc import Generator, Iterable, Iterator, Mapping
from contextlib import contextmanager
from dataclasses import asdict, dataclass, replace
from importlib import import_module
from pathlib import Path
from typing import Protocol, cast

from .models import (
    UNATTRIBUTED_SOURCE_ID,
    UNATTRIBUTED_SOURCE_NAME,
    FeedComment,
    FeedEdition,
    FeedItem,
    FeedKind,
    reading_source_id,
)

_INDEX_VERSION = 2
_INDEX_DOMAIN = b"okf-feed-edition-index-v2\0"
_SOURCE_CATALOG_VERSION = 2
_SOURCE_CATALOG_DOMAIN = b"okf-feed-source-catalog-v2\0"
_SOURCE_CATALOG_BUILDS: set[str] = set()
_SOURCE_CATALOG_BUILDS_LOCK = threading.Lock()


def _index_checksum(payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(_INDEX_DOMAIN + encoded).hexdigest()


def _source_catalog_checksum(payload: Mapping[str, object]) -> str:
    encoded = json.dumps(
        payload,
        ensure_ascii=False,
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")
    return hashlib.sha256(_SOURCE_CATALOG_DOMAIN + encoded).hexdigest()


@dataclass(frozen=True, slots=True)
class FeedIndexItem:
    """Small item metadata used to navigate history without loading bodies."""

    item_id: str
    source_id: str
    source_name: str | None
    native_section: str | None


@dataclass(frozen=True, slots=True)
class FeedEditionIndex:
    """Sidecar metadata for one cached edition."""

    edition_id: str
    feed: FeedKind
    edition_at: str
    stream: str | None
    cache_size: int
    cache_mtime_ns: int
    quality: str | None
    quality_reason: str | None
    items: tuple[FeedIndexItem, ...]


@dataclass(frozen=True, slots=True)
class FeedSourceSummary:
    """Materialized per-source projection used by the Reading overview."""

    source_id: str
    source_name: str
    latest_issued_at: str
    latest_digest_id: str
    latest_item_count: int
    latest_native_section_counts: tuple[tuple[str, int], ...]
    edition_count: int
    edition_ids: tuple[str, ...]
    latest_quality: str | None
    latest_quality_reason: str | None


@dataclass(frozen=True, slots=True)
class FeedSourceCatalog:
    """One consistent materialized Reading-source catalog snapshot."""

    complete: bool
    indexing: bool
    sources: tuple[FeedSourceSummary, ...]


class FeedSourceCatalogStale(ValueError):
    """The derived catalog does not match its current edition files."""


class _WindowsFileLock(Protocol):
    LK_LOCK: int
    LK_UNLCK: int

    def locking(self, file_descriptor: int, mode: int, byte_count: int) -> None: ...


class _PosixFileLock(Protocol):
    LOCK_EX: int
    LOCK_UN: int

    def flock(self, file_descriptor: int, operation: int) -> None: ...


@contextmanager
def _exclusive_file_lock(path: Path) -> Generator[None]:
    """Serialize pointer compare-and-replace across threads and processes."""

    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor = os.open(path, os.O_RDWR | os.O_CREAT, 0o600)
    with os.fdopen(descriptor, "r+b") as handle:
        handle.seek(0)
        if os.name == "nt":
            locker = cast(_WindowsFileLock, import_module("msvcrt"))
            locker.locking(handle.fileno(), locker.LK_LOCK, 1)
            try:
                if os.fstat(handle.fileno()).st_size == 0:
                    handle.write(b"\0")
                    handle.flush()
                yield
            finally:
                handle.seek(0)
                locker.locking(handle.fileno(), locker.LK_UNLCK, 1)
        else:
            locker = cast(_PosixFileLock, import_module("fcntl"))
            locker.flock(handle.fileno(), locker.LOCK_EX)
            try:
                if os.fstat(handle.fileno()).st_size == 0:
                    handle.write(b"\0")
                    handle.flush()
                yield
            finally:
                locker.flock(handle.fileno(), locker.LOCK_UN)


def _write_json_atomic(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump(payload, handle, ensure_ascii=False, indent=2)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


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
        source_id=str(payload["source_id"]) if payload.get("source_id") else None,
        source_name=str(payload["source_name"]) if payload.get("source_name") else None,
        native_section=(str(payload["native_section"]) if payload.get("native_section") else None),
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
        reply_to_cid=_optional_int(payload.get("reply_to_cid")),
        reply_to_author=(
            str(payload["reply_to_author"]) if payload.get("reply_to_author") else None
        ),
        reply_to_text=(str(payload["reply_to_text"]) if payload.get("reply_to_text") else None),
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

    def _index_path(self, feed: FeedKind, edition_id: str) -> Path:
        self._path(feed, edition_id)
        return self.root / "metadata" / feed.value / f"{edition_id}.json"

    def _edition_index(self, edition: FeedEdition, cache_path: Path) -> FeedEditionIndex:
        stat = cache_path.stat()
        return FeedEditionIndex(
            edition_id=edition.edition_id,
            feed=edition.feed,
            edition_at=edition.edition_at,
            stream=edition.stream,
            cache_size=stat.st_size,
            cache_mtime_ns=stat.st_mtime_ns,
            quality=edition.quality,
            quality_reason=edition.quality_reason,
            items=tuple(
                FeedIndexItem(
                    item_id=item.item_id,
                    source_id=reading_source_id(item),
                    source_name=item.source_name.strip() if item.source_name else None,
                    native_section=(item.native_section.strip() if item.native_section else None),
                )
                for item in edition.items
            ),
        )

    def _write_index(self, value: FeedEditionIndex) -> None:
        payload: dict[str, object] = {
            "version": _INDEX_VERSION,
            "edition_id": value.edition_id,
            "feed": value.feed.value,
            "edition_at": value.edition_at,
            "stream": value.stream,
            "cache_size": value.cache_size,
            "cache_mtime_ns": value.cache_mtime_ns,
            "quality": value.quality,
            "quality_reason": value.quality_reason,
            "items": [asdict(item) for item in value.items],
        }
        payload["checksum"] = _index_checksum(payload)
        _write_json_atomic(
            self._index_path(value.feed, value.edition_id),
            payload,
        )

    def _read_index(
        self,
        feed: FeedKind,
        edition_id: str,
        cache_path: Path,
    ) -> FeedEditionIndex:
        index_path = self._index_path(feed, edition_id)
        loaded_object = cast(object, json.loads(index_path.read_text(encoding="utf-8")))
        if not isinstance(loaded_object, dict):
            raise ValueError(f"invalid feed edition metadata: {index_path}")
        payload = cast(Mapping[str, object], loaded_object)
        expected_keys = {
            "version",
            "edition_id",
            "feed",
            "edition_at",
            "stream",
            "cache_size",
            "cache_mtime_ns",
            "quality",
            "quality_reason",
            "items",
            "checksum",
        }
        checksum = payload.get("checksum")
        unsigned = {key: value for key, value in payload.items() if key != "checksum"}
        if (
            set(payload) != expected_keys
            or not isinstance(checksum, str)
            or not hmac.compare_digest(checksum, _index_checksum(unsigned))
        ):
            raise ValueError(f"invalid feed edition metadata: {index_path}")
        stat = cache_path.stat()
        if (
            payload.get("version") != _INDEX_VERSION
            or payload.get("feed") != feed.value
            or payload.get("edition_id") != edition_id
            or payload.get("cache_size") != stat.st_size
            or payload.get("cache_mtime_ns") != stat.st_mtime_ns
        ):
            raise ValueError(f"stale feed edition metadata: {index_path}")
        edition_at = payload.get("edition_at")
        stream = payload.get("stream")
        quality = payload.get("quality")
        quality_reason = payload.get("quality_reason")
        items_value = payload.get("items")
        if not isinstance(edition_at, str) or not edition_at or not isinstance(items_value, list):
            raise ValueError(f"invalid feed edition metadata: {index_path}")
        if stream is not None and not isinstance(stream, str):
            raise ValueError(f"invalid feed edition metadata: {index_path}")
        if quality is not None and not isinstance(quality, str):
            raise ValueError(f"invalid feed edition metadata: {index_path}")
        if quality_reason is not None and not isinstance(quality_reason, str):
            raise ValueError(f"invalid feed edition metadata: {index_path}")
        items: list[FeedIndexItem] = []
        for raw_item in cast(list[object], items_value):
            if not isinstance(raw_item, dict):
                raise ValueError(f"invalid feed edition metadata: {index_path}")
            item = cast(Mapping[str, object], raw_item)
            item_id = item.get("item_id")
            source_id = item.get("source_id")
            source_name = item.get("source_name")
            native_section = item.get("native_section")
            if (
                not isinstance(item_id, str)
                or not item_id
                or not isinstance(source_id, str)
                or not source_id
            ):
                raise ValueError(f"invalid feed edition metadata: {index_path}")
            if source_name is not None and not isinstance(source_name, str):
                raise ValueError(f"invalid feed edition metadata: {index_path}")
            if native_section is not None and not isinstance(native_section, str):
                raise ValueError(f"invalid feed edition metadata: {index_path}")
            items.append(
                FeedIndexItem(
                    item_id=item_id,
                    source_id=source_id,
                    source_name=source_name,
                    native_section=native_section,
                )
            )
        return FeedEditionIndex(
            edition_id=edition_id,
            feed=feed,
            edition_at=edition_at,
            stream=stream,
            cache_size=stat.st_size,
            cache_mtime_ns=stat.st_mtime_ns,
            quality=quality,
            quality_reason=quality_reason,
            items=tuple(items),
        )

    def _load_or_repair_index(
        self,
        feed: FeedKind,
        cache_path: Path,
    ) -> FeedEditionIndex:
        try:
            return self._read_index(feed, cache_path.stem, cache_path)
        except (FileNotFoundError, KeyError, OSError, ValueError):
            pass
        with _exclusive_file_lock(cache_path.with_suffix(".lock")):
            try:
                return self._read_index(feed, cache_path.stem, cache_path)
            except (FileNotFoundError, KeyError, OSError, ValueError):
                edition = self.get(feed, cache_path.stem)
                value = self._edition_index(edition, cache_path)
                self._write_index(value)
                return value

    def _source_catalog_path(self, feed: FeedKind, stream: str) -> Path:
        if not stream or any(value in stream for value in ("/", "\\", "..")):
            raise ValueError(f"unsafe feed stream: {stream!r}")
        return self.root / "metadata" / "sources" / feed.value / f"{stream}.json"

    def _source_catalog_lock_path(self, feed: FeedKind, stream: str) -> Path:
        return self._source_catalog_path(feed, stream).with_suffix(".lock")

    @staticmethod
    def _source_name(source_id: str, items: list[FeedIndexItem]) -> str:
        if source_id == UNATTRIBUTED_SOURCE_ID:
            return UNATTRIBUTED_SOURCE_NAME
        return next((item.source_name for item in items if item.source_name), source_id)

    @staticmethod
    def _source_section_counts(items: list[FeedIndexItem]) -> tuple[tuple[str, int], ...]:
        counts = Counter(item.native_section or "未分类" for item in items)
        return tuple(sorted(counts.items()))

    @classmethod
    def _source_summaries_from_indexes(
        cls,
        indexes: Iterable[FeedEditionIndex],
    ) -> tuple[FeedSourceSummary, ...]:
        occurrences: dict[
            str,
            list[tuple[FeedEditionIndex, list[FeedIndexItem]]],
        ] = {}
        for edition in indexes:
            grouped: dict[str, list[FeedIndexItem]] = {}
            for item in edition.items:
                grouped.setdefault(item.source_id, []).append(item)
            for source_id, items in grouped.items():
                occurrences.setdefault(source_id, []).append((edition, items))
        sources: dict[str, FeedSourceSummary] = {}
        for source_id, values in occurrences.items():
            ordered = sorted(
                values,
                key=lambda value: value[0].edition_id,
                reverse=True,
            )
            latest, latest_items = ordered[0]
            source_name = next(
                (
                    cls._source_name(source_id, items)
                    for _edition, items in ordered
                    if cls._source_name(source_id, items) != source_id
                ),
                cls._source_name(source_id, latest_items),
            )
            edition_ids = tuple(edition.edition_id for edition, _items in ordered)
            sources[source_id] = FeedSourceSummary(
                source_id=source_id,
                source_name=source_name,
                latest_issued_at=latest.edition_at,
                latest_digest_id=latest.edition_id,
                latest_item_count=len(latest_items),
                latest_native_section_counts=cls._source_section_counts(latest_items),
                edition_count=len(edition_ids),
                edition_ids=edition_ids,
                latest_quality=latest.quality,
                latest_quality_reason=latest.quality_reason,
            )
        return cls._sort_source_summaries(sources.values())

    @staticmethod
    def _sort_source_summaries(
        values: Iterable[FeedSourceSummary],
    ) -> tuple[FeedSourceSummary, ...]:
        sources = list(values)
        known = [value for value in sources if value.source_id != UNATTRIBUTED_SOURCE_ID]
        known.sort(key=lambda value: value.source_id)
        known.sort(key=lambda value: value.latest_issued_at, reverse=True)
        unattributed = [value for value in sources if value.source_id == UNATTRIBUTED_SOURCE_ID]
        return tuple(known + unattributed)

    def _write_source_catalog(
        self,
        feed: FeedKind,
        stream: str,
        *,
        complete: bool,
        sources: tuple[FeedSourceSummary, ...],
    ) -> None:
        payload: dict[str, object] = {
            "version": _SOURCE_CATALOG_VERSION,
            "feed": feed.value,
            "stream": stream,
            "complete": complete,
            "sources": [
                {
                    "source_id": source.source_id,
                    "source_name": source.source_name,
                    "latest_issued_at": source.latest_issued_at,
                    "latest_digest_id": source.latest_digest_id,
                    "latest_item_count": source.latest_item_count,
                    "latest_native_section_counts": dict(source.latest_native_section_counts),
                    "edition_count": source.edition_count,
                    "edition_ids": list(source.edition_ids),
                    "latest_quality": source.latest_quality,
                    "latest_quality_reason": source.latest_quality_reason,
                }
                for source in sources
            ],
        }
        payload["checksum"] = _source_catalog_checksum(payload)
        _write_json_atomic(self._source_catalog_path(feed, stream), payload)

    def _read_source_catalog(self, feed: FeedKind, stream: str) -> FeedSourceCatalog:
        path = self._source_catalog_path(feed, stream)
        loaded_object = cast(object, json.loads(path.read_text(encoding="utf-8")))
        if not isinstance(loaded_object, dict):
            raise ValueError(f"invalid Feed source catalog: {path}")
        payload = cast(Mapping[str, object], loaded_object)
        expected_keys = {"version", "feed", "stream", "complete", "sources", "checksum"}
        checksum = payload.get("checksum")
        unsigned = {key: value for key, value in payload.items() if key != "checksum"}
        if (
            set(payload) != expected_keys
            or not isinstance(checksum, str)
            or not hmac.compare_digest(checksum, _source_catalog_checksum(unsigned))
            or payload.get("version") != _SOURCE_CATALOG_VERSION
            or payload.get("feed") != feed.value
            or payload.get("stream") != stream
        ):
            raise ValueError(f"invalid Feed source catalog: {path}")
        complete = payload.get("complete")
        sources_value = payload.get("sources")
        if not isinstance(complete, bool) or not isinstance(sources_value, list):
            raise ValueError(f"invalid Feed source catalog: {path}")
        sources: list[FeedSourceSummary] = []
        source_keys = {
            "source_id",
            "source_name",
            "latest_issued_at",
            "latest_digest_id",
            "latest_item_count",
            "latest_native_section_counts",
            "edition_count",
            "edition_ids",
            "latest_quality",
            "latest_quality_reason",
        }
        for raw_source in cast(list[object], sources_value):
            if not isinstance(raw_source, dict):
                raise ValueError(f"invalid Feed source catalog: {path}")
            source = cast(Mapping[str, object], raw_source)
            source_id = source.get("source_id")
            source_name = source.get("source_name")
            latest_issued_at = source.get("latest_issued_at")
            latest_digest_id = source.get("latest_digest_id")
            latest_item_count = source.get("latest_item_count")
            counts_value = source.get("latest_native_section_counts")
            edition_count = source.get("edition_count")
            edition_ids_value = source.get("edition_ids")
            quality = source.get("latest_quality")
            quality_reason = source.get("latest_quality_reason")
            if (
                set(source) != source_keys
                or not isinstance(source_id, str)
                or not source_id
                or not isinstance(source_name, str)
                or not source_name
                or not isinstance(latest_issued_at, str)
                or not latest_issued_at
                or not isinstance(latest_digest_id, str)
                or not latest_digest_id
                or isinstance(latest_item_count, bool)
                or not isinstance(latest_item_count, int)
                or latest_item_count < 1
                or isinstance(edition_count, bool)
                or not isinstance(edition_count, int)
                or edition_count < 1
                or not isinstance(edition_ids_value, list)
                or not isinstance(counts_value, dict)
                or (quality is not None and not isinstance(quality, str))
                or (quality_reason is not None and not isinstance(quality_reason, str))
            ):
                raise ValueError(f"invalid Feed source catalog: {path}")
            counts: list[tuple[str, int]] = []
            for raw_name, raw_count in cast(Mapping[object, object], counts_value).items():
                if (
                    not isinstance(raw_name, str)
                    or not raw_name
                    or isinstance(raw_count, bool)
                    or not isinstance(raw_count, int)
                    or raw_count < 1
                ):
                    raise ValueError(f"invalid Feed source catalog: {path}")
                counts.append((raw_name, raw_count))
            if sum(count for _name, count in counts) != latest_item_count:
                raise ValueError(f"invalid Feed source catalog: {path}")
            raw_edition_ids = cast(list[object], edition_ids_value)
            edition_ids = tuple(
                value
                for value in raw_edition_ids
                if isinstance(value, str)
                and value
                and not any(unsafe in value for unsafe in ("/", "\\", ".."))
            )
            if (
                len(edition_ids) != len(raw_edition_ids)
                or len(set(edition_ids)) != len(edition_ids)
                or tuple(sorted(edition_ids, reverse=True)) != edition_ids
                or edition_count != len(edition_ids)
                or latest_digest_id != edition_ids[0]
            ):
                raise ValueError(f"invalid Feed source catalog: {path}")
            sources.append(
                FeedSourceSummary(
                    source_id=source_id,
                    source_name=source_name,
                    latest_issued_at=latest_issued_at,
                    latest_digest_id=latest_digest_id,
                    latest_item_count=latest_item_count,
                    latest_native_section_counts=tuple(sorted(counts)),
                    edition_count=edition_count,
                    edition_ids=edition_ids,
                    latest_quality=quality,
                    latest_quality_reason=quality_reason,
                )
            )
        if len({source.source_id for source in sources}) != len(sources):
            raise ValueError(f"invalid Feed source catalog: {path}")
        return FeedSourceCatalog(
            complete=complete,
            indexing=False,
            sources=self._sort_source_summaries(sources),
        )

    @classmethod
    def _source_summary_from_index(
        cls,
        source_id: str,
        edition: FeedEditionIndex,
        edition_ids: tuple[str, ...],
        *,
        fallback_name: str | None = None,
    ) -> FeedSourceSummary | None:
        items = [item for item in edition.items if item.source_id == source_id]
        if not items or not edition_ids or edition.edition_id != edition_ids[0]:
            return None
        source_name = cls._source_name(source_id, items)
        if source_name == source_id and fallback_name:
            source_name = fallback_name
        return FeedSourceSummary(
            source_id=source_id,
            source_name=source_name,
            latest_issued_at=edition.edition_at,
            latest_digest_id=edition.edition_id,
            latest_item_count=len(items),
            latest_native_section_counts=cls._source_section_counts(items),
            edition_count=len(edition_ids),
            edition_ids=edition_ids,
            latest_quality=edition.quality,
            latest_quality_reason=edition.quality_reason,
        )

    def _update_source_catalog_locked(
        self,
        edition: FeedEditionIndex,
        old_edition: FeedEditionIndex | None,
        *,
        replacing_existing: bool,
        stream_was_empty: bool,
    ) -> bool:
        """Apply one completed cache write while the stream catalog lock is held."""

        assert edition.stream is not None
        try:
            catalog = self._read_source_catalog(edition.feed, edition.stream)
        except (FileNotFoundError, KeyError, OSError, ValueError):
            catalog = FeedSourceCatalog(
                complete=stream_was_empty,
                indexing=False,
                sources=(),
            )

        sources = {source.source_id: source for source in catalog.sources}
        old_ids: set[str] = {item.source_id for item in old_edition.items} if old_edition else set()
        candidates = {
            source.source_id: source for source in self._source_summaries_from_indexes((edition,))
        }
        complete = catalog.complete and not (replacing_existing and old_edition is None)
        for source_id in old_ids | set(candidates):
            current = sources.get(source_id)
            candidate = candidates.get(source_id)
            was_present = source_id in old_ids
            known_ids = set(current.edition_ids if current is not None else ())
            if was_present:
                known_ids.discard(edition.edition_id)
            if candidate is not None:
                known_ids.add(edition.edition_id)
            edition_ids = tuple(sorted(known_ids, reverse=True))
            if not edition_ids:
                sources.pop(source_id, None)
                continue
            fallback_name = current.source_name if current is not None else None
            if candidate is not None and edition_ids[0] == edition.edition_id:
                updated = self._source_summary_from_index(
                    source_id,
                    edition,
                    edition_ids,
                    fallback_name=fallback_name,
                )
            elif current is not None and current.latest_digest_id == edition_ids[0]:
                updated = replace(
                    current,
                    edition_count=len(edition_ids),
                    edition_ids=edition_ids,
                )
            else:
                latest_path = self._path(edition.feed, edition_ids[0])
                try:
                    latest_index = self._load_or_repair_index(edition.feed, latest_path)
                except (FileNotFoundError, KeyError, OSError, ValueError):
                    updated = None
                else:
                    updated = self._source_summary_from_index(
                        source_id,
                        latest_index,
                        edition_ids,
                        fallback_name=fallback_name,
                    )
            if updated is None:
                sources.pop(source_id, None)
                complete = False
            else:
                sources[source_id] = updated

        self._write_source_catalog(
            edition.feed,
            edition.stream,
            complete=complete,
            sources=self._sort_source_summaries(sources.values()),
        )
        return complete

    def _seed_source_catalog_locked(
        self,
        feed: FeedKind,
        stream: str,
    ) -> FeedSourceCatalog:
        edition = self.latest_edition(feed, stream=stream)
        sources: tuple[FeedSourceSummary, ...] = ()
        if edition is not None:
            cache_path = self._path(feed, edition.edition_id)
            index = self._edition_index(edition, cache_path)
            sources = self._source_summaries_from_indexes((index,))
        catalog = FeedSourceCatalog(
            complete=False,
            indexing=False,
            sources=sources,
        )
        self._write_source_catalog(
            feed,
            stream,
            complete=False,
            sources=sources,
        )
        return catalog

    def _stream_cache_snapshot(
        self,
        feed: FeedKind,
        stream: str,
    ) -> tuple[tuple[str, int, int], ...]:
        directory = self.root / feed.value
        if not directory.is_dir():
            return ()
        snapshot: list[tuple[str, int, int]] = []
        for path in sorted(directory.glob(f"*-{stream}.json"), reverse=True):
            try:
                stat = path.stat()
            except OSError:
                continue
            snapshot.append((path.name, stat.st_size, stat.st_mtime_ns))
        return tuple(snapshot)

    def rebuild_stream_source_catalog(
        self,
        feed: FeedKind,
        stream: str,
    ) -> tuple[FeedSourceSummary, ...]:
        """Rebuild the source catalog outside latency-sensitive requests.

        The historical scan is performed without the catalog lock.  A short
        final compare-and-replace section verifies that no cache writer changed
        the stream snapshot; otherwise the build retries from the new snapshot.
        """

        self._source_catalog_path(feed, stream)
        while True:
            snapshot = self._stream_cache_snapshot(feed, stream)
            indexes: list[FeedEditionIndex] = []
            directory = self.root / feed.value
            for name, _size, _mtime_ns in snapshot:
                path = directory / name
                try:
                    index = self._load_or_repair_index(feed, path)
                except (FileNotFoundError, KeyError, OSError, ValueError):
                    continue
                if index.stream == stream:
                    indexes.append(index)
            sources = self._source_summaries_from_indexes(tuple(indexes))
            with _exclusive_file_lock(self._source_catalog_lock_path(feed, stream)):
                if snapshot != self._stream_cache_snapshot(feed, stream):
                    continue
                self._write_source_catalog(
                    feed,
                    stream,
                    complete=True,
                    sources=sources,
                )
                return sources

    def _schedule_source_catalog_rebuild(self, feed: FeedKind, stream: str) -> None:
        catalog_path = self._source_catalog_path(feed, stream)
        build_key = str(catalog_path)
        with _SOURCE_CATALOG_BUILDS_LOCK:
            if build_key in _SOURCE_CATALOG_BUILDS:
                return
            _SOURCE_CATALOG_BUILDS.add(build_key)

        def rebuild() -> None:
            try:
                self.rebuild_stream_source_catalog(feed, stream)
            except (KeyError, OSError, ValueError):
                # The index is derived runtime data. A later request or Feed
                # sync safely retries without making the Dashboard request wait.
                pass
            finally:
                with _SOURCE_CATALOG_BUILDS_LOCK:
                    _SOURCE_CATALOG_BUILDS.discard(build_key)

        threading.Thread(
            target=rebuild,
            name=f"okf-feed-source-index-{feed.value}-{stream}",
            daemon=True,
        ).start()

    def _source_catalog_is_indexing(self, feed: FeedKind, stream: str) -> bool:
        build_key = str(self._source_catalog_path(feed, stream))
        with _SOURCE_CATALOG_BUILDS_LOCK:
            return build_key in _SOURCE_CATALOG_BUILDS

    def stream_source_catalog(
        self,
        feed: FeedKind,
        stream: str,
    ) -> FeedSourceCatalog:
        """Return the materialized catalog plus its rebuild state."""

        try:
            catalog = self._read_source_catalog(feed, stream)
        except (FileNotFoundError, KeyError, OSError, ValueError):
            with _exclusive_file_lock(self._source_catalog_lock_path(feed, stream)):
                try:
                    catalog = self._read_source_catalog(feed, stream)
                except (FileNotFoundError, KeyError, OSError, ValueError):
                    # Old caches synchronously inspect at most the latest
                    # edition. The unbounded historical pass runs in a daemon
                    # maintenance thread below.
                    catalog = self._seed_source_catalog_locked(feed, stream)
        if not catalog.complete:
            self._schedule_source_catalog_rebuild(feed, stream)
        return replace(
            catalog,
            indexing=self._source_catalog_is_indexing(feed, stream),
        )

    @contextmanager
    def locked_stream_source_catalog(
        self,
        feed: FeedKind,
        stream: str,
    ) -> Generator[FeedSourceCatalog]:
        """Yield a catalog while preventing a Feed writer from changing it.

        Callers that also read editions can therefore project one coherent
        catalog/body generation. Any crash-left mismatch is reported by
        ``load_source_latest_editions_locked`` and rebuilt outside this lock.
        """

        self.stream_source_catalog(feed, stream)
        with _exclusive_file_lock(self._source_catalog_lock_path(feed, stream)):
            try:
                catalog = self._read_source_catalog(feed, stream)
            except (FileNotFoundError, KeyError, OSError, ValueError) as error:
                raise FeedSourceCatalogStale("Feed source catalog changed") from error
            yield replace(
                catalog,
                indexing=self._source_catalog_is_indexing(feed, stream),
            )

    def load_source_latest_editions_locked(
        self,
        feed: FeedKind,
        stream: str,
        catalog: FeedSourceCatalog,
        sources: Iterable[FeedSourceSummary],
    ) -> dict[str, FeedEdition]:
        """Validate the catalog and load visible latest editions under its lock."""

        all_grouped: dict[str, list[FeedSourceSummary]] = {}
        for source in catalog.sources:
            all_grouped.setdefault(source.latest_digest_id, []).append(source)
        indexes: dict[str, FeedEditionIndex] = {}
        for edition_id, summaries in all_grouped.items():
            cache_path = self._path(feed, edition_id)
            try:
                index = self._read_index(feed, edition_id, cache_path)
            except (FileNotFoundError, KeyError, OSError, ValueError) as error:
                raise FeedSourceCatalogStale(
                    f"Feed source catalog points to an invalid edition: {edition_id}"
                ) from error
            if index.stream != stream:
                raise FeedSourceCatalogStale(
                    f"Feed source catalog points to a mismatched edition: {edition_id}"
                )
            for summary in summaries:
                expected = self._source_summary_from_index(
                    summary.source_id,
                    index,
                    summary.edition_ids,
                    fallback_name=summary.source_name,
                )
                if expected != summary:
                    raise FeedSourceCatalogStale(
                        "Feed source catalog summary does not match "
                        f"edition {edition_id}: {summary.source_id}"
                    )
            indexes[edition_id] = index

        visible_grouped: dict[str, list[FeedSourceSummary]] = {}
        for source in sources:
            visible_grouped.setdefault(source.latest_digest_id, []).append(source)
        editions: dict[str, FeedEdition] = {}
        for edition_id in visible_grouped:
            cache_path = self._path(feed, edition_id)
            index = indexes[edition_id]
            try:
                edition = self.get(feed, edition_id)
                body_index = self._edition_index(edition, cache_path)
            except (FileNotFoundError, KeyError, OSError, ValueError) as error:
                raise FeedSourceCatalogStale(
                    f"Feed source catalog points to an invalid edition: {edition_id}"
                ) from error
            if index != body_index or edition.stream != stream:
                raise FeedSourceCatalogStale(
                    f"Feed source catalog points to a mismatched edition: {edition_id}"
                )
            editions[edition_id] = edition
        return editions

    def list_stream_source_summaries(
        self,
        feed: FeedKind,
        stream: str,
    ) -> list[FeedSourceSummary]:
        """Read O(source count) materialized summaries without scanning history."""

        return list(self.stream_source_catalog(feed, stream).sources)

    def stream_source_summary(
        self,
        feed: FeedKind,
        stream: str,
        source_id: str,
    ) -> FeedSourceSummary | None:
        if not source_id:
            raise ValueError("Reading source id must not be empty")
        return next(
            (
                source
                for source in self.list_stream_source_summaries(feed, stream)
                if source.source_id == source_id
            ),
            None,
        )

    def _latest_path(self, feed: FeedKind, stream: str | None) -> Path:
        suffix = stream or "all"
        if any(value in suffix for value in ("/", "\\", "..")):
            raise ValueError(f"unsafe feed stream: {stream!r}")
        return self.root / "latest" / f"{feed.value}-{suffix}.json"

    def _update_latest(self, edition: FeedEdition) -> None:
        target = self._latest_path(edition.feed, edition.stream)
        with _exclusive_file_lock(target.with_suffix(".lock")):
            current_key: tuple[str, str] | None = None
            if target.is_file():
                try:
                    loaded = cast(object, json.loads(target.read_text(encoding="utf-8")))
                    if isinstance(loaded, dict):
                        current = cast(Mapping[str, object], loaded)
                        current_id = current.get("edition_id")
                        if isinstance(current_id, str):
                            current_edition = self.get(edition.feed, current_id)
                            if (
                                current.get("feed") == edition.feed.value
                                and current_edition.feed is edition.feed
                                and current.get("stream") == edition.stream
                                and current.get("edition_at") == current_edition.edition_at
                                and current_edition.stream == edition.stream
                            ):
                                current_key = (
                                    current_edition.edition_at,
                                    current_edition.edition_id,
                                )
                except (KeyError, OSError, ValueError):
                    current_key = None
            candidate_key = (edition.edition_at, edition.edition_id)
            if current_key is not None and current_key >= candidate_key:
                return
            _write_json_atomic(
                target,
                {
                    "feed": edition.feed.value,
                    "stream": edition.stream,
                    "edition_id": edition.edition_id,
                    "edition_at": edition.edition_at,
                },
            )

    def put(
        self,
        edition: FeedEdition,
        *,
        schedule_source_catalog_rebuild: bool = True,
    ) -> Path:
        target = self._path(edition.feed, edition.edition_id)
        update_source_catalog = edition.feed is FeedKind.AI_DAILY and edition.stream == "learning"
        catalog_complete = True
        if update_source_catalog:
            assert edition.stream is not None
            with (
                _exclusive_file_lock(self._source_catalog_lock_path(edition.feed, edition.stream)),
                _exclusive_file_lock(target.with_suffix(".lock")),
            ):
                replacing_existing = target.is_file()
                stream_directory = self.root / edition.feed.value
                stream_was_empty = not any(
                    path != target for path in stream_directory.glob(f"*-{edition.stream}.json")
                )
                old_index: FeedEditionIndex | None = None
                if replacing_existing:
                    try:
                        old_index = self._read_index(
                            edition.feed,
                            edition.edition_id,
                            target,
                        )
                    except (FileNotFoundError, KeyError, OSError, ValueError):
                        try:
                            old_edition = self.get(edition.feed, edition.edition_id)
                        except (FileNotFoundError, KeyError, OSError, ValueError):
                            pass
                        else:
                            old_index = self._edition_index(old_edition, target)
                _write_json_atomic(target, asdict(edition))
                index = self._edition_index(edition, target)
                self._write_index(index)
                catalog_complete = self._update_source_catalog_locked(
                    index,
                    old_index,
                    replacing_existing=replacing_existing,
                    stream_was_empty=stream_was_empty,
                )
        else:
            with _exclusive_file_lock(target.with_suffix(".lock")):
                _write_json_atomic(target, asdict(edition))
                self._write_index(self._edition_index(edition, target))
        self._update_latest(edition)
        if update_source_catalog and not catalog_complete and schedule_source_catalog_rebuild:
            assert edition.stream is not None
            self._schedule_source_catalog_rebuild(edition.feed, edition.stream)
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
        return sorted(
            editions,
            key=lambda edition: (edition.edition_at, edition.edition_id),
            reverse=True,
        )

    def latest_edition(
        self,
        feed: FeedKind,
        *,
        stream: str | None = None,
    ) -> FeedEdition | None:
        """Load the latest edition without reading historical item bodies."""

        pointer = self._latest_path(feed, stream)
        if pointer.is_file():
            try:
                loaded = cast(object, json.loads(pointer.read_text(encoding="utf-8")))
                if isinstance(loaded, dict):
                    metadata = cast(Mapping[str, object], loaded)
                    edition_id = metadata.get("edition_id")
                    if isinstance(edition_id, str):
                        edition = self.get(feed, edition_id)
                        if (
                            metadata.get("feed") == feed.value
                            and edition.feed is feed
                            and metadata.get("stream") == stream
                            and edition.stream == stream
                            and metadata.get("edition_at") == edition.edition_at
                        ):
                            return edition
            except (FileNotFoundError, KeyError, OSError, ValueError):
                pass
        if stream is not None:
            editions, _has_more = self.list_stream_page(feed, stream, limit=1)
            if not editions:
                return None
            self._update_latest(editions[0])
            return editions[0]
        directory = self.root / feed.value
        if not directory.is_dir():
            return None
        for path in sorted(directory.glob("*.json"), key=lambda value: value.stem, reverse=True):
            try:
                edition = self.get(feed, path.stem)
            except (FileNotFoundError, KeyError, OSError, ValueError):
                continue
            self._update_latest(edition)
            return edition
        return None

    def list_stream_page(
        self,
        feed: FeedKind,
        stream: str,
        *,
        after_edition_id: str | None = None,
        limit: int = 20,
    ) -> tuple[list[FeedEdition], bool]:
        """Read one stable stream page without deserializing its whole history.

        AI Daily edition ids are producer-owned but follow the durable
        ``<ISO date>-<stream>`` contract. Sorting those cache filenames keeps a
        cursor stable when a newer edition is inserted ahead of the page.
        """

        if not stream or any(value in stream for value in ("/", "\\", "..")):
            raise ValueError(f"unsafe feed stream: {stream!r}")
        if limit < 1:
            raise ValueError("feed page limit must be positive")
        directory = self.root / feed.value
        if not directory.is_dir():
            return [], False
        candidates = sorted(
            directory.glob(f"*-{stream}.json"),
            key=lambda path: path.stem,
            reverse=True,
        )
        if after_edition_id is not None:
            candidates = [path for path in candidates if path.stem < after_edition_id]
        editions: list[FeedEdition] = []
        for path in candidates:
            try:
                edition = self.get(feed, path.stem)
            except (FileNotFoundError, KeyError, OSError, ValueError):
                continue
            if edition.stream != stream:
                continue
            editions.append(edition)
            if len(editions) > limit:
                break
        return editions[:limit], len(editions) > limit

    def iter_stream_indexes(
        self,
        feed: FeedKind,
        stream: str,
    ) -> Iterator[FeedEditionIndex]:
        """Yield compact stream metadata, newest first.

        Old caches are upgraded one edition at a time.  A bootstrap may inspect
        every historical JSON file once, but never retains historical bodies in
        an unbounded in-memory collection.  Future reads use the small sidecars.
        Broken cache entries are ignored independently.
        """

        if not stream or any(value in stream for value in ("/", "\\", "..")):
            raise ValueError(f"unsafe feed stream: {stream!r}")
        directory = self.root / feed.value
        if not directory.is_dir():
            return
        candidates = sorted(
            directory.glob(f"*-{stream}.json"),
            key=lambda path: path.stem,
            reverse=True,
        )
        for path in candidates:
            try:
                value = self._load_or_repair_index(feed, path)
            except (FileNotFoundError, KeyError, OSError, ValueError):
                continue
            if value.stream == stream:
                yield value

    def list_stream_source_page(
        self,
        feed: FeedKind,
        stream: str,
        source_id: str,
        *,
        after_edition_id: str | None = None,
        limit: int = 20,
    ) -> tuple[
        list[FeedEdition],
        bool,
        FeedSourceCatalog,
        FeedSourceSummary | None,
    ]:
        """Read a source page directly from its materialized edition-id index."""

        if not source_id:
            raise ValueError("Reading source id must not be empty")
        if limit < 1:
            raise ValueError("feed page limit must be positive")
        for attempt in range(2):
            try:
                with self.locked_stream_source_catalog(feed, stream) as catalog:
                    summary = next(
                        (value for value in catalog.sources if value.source_id == source_id),
                        None,
                    )
                    if summary is None:
                        return [], False, catalog, None
                    candidates = summary.edition_ids
                    if after_edition_id is not None:
                        candidates = tuple(
                            edition_id for edition_id in candidates if edition_id < after_edition_id
                        )
                    has_more = len(candidates) > limit
                    editions: list[FeedEdition] = []
                    for edition_id in candidates[:limit]:
                        cache_path = self._path(feed, edition_id)
                        try:
                            index = self._read_index(feed, edition_id, cache_path)
                            edition = self.get(feed, edition_id)
                            body_index = self._edition_index(edition, cache_path)
                        except (FileNotFoundError, KeyError, OSError, ValueError) as error:
                            raise FeedSourceCatalogStale(
                                "Feed source edition is unavailable: " + edition_id
                            ) from error
                        if (
                            index != body_index
                            or index.stream != stream
                            or edition.stream != stream
                            or all(item.source_id != source_id for item in index.items)
                        ):
                            raise FeedSourceCatalogStale(
                                "Feed source edition does not match its catalog: " + edition_id
                            )
                        matching_items = tuple(
                            item for item in edition.items if reading_source_id(item) == source_id
                        )
                        if not matching_items:
                            raise FeedSourceCatalogStale(
                                "Feed source edition has no cataloged items: " + edition_id
                            )
                        editions.append(replace(edition, items=matching_items))
                    return editions, has_more, catalog, summary
            except FeedSourceCatalogStale:
                if attempt:
                    raise
                self.rebuild_stream_source_catalog(feed, stream)
        raise AssertionError("unreachable Feed source page retry")

    def find_item(self, feed: FeedKind, item_id: str) -> FeedItem:
        for edition in self.list_editions(feed):
            for item in edition.items:
                if item.item_id == item_id:
                    return item
        raise KeyError(item_id)

"""Store producer payloads outside the Vault; materialize only on user access."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from dataclasses import asdict
from importlib import import_module
from pathlib import Path
from typing import Protocol, cast

from .models import FeedComment, FeedEdition, FeedItem, FeedKind


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
        if os.fstat(handle.fileno()).st_size == 0:
            handle.write(b"\0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            locker = cast(_WindowsFileLock, import_module("msvcrt"))
            locker.locking(handle.fileno(), locker.LK_LOCK, 1)
            try:
                yield
            finally:
                handle.seek(0)
                locker.locking(handle.fileno(), locker.LK_UNLCK, 1)
        else:
            locker = cast(_PosixFileLock, import_module("fcntl"))
            locker.flock(handle.fileno(), locker.LOCK_EX)
            try:
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
        native_section=(
            str(payload["native_section"]) if payload.get("native_section") else None
        ),
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

    def put(self, edition: FeedEdition) -> Path:
        target = self._path(edition.feed, edition.edition_id)
        _write_json_atomic(target, asdict(edition))
        self._update_latest(edition)
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

    def find_item(self, feed: FeedKind, item_id: str) -> FeedItem:
        for edition in self.list_editions(feed):
            for item in edition.items:
                if item.item_id == item_id:
                    return item
        raise KeyError(item_id)

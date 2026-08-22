"""Feed data contracts deliberately free of Proposal/Job/Core concepts."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum

UNATTRIBUTED_SOURCE_ID = "source:unattributed"
UNATTRIBUTED_SOURCE_NAME = "来源未标注"


def _empty_metrics() -> dict[str, float | int | str]:
    return {}


class FeedKind(StrEnum):
    AI_DAILY = "ai-daily"
    TREEHOLE = "treehole"


class DecisionAction(StrEnum):
    LEARN_NOW = "learn-now"
    LEARN_LATER = "learn-later"
    WIKI_NOW = "wiki-now"
    SOURCE_ONLY = "source-only"
    IGNORE = "ignore"


@dataclass(frozen=True, slots=True)
class FeedComment:
    text: str
    cid: int | None = None
    author: str | None = None
    is_original_poster: bool = False
    published_at: str | None = None
    reply_to_cid: int | None = None
    reply_to_author: str | None = None
    reply_to_text: str | None = None
    media: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class FeedItem:
    item_id: str
    feed: FeedKind
    edition_id: str
    title: str
    body: str
    url: str | None = None
    published_at: str | None = None
    stream: str | None = None
    source_id: str | None = None
    source_name: str | None = None
    native_section: str | None = None
    pid: int | None = None
    metrics: dict[str, float | int | str] = field(default_factory=_empty_metrics)
    comments: tuple[FeedComment, ...] = ()
    media: tuple[str, ...] = ()


def reading_source_id(item: FeedItem) -> str:
    """Return the durable Reading identity for one learning item.

    Historical learning payloads did not always identify their subscription
    source.  They deliberately share one stable sentinel instead of deriving a
    mutable identity from a URL hostname or display name.
    """

    source_id = item.source_id.strip() if item.source_id else ""
    return source_id or UNATTRIBUTED_SOURCE_ID


@dataclass(frozen=True, slots=True)
class FeedEdition:
    edition_id: str
    feed: FeedKind
    edition_at: str
    title: str
    items: tuple[FeedItem, ...]
    stream: str | None = None
    quality: str | None = None
    quality_reason: str | None = None


@dataclass(frozen=True, slots=True)
class DecisionResult:
    item_id: str
    action: DecisionAction
    source: str | None = None
    source_text: str | None = None
    study_guide: str | None = None
    wiki: str | None = None
    warnings: tuple[str, ...] = ()

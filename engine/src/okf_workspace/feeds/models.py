"""Feed data contracts deliberately free of Proposal/Job/Core concepts."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


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
    pid: int | None = None
    metrics: dict[str, float | int | str] = field(default_factory=_empty_metrics)
    comments: tuple[FeedComment, ...] = ()
    media: tuple[str, ...] = ()


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

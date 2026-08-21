"""Stable data contracts shared by indexing, retrieval, and AI."""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime


@dataclass(frozen=True, slots=True)
class MarkdownChunk:
    chunk_id: str
    path: str
    heading: str
    start_line: int
    end_line: int
    text: str
    text_hash: str


@dataclass(frozen=True, slots=True)
class SearchHit:
    path: str
    heading: str
    start_line: int
    end_line: int
    text_hash: str
    score: float
    retrieval_reasons: tuple[str, ...] = field(default_factory=tuple)

    @property
    def identity(self) -> tuple[str, str, int]:
        return self.path, self.heading, self.start_line


@dataclass(frozen=True, slots=True)
class ContextItem:
    path: str
    heading: str
    start_line: int
    end_line: int
    actual_text: str
    read_at: datetime
    current_text_hash: str
    retrieval_reasons: tuple[str, ...] = field(default_factory=tuple)
    refreshed_after_change: bool = False


@dataclass(frozen=True, slots=True)
class IndexUpdate:
    indexed: int
    unchanged: int
    removed: int
    chunks: int

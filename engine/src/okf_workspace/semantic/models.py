"""Persistent contracts for Codex-backed semantic operations."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import StrEnum


class SemanticKind(StrEnum):
    GENERATE_STUDY_GUIDE = "generate-study-guide"
    REFRESH_STUDY_GUIDE = "refresh-study-guide"
    GENERATE_WIKI = "generate-wiki"

    @classmethod
    def from_persisted(cls, value: str) -> SemanticKind:
        """Read old queue records without keeping legacy names in new APIs."""

        legacy = {
            "prepare-study-material": cls.GENERATE_STUDY_GUIDE,
            "update-study-material": cls.REFRESH_STUDY_GUIDE,
            "generate-study-draft": cls.GENERATE_STUDY_GUIDE,
            "refresh-study-draft": cls.REFRESH_STUDY_GUIDE,
            "generate-wiki-draft": cls.GENERATE_WIKI,
            "distill-wiki": cls.GENERATE_WIKI,
        }
        if value in legacy:
            return legacy[value]
        return cls(value)


class SemanticStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"
    ORPHANED = "orphaned"
    SUPERSEDED = "superseded"


class SemanticStage(StrEnum):
    """Observable execution stage inside one semantic operation."""

    QUEUED = "queued"
    RETRIEVING = "retrieving"
    GENERATING = "generating"
    PUBLISHING = "publishing"
    INDEXING = "indexing"
    COMPLETED = "completed"
    FAILED = "failed"
    CANCELLED = "cancelled"


@dataclass(frozen=True, slots=True)
class SemanticRequest:
    operation_id: str
    kind: SemanticKind
    target: str
    sources: tuple[str, ...] = field(default_factory=tuple)
    instruction: str = ""
    course: str | None = None
    project: str | None = None


@dataclass(frozen=True, slots=True)
class SemanticOutput:
    content: str
    actual_reads: tuple[str, ...]

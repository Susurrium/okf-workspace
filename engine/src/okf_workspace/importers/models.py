"""Small document-import contracts without a second authority model."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path


class ParserName(StrEnum):
    MINERU = "mineru"
    MARKITDOWN = "markitdown"


class ImportQuality(StrEnum):
    HIGH = "high"
    QUICK = "quick"


class ImportIntent(StrEnum):
    LEARN = "learn"
    WIKI = "wiki"
    SOURCE = "source"
    LATER = "later"
    COURSE = "course"


class ConversionStatus(StrEnum):
    QUEUED = "queued"
    CONVERTING = "converting"
    READY = "ready"
    IMPORTED = "imported"
    FAILED = "failed"
    WAITING_FOR_MINERU = "waiting-for-mineru"


@dataclass(frozen=True, slots=True)
class ImportRequest:
    source: Path
    intent: ImportIntent
    source_filename: str | None = None
    quality: ImportQuality = ImportQuality.HIGH
    parser: ParserName | None = None
    course: str | None = None
    project: str | None = None
    generate: bool = False


@dataclass(frozen=True, slots=True)
class OriginalRecord:
    sha256: str
    filename: str
    extension: str
    size_bytes: int
    stored_path: Path
    resource: str


@dataclass(frozen=True, slots=True)
class ParserExport:
    markdown: str
    assets: dict[str, bytes]
    parser: ParserName
    parser_version: str
    degraded_from: ParserName | None = None
    warnings: tuple[str, ...] = ()
    expected_image_references: int | None = None
    output_image_references: int | None = None
    bundle_schema: str | None = None
    profile: str | None = None


@dataclass(frozen=True, slots=True)
class QCReport:
    passed: bool
    checks: dict[str, bool]
    warnings: tuple[str, ...]
    errors: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class ImportResult:
    conversion_id: str
    status: ConversionStatus
    original: OriginalRecord
    parser: ParserName
    export_directory: Path
    source: Path | None
    source_text: Path | None
    routed_target: Path | None
    qc: QCReport

"""Small document-import contracts without a second authority model."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path


class ParserName(StrEnum):
    MINERU = "mineru"
    MARKITDOWN = "markitdown"


class ConversionMethod(StrEnum):
    MINERU_CLOUD = "mineru-cloud"
    MARKITDOWN_SERVICE = "markitdown-service"
    MINERU_SELF_HOSTED = "mineru-self-hosted"

    @property
    def parser(self) -> ParserName:
        return (
            ParserName.MARKITDOWN
            if self is ConversionMethod.MARKITDOWN_SERVICE else ParserName.MINERU
        )

    @classmethod
    def from_parser(cls, parser: ParserName) -> ConversionMethod:
        return cls.MARKITDOWN_SERVICE if parser is ParserName.MARKITDOWN else cls.MINERU_CLOUD


class ImportQuality(StrEnum):
    HIGH = "high"
    QUICK = "quick"


class ImportIntent(StrEnum):
    LEARN = "learn"
    WIKI = "wiki"
    SOURCE = "source"
    LATER = "later"
    COURSE = "course"


def requires_semantic_generation(intent: ImportIntent, generate: bool) -> bool:
    return intent is ImportIntent.WIKI or (
        generate and intent in {ImportIntent.LEARN, ImportIntent.COURSE}
    )


class ConversionStatus(StrEnum):
    QUEUED = "queued"
    CONVERTING = "converting"
    READY = "ready"
    IMPORTED = "imported"
    FAILED = "failed"
    WAITING_FOR_MINERU = "waiting-for-mineru"
    WAITING_FOR_PARSER = "waiting-for-parser"


@dataclass(frozen=True, slots=True)
class ImportRequest:
    source: Path
    intent: ImportIntent
    source_filename: str | None = None
    quality: ImportQuality = ImportQuality.QUICK
    parser: ParserName | None = None
    course: str | None = None
    project: str | None = None
    generate: bool = False
    method: ConversionMethod | None = None


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
    method: ConversionMethod | None = None


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
    method: ConversionMethod | None = None

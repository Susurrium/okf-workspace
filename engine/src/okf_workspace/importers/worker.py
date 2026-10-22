"""One lightweight background worker for durable document conversions."""

from __future__ import annotations

import threading
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from okf_workspace.semantic import SemanticKind, SemanticOperationService

from .clients import RetryableConversionError
from .models import (
    ConversionMethod,
    ConversionStatus,
    ImportIntent,
    ParserName,
    requires_semantic_generation,
)
from .pipeline import DocumentImporter
from .state import ConversionBusyError

_ACTIVE = {
    ConversionStatus.QUEUED.value,
    ConversionStatus.WAITING_FOR_MINERU.value,
    ConversionStatus.WAITING_FOR_PARSER.value,
}


class DocumentImportWorker:
    def __init__(
        self,
        importer: DocumentImporter,
        *,
        semantic_service: SemanticOperationService | None = None,
        retry_seconds: float = 60.0,
    ) -> None:
        self.importer = importer
        self.store = importer.store
        self.semantic_service = semantic_service
        self.retry_seconds = retry_seconds

    def reconcile(self) -> int:
        return self.store.reconcile_interrupted()

    def run_once(self) -> bool:
        record = next((item for item in self.store.work_candidates() if self._eligible(item)), None)
        if record is None:
            return False
        conversion_id = str(record["conversion_id"])
        try:
            with self.store.execution(conversion_id):
                current = self.store.load(conversion_id)
                if not self._eligible(current):
                    return False
                return self._run_record(current)
        except ConversionBusyError:
            return False

    def _run_record(self, record: dict[str, object]) -> bool:
        conversion_id = str(record["conversion_id"])
        if record.get("status") == ConversionStatus.IMPORTED.value:
            self.enqueue_semantic(conversion_id)
            return True
        self.store.transition(
            conversion_id,
            ConversionStatus.QUEUED,
            increment_attempt=True,
        )
        try:
            result = self.importer.retry(conversion_id)
            self.enqueue_semantic(result.conversion_id)
        except Exception as exc:
            message = str(exc)
            if isinstance(exc, RetryableConversionError):
                method = (
                    ConversionMethod(str(record["method"]))
                    if record.get("method")
                    else ConversionMethod.from_parser(
                        ParserName(str(record.get("parser", "mineru")))
                    )
                )
                self.store.transition(
                    conversion_id,
                    ConversionStatus.WAITING_FOR_MINERU
                    if method is ConversionMethod.MINERU_CLOUD
                    else ConversionStatus.WAITING_FOR_PARSER,
                    error=message[:2000],
                    retry_after_seconds=self.retry_seconds,
                )
            else:
                self.store.transition(
                    conversion_id,
                    ConversionStatus.FAILED,
                    error=message[:2000],
                )
        return True

    def run_forever(self, stop: threading.Event, *, poll_seconds: float = 0.5) -> None:
        self.reconcile()
        while not stop.is_set():
            if not self.run_once():
                stop.wait(poll_seconds)

    def _eligible(self, record: dict[str, object]) -> bool:
        status = record.get("status")
        pending_handoff = status == ConversionStatus.IMPORTED.value and self._needs_generation(
            record
        )
        if status not in _ACTIVE and not pending_handoff:
            return False
        if status == ConversionStatus.QUEUED.value:
            return True
        retry_at = record.get("next_retry_at")
        if not isinstance(retry_at, str):
            return True
        try:
            return datetime.fromisoformat(retry_at.replace("Z", "+00:00")) <= datetime.now(UTC)
        except ValueError:
            return True

    @staticmethod
    def _needs_generation(record: dict[str, object]) -> bool:
        outputs = record.get("outputs")
        if isinstance(outputs, dict) and cast(dict[str, object], outputs).get(
            "semantic_operation_id"
        ):
            return False
        return requires_semantic_generation(
            ImportIntent(str(record.get("intent"))),
            bool(record.get("generate")),
        )

    def enqueue_semantic(self, conversion_id: str) -> dict[str, object] | None:
        """Persist a retryable handoff independently of the completed conversion."""
        record = self.store.load(conversion_id)
        if not self._needs_generation(record):
            return None
        try:
            return self._enqueue_semantic(record)
        except Exception as exc:
            self.store.transition(
                conversion_id,
                ConversionStatus.IMPORTED,
                error=str(exc)[:2000],
                retry_after_seconds=self.retry_seconds,
                stages={"semantic": "failed"},
            )
            return None

    def _enqueue_semantic(self, record: dict[str, object]) -> dict[str, object]:
        if self.semantic_service is None:
            raise RuntimeError("Codex semantic automation is disabled")
        conversion_id = str(record["conversion_id"])
        intent = ImportIntent(str(record.get("intent")))
        outputs = record.get("outputs")
        if not isinstance(outputs, dict):
            raise ValueError("conversion outputs are missing")
        output_values = cast(Mapping[str, object], outputs)
        target = output_values.get("routed_target", output_values.get("routed_draft"))
        if not isinstance(target, str):
            raise ValueError("conversion generation target is missing")
        vault = self.importer.vault
        target_relative = Path(target).resolve().relative_to(vault).as_posix()
        source_paths: list[str] = []
        for key, legacy_key in (("source", "source_record"), ("source_text", "source_extract")):
            value = output_values.get(key, output_values.get(legacy_key))
            if isinstance(value, str):
                source_paths.append(Path(value).resolve().relative_to(vault).as_posix())
        operation = self.semantic_service.enqueue(
            SemanticKind.GENERATE_STUDY_GUIDE
            if intent in {ImportIntent.LEARN, ImportIntent.COURSE}
            else SemanticKind.GENERATE_WIKI,
            target_relative,
            sources=tuple(source_paths),
            course=(str(record["course"]) if isinstance(record.get("course"), str) else None),
            project=(str(record["project"]) if isinstance(record.get("project"), str) else None),
            idempotency_key=(
                f"document:{conversion_id}:{record.get('generation_revision', 'initial')}"
            ),
        )
        self.store.transition(
            conversion_id,
            ConversionStatus.IMPORTED,
            outputs={"semantic_operation_id": str(operation["operation_id"])},
            stages={"semantic": "queued"},
        )
        return operation

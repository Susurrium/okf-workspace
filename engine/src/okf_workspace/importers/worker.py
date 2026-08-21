"""One lightweight background worker for durable document conversions."""

from __future__ import annotations

import threading
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from okf_workspace.semantic import SemanticKind, SemanticOperationService

from .models import ConversionStatus, ImportIntent
from .pipeline import DocumentImporter

_ACTIVE = {
    ConversionStatus.QUEUED.value,
    ConversionStatus.WAITING_FOR_MINERU.value,
}
_TRANSIENT_MINERU = (
    "unavailable",
    "connect",
    "timeout",
    "timed out",
    "ssh",
    "busy",
    "capacity",
)


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
        record = next((item for item in reversed(self.store.list()) if self._eligible(item)), None)
        if record is None:
            return False
        conversion_id = str(record["conversion_id"])
        self.store.transition(
            conversion_id,
            ConversionStatus.QUEUED,
            increment_attempt=True,
        )
        try:
            result = self.importer.retry(conversion_id)
            self._enqueue_semantic(result.conversion_id)
        except Exception as exc:
            current = self.store.load(conversion_id)
            requested = current.get("requested_parser")
            message = str(exc)
            if requested == "mineru" and any(
                marker in message.casefold() for marker in _TRANSIENT_MINERU
            ):
                self.store.transition(
                    conversion_id,
                    ConversionStatus.WAITING_FOR_MINERU,
                    error=message[:2000],
                    retry_after_seconds=self.retry_seconds,
                )
        return True

    def run_forever(self, stop: threading.Event, *, poll_seconds: float = 0.5) -> None:
        self.reconcile()
        while not stop.is_set():
            if not self.run_once():
                stop.wait(poll_seconds)

    def _eligible(self, record: dict[str, object]) -> bool:
        status = record.get("status")
        if status not in _ACTIVE:
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

    def _enqueue_semantic(self, conversion_id: str) -> None:
        if self.semantic_service is None:
            return
        record = self.store.load(conversion_id)
        if not bool(record.get("generate")):
            return
        intent = ImportIntent(str(record.get("intent")))
        if intent not in {ImportIntent.LEARN, ImportIntent.COURSE, ImportIntent.WIKI}:
            return
        outputs = record.get("outputs")
        if not isinstance(outputs, dict):
            return
        output_values = cast(Mapping[str, object], outputs)
        target = output_values.get("routed_target", output_values.get("routed_draft"))
        if not isinstance(target, str):
            return
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
            project=(
                str(record["project"]) if isinstance(record.get("project"), str) else None
            ),
        )
        self.store.transition(
            conversion_id,
            ConversionStatus.IMPORTED,
            outputs={"semantic_operation_id": str(operation["operation_id"])},
        )

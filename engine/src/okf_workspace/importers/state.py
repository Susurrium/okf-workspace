"""One readable JSON record per simplified document conversion."""

from __future__ import annotations

import json
import uuid
from collections.abc import Generator, Mapping, Sequence
from contextlib import contextmanager
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

from okf_workspace.okf.file_io import atomic_write_bytes, document_lock
from okf_workspace.state_index import StateRecordIndex

from .models import (
    ConversionMethod,
    ConversionStatus,
    ImportIntent,
    ImportRequest,
    OriginalRecord,
    ParserName,
    requires_semantic_generation,
)


class ConversionBusyError(RuntimeError):
    """An execution owns this conversion; retry after it finishes."""


class ConversionStore:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve() / "conversions"
        self.catalog = StateRecordIndex(
            self.root,
            "*/status.json",
            "conversion_id",
            self._active,
            identifier_from_path=lambda path: path.parent.name,
        )

    @staticmethod
    def _active(record: Mapping[str, object]) -> bool:
        if record.get("status") in {
            "queued",
            "converting",
            "ready",
            "waiting-for-mineru",
            "waiting-for-parser",
        }:
            return True
        outputs = record.get("outputs")
        if record.get("status") != "imported" or (
            isinstance(outputs, Mapping)
            and cast(Mapping[str, object], outputs).get("semantic_operation_id")
        ):
            return False
        return requires_semantic_generation(
            ImportIntent(str(record.get("intent"))),
            bool(record.get("generate")),
        )

    def work_candidates(self) -> list[dict[str, object]]:
        return self.catalog.records(active_only=True, oldest_first=True)

    def directory(self, conversion_id: str) -> Path:
        return self.root / conversion_id

    def record_path(self, conversion_id: str) -> Path:
        return self.directory(conversion_id) / "status.json"

    @contextmanager
    def execution(self, conversion_id: str) -> Generator[None]:
        try:
            with document_lock(self.directory(conversion_id) / "execution", timeout=0.01):
                yield
        except TimeoutError as exc:
            if str(exc).startswith("Timed out waiting to write"):
                raise ConversionBusyError("转换正在执行，请完成后再重试或更换方式") from exc
            raise

    def update(
        self,
        conversion_id: str,
        *,
        status: ConversionStatus,
        request: ImportRequest,
        original: OriginalRecord,
        parser: ParserName,
        error: str | None = None,
        outputs: dict[str, str] | None = None,
        stages: Mapping[str, str] | None = None,
        warnings: Sequence[str] | None = None,
    ) -> None:
        target = self.record_path(conversion_id)
        with document_lock(target):
            target.parent.mkdir(parents=True, exist_ok=True)
            existing: dict[str, object] = {}
            if target.exists():
                loaded_object = cast(
                    object,
                    json.loads(target.read_text(encoding="utf-8")),
                )
                if isinstance(loaded_object, dict):
                    existing = dict(cast(Mapping[str, object], loaded_object))
            now = datetime.now(UTC).isoformat(timespec="seconds")
            payload = {
                **existing,
                "conversion_id": conversion_id,
                "status": status.value,
                "source_sha256": original.sha256,
                "source_filename": original.filename,
                "original_path": str(original.stored_path),
                "intent": request.intent.value,
                "quality": request.quality.value,
                "parser": parser.value,
                "requested_parser": request.parser.value if request.parser is not None else "auto",
                "method": (request.method or ConversionMethod.from_parser(parser)).value,
                "course": request.course,
                "project": request.project,
                "generate": request.generate,
                "error": error,
                "stages": {
                    **(
                        dict(cast(Mapping[str, str], existing.get("stages")))
                        if isinstance(existing.get("stages"), dict)
                        else {}
                    ),
                    **(dict(stages) if stages is not None else {}),
                },
                "warnings": (
                    list(warnings) if warnings is not None else existing.get("warnings", [])
                ),
                "outputs": {
                    **(
                        cast(dict[str, object], existing["outputs"])
                        if isinstance(existing.get("outputs"), dict)
                        else {}
                    ),
                    **(outputs or {}),
                },
                "created_at": existing.get("created_at", now),
                "updated_at": now,
                "attempt": existing.get("attempt", 0),
            }
            if status is ConversionStatus.IMPORTED:
                payload["reparse"] = False
            self._write(target, payload)

    def transition(
        self,
        conversion_id: str,
        status: ConversionStatus,
        *,
        error: str | None = None,
        retry_after_seconds: float | None = None,
        increment_attempt: bool = False,
        outputs: Mapping[str, str] | None = None,
        stages: Mapping[str, str] | None = None,
    ) -> dict[str, object]:
        target = self.record_path(conversion_id)
        with document_lock(target):
            payload = self.load(conversion_id)
            now = datetime.now(UTC)
            payload["status"] = status.value
            payload["updated_at"] = now.isoformat(timespec="seconds")
            payload["error"] = error
            if retry_after_seconds is not None:
                payload["next_retry_at"] = (now + timedelta(seconds=retry_after_seconds)).isoformat(
                    timespec="seconds"
                )
            else:
                payload["next_retry_at"] = None
            if increment_attempt:
                attempt = payload.get("attempt", 0)
                payload["attempt"] = (attempt if isinstance(attempt, int) else 0) + 1
            if outputs:
                current = payload.get("outputs")
                merged = (
                    dict(cast(Mapping[str, object], current)) if isinstance(current, dict) else {}
                )
                merged.update(outputs)
                payload["outputs"] = merged
            if stages:
                current_stages = payload.get("stages")
                merged_stages = (
                    dict(cast(Mapping[str, object], current_stages))
                    if isinstance(current_stages, dict)
                    else {}
                )
                merged_stages.update(stages)
                payload["stages"] = merged_stages
            self._write(target, payload)
            return payload

    def record_parser_attempt(
        self,
        conversion_id: str,
        *,
        parser: ParserName,
        status: str,
        started_at: str,
        duration_ms: int,
        error: str | None = None,
        method: ConversionMethod | None = None,
    ) -> None:
        target = self.record_path(conversion_id)
        with document_lock(target):
            payload = self.load(conversion_id)
            existing = payload.get("parser_attempts")
            attempts = list(cast(list[object], existing)) if isinstance(existing, list) else []
            attempts.append(
                {
                    "parser": parser.value,
                    "method": (method or ConversionMethod.from_parser(parser)).value,
                    "status": status,
                    "started_at": started_at,
                    "duration_ms": duration_ms,
                    "error": error,
                }
            )
            payload["parser_attempts"] = attempts
            payload["updated_at"] = datetime.now(UTC).isoformat(timespec="seconds")
            self._write(target, payload)

    def reconcile_interrupted(self) -> int:
        changed = 0
        self.catalog.reconcile()
        for record in self.list():
            if record.get("status") not in {
                ConversionStatus.CONVERTING.value,
                ConversionStatus.READY.value,
            }:
                continue
            identifier = str(record["conversion_id"])
            try:
                with self.execution(identifier):
                    if self.load(identifier).get("status") not in {
                        ConversionStatus.CONVERTING.value,
                        ConversionStatus.READY.value,
                    }:
                        continue
                    self.transition(
                        identifier,
                        ConversionStatus.QUEUED,
                        error="conversion was interrupted and has been queued again",
                    )
            except ConversionBusyError:
                continue
            changed += 1
        return changed

    def queue_retry(
        self,
        conversion_id: str,
        *,
        parser: ParserName | None = None,
        method: ConversionMethod | None = None,
    ) -> dict[str, object]:
        target = self.record_path(conversion_id)
        with self.execution(conversion_id), document_lock(target):
            payload = self.load(conversion_id)
            if payload.get("status") == ConversionStatus.CONVERTING.value:
                raise ConversionBusyError("转换正在执行，请完成后再重试或更换方式")
            if (
                method is not None
                and parser is not None
                and method is not ConversionMethod.from_parser(parser)
            ):
                raise ValueError("method conflicts with legacy parser")
            selected = method or (ConversionMethod.from_parser(parser) if parser else None)
            stages = payload.get("stages")
            if (
                selected is None
                and payload.get("status") == ConversionStatus.IMPORTED.value
                and isinstance(stages, dict)
                and cast(dict[str, object], stages).get("semantic") in {"pending", "failed"}
            ):
                payload["error"] = None
                payload["next_retry_at"] = None
                self._write(target, payload)
                return payload
            if selected is not None:
                payload["requested_parser"] = parser.value if parser else "auto"
                payload["method"] = selected.value
                payload["parser"] = selected.parser.value
                payload["reparse"] = True
                payload["generation_revision"] = uuid.uuid4().hex
                outputs = payload.get("outputs")
                if isinstance(outputs, dict):
                    cast(dict[str, object], outputs).pop("semantic_operation_id", None)
            payload["status"] = ConversionStatus.QUEUED.value
            payload["error"] = None
            payload["next_retry_at"] = None
            payload["stages"] = (
                {**cast(dict[str, object], stages), "routing": "pending"}
                if selected is None
                and isinstance(stages, dict)
                and cast(dict[str, object], stages).get("conversion") == "completed"
                and cast(dict[str, object], stages).get("quality") == "passed"
                else {"upload": "completed", "conversion": "queued"}
            )
            payload["updated_at"] = datetime.now(UTC).isoformat(timespec="seconds")
            self._write(target, payload)
            return payload

    def load(self, conversion_id: str) -> dict[str, object]:
        path = self.record_path(conversion_id)
        if not path.is_file():
            raise FileNotFoundError(path)
        loaded_object = cast(
            object,
            json.loads(path.read_text(encoding="utf-8")),
        )
        if not isinstance(loaded_object, dict):
            raise ValueError(f"invalid conversion record: {path}")
        return dict(cast(Mapping[str, object], loaded_object))

    def list(self, *, status: ConversionStatus | None = None) -> list[dict[str, object]]:
        if not self.root.is_dir():
            return []
        return self.catalog.records(statuses=(status.value,) if status is not None else ())

    def _write(self, path: Path, payload: Mapping[str, object]) -> None:
        with self.catalog.writing(path, payload):
            atomic_write_bytes(
                path, (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            )

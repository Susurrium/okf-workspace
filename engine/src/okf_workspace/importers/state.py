"""One readable JSON record per simplified document conversion."""

from __future__ import annotations

import json
import os
import tempfile
from collections.abc import Mapping, Sequence
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

from okf_workspace.okf.file_io import document_lock

from .models import ConversionStatus, ImportRequest, OriginalRecord, ParserName


class ConversionStore:
    def __init__(self, root: Path) -> None:
        self.root = root.resolve() / "conversions"

    def directory(self, conversion_id: str) -> Path:
        return self.root / conversion_id

    def record_path(self, conversion_id: str) -> Path:
        return self.directory(conversion_id) / "status.json"

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
                "outputs": outputs or existing.get("outputs", {}),
                "created_at": existing.get("created_at", now),
                "updated_at": now,
                "attempt": existing.get("attempt", 0),
            }
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
    ) -> None:
        target = self.record_path(conversion_id)
        with document_lock(target):
            payload = self.load(conversion_id)
            existing = payload.get("parser_attempts")
            attempts = list(cast(list[object], existing)) if isinstance(existing, list) else []
            attempts.append(
                {
                    "parser": parser.value,
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
        for record in self.list():
            if record.get("status") != ConversionStatus.CONVERTING.value:
                continue
            self.transition(
                str(record["conversion_id"]),
                ConversionStatus.QUEUED,
                error="conversion was interrupted and has been queued again",
            )
            changed += 1
        return changed

    def queue_retry(
        self,
        conversion_id: str,
        *,
        parser: ParserName | None = None,
    ) -> dict[str, object]:
        target = self.record_path(conversion_id)
        with document_lock(target):
            payload = self.load(conversion_id)
            if parser is not None:
                payload["requested_parser"] = parser.value
                payload["parser"] = parser.value
            payload["status"] = ConversionStatus.QUEUED.value
            payload["error"] = None
            payload["next_retry_at"] = None
            payload["outputs"] = {}
            payload["stages"] = {"upload": "completed", "conversion": "queued"}
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
        records: list[dict[str, object]] = []
        if not self.root.is_dir():
            return records
        for path in self.root.glob("*/status.json"):
            try:
                record = self.load(path.parent.name)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            if status is not None and record.get("status") != status.value:
                continue
            records.append(record)
        records.sort(key=lambda item: str(item.get("updated_at", "")), reverse=True)
        return records

    @staticmethod
    def _write(path: Path, payload: Mapping[str, object]) -> None:
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

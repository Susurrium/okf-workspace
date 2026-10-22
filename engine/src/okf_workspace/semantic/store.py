"""Recoverable JSON manifests and atomic claims for semantic operations."""

from __future__ import annotations

import json
from collections.abc import Generator, Mapping
from contextlib import contextmanager
from dataclasses import asdict
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import cast

from okf_workspace.okf.file_io import atomic_write_bytes, document_lock
from okf_workspace.state_index import StateRecordIndex

from .models import SemanticKind, SemanticRequest, SemanticStage, SemanticStatus


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _parse_moment(value: object) -> datetime | None:
    if not isinstance(value, str):
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def _integer(value: object, default: int) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) else default


def _source_count(record: Mapping[str, object]) -> int:
    sources = record.get("sources")
    return len(cast(list[object], sources)) if isinstance(sources, list) else 0


class SemanticOperationStore:
    def __init__(self, state: Path) -> None:
        self.root = state.resolve() / "operations"
        self.lock_path = self.root / ".store.lock"
        self.catalog = StateRecordIndex(
            self.root,
            "op-*.json",
            "operation_id",
            lambda record: record.get("status") in {"queued", "running"},
        )

    def path(self, operation_id: str) -> Path:
        if not operation_id.startswith("op-") or not operation_id[3:].isalnum():
            raise ValueError("invalid semantic operation id")
        return self.root / f"{operation_id}.json"

    def create(
        self,
        request: SemanticRequest,
        *,
        fingerprint: str,
        source_hashes: Mapping[str, str],
        idempotency_key: str | None = None,
    ) -> dict[str, object]:
        now = _now()
        payload: dict[str, object] = {
            "schema": 6,
            **asdict(request),
            "kind": request.kind.value,
            "status": SemanticStatus.QUEUED.value,
            "stage": SemanticStage.QUEUED.value,
            "stage_detail": "等待后台 Worker",
            "stage_started_at": now,
            "fingerprint": fingerprint,
            "source_hashes": dict(source_hashes),
            "idempotency_key": idempotency_key,
            "attempt": 1,
            "worker_id": None,
            "heartbeat_at": None,
            "cancel_requested": False,
            "created_at": now,
            "updated_at": now,
            "started_at": None,
            "finished_at": None,
            "error": None,
            "actual_reads": [],
        }
        with self._lock():
            self._write(self.path(request.operation_id), payload)
        return payload

    def find_by_idempotency_key(self, key: str) -> dict[str, object] | None:
        records = self.catalog.records(key=key, limit=1)
        return records[0] if records else None

    def bind_handoff(self, record: dict[str, object], key: str | None) -> dict[str, object]:
        if key is None:
            return record
        with self._lock():
            current = self.load(str(record["operation_id"]))
            existing = current.get("handoff_keys")
            keys: list[str] = []
            if isinstance(existing, list):
                keys = [value for value in cast(list[object], existing) if isinstance(value, str)]
            if key not in keys:
                keys.append(key)
            current["handoff_keys"] = keys
            self._write(self.path(str(current["operation_id"])), current)
            return current

    @contextmanager
    def transaction(self) -> Generator[None]:
        """Serialize lookup, supersession and creation with worker claims."""
        with document_lock(self.lock_path):
            yield

    def find_active(self, fingerprint: str) -> dict[str, object] | None:
        active = {SemanticStatus.QUEUED.value, SemanticStatus.RUNNING.value}
        return next(
            (
                record
                for record in self.catalog.records(statuses=tuple(active), fingerprint=fingerprint)
                if record.get("fingerprint") == fingerprint and record.get("status") in active
            ),
            None,
        )

    def find_completed(self, fingerprint: str) -> dict[str, object] | None:
        return next(
            (
                record
                for record in self.catalog.records(
                    statuses=(SemanticStatus.COMPLETED.value,),
                    fingerprint=fingerprint,
                )
                if record.get("fingerprint") == fingerprint
                and record.get("status") == SemanticStatus.COMPLETED.value
            ),
            None,
        )

    def supersede_target(self, kind: SemanticKind, target: str) -> int:
        changed = 0
        with self._lock():
            for record in self.catalog.records(statuses=("queued", "orphaned")):
                if (
                    record.get("kind") == kind.value
                    and record.get("target") == target
                    and record.get("status")
                    in {SemanticStatus.QUEUED.value, SemanticStatus.ORPHANED.value}
                ):
                    self._transition_payload(
                        record,
                        SemanticStatus.SUPERSEDED,
                        error="superseded by a newer request for the same target",
                    )
                    self._write(self.path(str(record["operation_id"])), record)
                    changed += 1
        return changed

    def claim_next(self, worker_id: str) -> SemanticRequest | None:
        with self._lock():
            queued = self.catalog.records(statuses=("queued",), oldest_first=True, limit=1)
            if not queued:
                return None
            record = min(queued, key=lambda item: str(item.get("created_at", "")))
            if record.get("status") != SemanticStatus.QUEUED.value:
                self.catalog.reconcile()
                return None
            now = _now()
            record.update(
                {
                    "status": SemanticStatus.RUNNING.value,
                    "stage": SemanticStage.RETRIEVING.value,
                    "stage_detail": "正在检索相关笔记",
                    "stage_started_at": now,
                    "worker_id": worker_id,
                    "heartbeat_at": now,
                    "started_at": now,
                    "updated_at": now,
                    "error": None,
                    "cancel_requested": False,
                }
            )
            operation_id = str(record["operation_id"])
            self._write(self.path(operation_id), record)
            return self._request_from(record)

    def heartbeat(self, operation_id: str, worker_id: str) -> bool:
        with self._lock():
            payload = self.load(operation_id)
            if (
                payload.get("status") != SemanticStatus.RUNNING.value
                or payload.get("worker_id") != worker_id
            ):
                return False
            payload["heartbeat_at"] = _now()
            payload["updated_at"] = payload["heartbeat_at"]
            self._write(self.path(operation_id), payload)
            return True

    def set_stage(
        self,
        operation_id: str,
        worker_id: str,
        stage: SemanticStage,
        *,
        detail: str = "",
    ) -> bool:
        """Move a live operation to a visible stage without faking progress."""

        with self._lock():
            payload = self.load(operation_id)
            if (
                payload.get("status") != SemanticStatus.RUNNING.value
                or payload.get("worker_id") != worker_id
            ):
                return False
            now = _now()
            if payload.get("stage") != stage.value:
                payload["stage_started_at"] = now
            payload["stage"] = stage.value
            payload["stage_detail"] = detail
            payload["updated_at"] = now
            self._write(self.path(operation_id), payload)
            return True

    def complete(
        self,
        operation_id: str,
        *,
        actual_reads: tuple[str, ...],
    ) -> dict[str, object]:
        return self.update(
            operation_id,
            SemanticStatus.COMPLETED,
            actual_reads=actual_reads,
        )

    def fail(self, operation_id: str, error: str) -> dict[str, object]:
        return self.update(operation_id, SemanticStatus.FAILED, error=error[:2000])

    def update(
        self,
        operation_id: str,
        status: SemanticStatus,
        *,
        error: str | None = None,
        actual_reads: tuple[str, ...] = (),
    ) -> dict[str, object]:
        with self._lock():
            payload = self.load(operation_id)
            self._transition_payload(payload, status, error=error)
            if actual_reads:
                payload["actual_reads"] = list(actual_reads)
            self._write(self.path(operation_id), payload)
            return payload

    def retry(self, operation_id: str) -> dict[str, object]:
        with self._lock():
            payload = self.load(operation_id)
            payload.update(
                {
                    "status": SemanticStatus.QUEUED.value,
                    "stage": SemanticStage.QUEUED.value,
                    "stage_detail": "等待后台 Worker",
                    "stage_started_at": _now(),
                    "attempt": _integer(payload.get("attempt"), 1) + 1,
                    "worker_id": None,
                    "heartbeat_at": None,
                    "started_at": None,
                    "finished_at": None,
                    "cancel_requested": False,
                    "updated_at": _now(),
                    "error": None,
                }
            )
            self._write(self.path(operation_id), payload)
            return payload

    def cancel(self, operation_id: str) -> dict[str, object]:
        with self._lock():
            payload = self.load(operation_id)
            status = str(payload.get("status", ""))
            if status not in {SemanticStatus.QUEUED.value, SemanticStatus.RUNNING.value}:
                raise ValueError("only queued or running operations can be cancelled")
            payload["cancel_requested"] = True
            if status == SemanticStatus.QUEUED.value:
                self._transition_payload(payload, SemanticStatus.CANCELLED)
            else:
                if payload.get("stage") in {
                    SemanticStage.PUBLISHING.value,
                    SemanticStage.INDEXING.value,
                }:
                    raise ValueError("output is already being published and cannot be cancelled")
                payload["updated_at"] = _now()
                payload["stage_detail"] = "正在停止后台任务"
            self._write(self.path(operation_id), payload)
            return payload

    def cancelled(self, operation_id: str) -> bool:
        payload = self.load(operation_id)
        return bool(payload.get("cancel_requested")) or payload.get("status") == (
            SemanticStatus.CANCELLED.value
        )

    def reconcile_pending(
        self,
        *,
        stale_minutes: int = 5,
        recover_running: bool = True,
    ) -> int:
        """Normalize old records and recover one best request per target.

        This is called before the service starts its new worker, so a persisted
        running record belongs to the previous worker process and is recoverable
        immediately. ``recover_running=False`` keeps the timestamp-only behavior
        for diagnostic callers that may coexist with a live worker.
        """

        changed = 0
        cutoff = datetime.now(UTC) - timedelta(minutes=stale_minutes)
        with self._lock():
            self.catalog.reconcile()
            records = self._list_unlocked()
            original_records = {str(record["operation_id"]): record.copy() for record in records}
            active_groups: dict[tuple[str, str], list[dict[str, object]]] = {}
            for record in records:
                status = str(record.get("status", ""))
                if status == "generating":
                    record["status"] = SemanticStatus.ORPHANED.value
                    record["error"] = "recovered from the legacy in-process worker"
                    status = SemanticStatus.ORPHANED.value
                    changed += 1
                elif status == SemanticStatus.RUNNING.value:
                    heartbeat = _parse_moment(record.get("heartbeat_at")) or _parse_moment(
                        record.get("updated_at")
                    )
                    if recover_running or heartbeat is None or heartbeat < cutoff:
                        record["status"] = SemanticStatus.ORPHANED.value
                        record["error"] = "previous worker stopped; request recovered"
                        status = SemanticStatus.ORPHANED.value
                        changed += 1
                if _integer(record.get("schema"), 1) < 6:
                    record["schema"] = 6
                    record.setdefault("attempt", 1)
                    record.setdefault("worker_id", None)
                    record.setdefault("heartbeat_at", None)
                    record.setdefault("cancel_requested", False)
                    record.setdefault("course", None)
                    record.setdefault("project", None)
                    record.pop("learning_status", None)
                    record.pop("mode", None)
                    record.setdefault("stage", self._stage_for_record(record))
                    record.setdefault("stage_detail", "")
                    record.setdefault(
                        "stage_started_at",
                        record.get("started_at") or record.get("updated_at") or _now(),
                    )
                    kind = record.get("kind")
                    if isinstance(kind, str):
                        record["kind"] = SemanticKind.from_persisted(kind).value
                    changed += 1
                if status in {
                    SemanticStatus.QUEUED.value,
                    SemanticStatus.ORPHANED.value,
                }:
                    key = (str(record.get("kind", "")), str(record.get("target", "")))
                    active_groups.setdefault(key, []).append(record)
            for group in active_groups.values():
                best = max(
                    group,
                    key=lambda item: (
                        _source_count(item),
                        str(item.get("updated_at", "")),
                    ),
                )
                for record in group:
                    if record is best:
                        if record.get("status") != SemanticStatus.QUEUED.value:
                            record["status"] = SemanticStatus.QUEUED.value
                            record["stage"] = SemanticStage.QUEUED.value
                            record["stage_detail"] = "等待后台 Worker"
                            record["stage_started_at"] = _now()
                            record["worker_id"] = None
                            record["heartbeat_at"] = None
                            record["cancel_requested"] = False
                            record["updated_at"] = _now()
                            changed += 1
                    else:
                        self._transition_payload(
                            record,
                            SemanticStatus.SUPERSEDED,
                            error="duplicate legacy request superseded during recovery",
                        )
                        changed += 1
            for record in records:
                identifier = str(record["operation_id"])
                if record != original_records[identifier]:
                    self._write(self.path(identifier), record)
        return changed

    def load(self, operation_id: str) -> dict[str, object]:
        path = self.path(operation_id)
        loaded = cast(object, json.loads(path.read_text(encoding="utf-8")))
        if not isinstance(loaded, dict):
            raise ValueError(f"invalid semantic operation record: {path}")
        return dict(cast(Mapping[str, object], loaded))

    def request(self, operation_id: str) -> SemanticRequest:
        return self._request_from(self.load(operation_id))

    def list(self, *, status: SemanticStatus | None = None) -> list[dict[str, object]]:
        if not self.root.is_dir():
            return []
        return self.catalog.records(statuses=(status.value,) if status is not None else ())

    def _list_unlocked(self) -> list[dict[str, object]]:
        records: list[dict[str, object]] = []
        if not self.root.is_dir():
            return records
        for path in self.root.glob("op-*.json"):
            try:
                record = self.load(path.stem)
            except (OSError, ValueError, json.JSONDecodeError):
                continue
            records.append(record)
        return records

    @staticmethod
    def _request_from(record: Mapping[str, object]) -> SemanticRequest:
        sources = record.get("sources", [])
        if not isinstance(sources, list) or not all(
            isinstance(value, str) for value in cast(list[object], sources)
        ):
            raise ValueError("semantic operation sources are invalid")
        return SemanticRequest(
            operation_id=str(record["operation_id"]),
            kind=SemanticKind.from_persisted(str(record["kind"])),
            target=str(record["target"]),
            sources=tuple(cast(list[str], sources)),
            instruction=str(record.get("instruction", "")),
            course=(
                str(record["course"])
                if isinstance(record.get("course"), str) and record.get("course")
                else None
            ),
            project=(
                str(record["project"])
                if isinstance(record.get("project"), str) and record.get("project")
                else None
            ),
        )

    @staticmethod
    def _transition_payload(
        payload: dict[str, object],
        status: SemanticStatus,
        *,
        error: str | None = None,
    ) -> None:
        now = _now()
        payload["status"] = status.value
        payload["updated_at"] = now
        payload["error"] = error
        stage_by_status = {
            SemanticStatus.QUEUED: SemanticStage.QUEUED,
            SemanticStatus.COMPLETED: SemanticStage.COMPLETED,
            SemanticStatus.FAILED: SemanticStage.FAILED,
            SemanticStatus.CANCELLED: SemanticStage.CANCELLED,
        }
        stage = stage_by_status.get(status)
        if stage is not None:
            payload["stage"] = stage.value
            payload["stage_started_at"] = now
            payload["stage_detail"] = error or ""
        if status in {
            SemanticStatus.COMPLETED,
            SemanticStatus.FAILED,
            SemanticStatus.CANCELLED,
            SemanticStatus.SUPERSEDED,
        }:
            payload["finished_at"] = now
            payload["worker_id"] = None
            payload["heartbeat_at"] = None

    @staticmethod
    def _stage_for_record(record: Mapping[str, object]) -> str:
        status = str(record.get("status", ""))
        values = {
            SemanticStatus.QUEUED.value: SemanticStage.QUEUED.value,
            SemanticStatus.COMPLETED.value: SemanticStage.COMPLETED.value,
            SemanticStatus.FAILED.value: SemanticStage.FAILED.value,
            SemanticStatus.CANCELLED.value: SemanticStage.CANCELLED.value,
        }
        return values.get(status, SemanticStage.RETRIEVING.value)

    @contextmanager
    def _lock(self) -> Generator[None]:
        with self.transaction():
            yield

    def _write(self, path: Path, payload: Mapping[str, object]) -> None:
        with self.catalog.writing(path, payload):
            atomic_write_bytes(
                path, (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            )

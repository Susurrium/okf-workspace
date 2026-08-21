"""SQLite task ledger for the API and the single worker."""

from __future__ import annotations

import json
import sqlite3
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any


@dataclass(frozen=True, slots=True)
class JobRecord:
    task_id: str
    idempotency_key: str
    source_sha256: str
    filename: str
    profile: str
    size_bytes: int
    status: str
    created_at: float
    updated_at: float
    started_at: float | None
    completed_at: float | None
    expires_at: float | None
    attempts: int
    cancel_requested: bool
    page_count: int | None
    result_size_bytes: int | None
    result_sha256: str | None
    markdown_sha256: str | None
    warnings: tuple[str, ...]
    error_code: str | None
    error_message: str | None


@dataclass(frozen=True, slots=True)
class CreateJobResult:
    job: JobRecord
    created: bool
    conflict: bool = False


class QueueFullError(RuntimeError):
    """Raised when admitting another task would exceed the active queue bound."""


class JobStore:
    """Short-lived SQLite connections make cross-container ownership explicit."""

    def __init__(self, database_path: Path) -> None:
        self.database_path = database_path

    def _connect(self) -> sqlite3.Connection:
        connection = sqlite3.connect(self.database_path, timeout=5.0)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.execute("PRAGMA foreign_keys = ON")
        return connection

    def initialize(self) -> None:
        self.database_path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        with self._connect() as connection:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("PRAGMA synchronous = NORMAL")
            user_version = connection.execute("PRAGMA user_version").fetchone()[0]
            if user_version not in (0, 1):
                raise RuntimeError(f"unsupported task database schema version: {user_version}")
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS jobs (
                    task_id TEXT PRIMARY KEY,
                    idempotency_key TEXT NOT NULL UNIQUE,
                    source_sha256 TEXT NOT NULL,
                    filename TEXT NOT NULL,
                    profile TEXT NOT NULL,
                    size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
                    status TEXT NOT NULL CHECK (
                        status IN (
                            'pending', 'processing', 'completed', 'failed',
                            'cancelled', 'expired'
                        )
                    ),
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL,
                    started_at REAL,
                    completed_at REAL,
                    expires_at REAL,
                    attempts INTEGER NOT NULL DEFAULT 0,
                    cancel_requested INTEGER NOT NULL DEFAULT 0,
                    page_count INTEGER,
                    result_size_bytes INTEGER,
                    result_sha256 TEXT,
                    markdown_sha256 TEXT,
                    warnings_json TEXT NOT NULL DEFAULT '[]',
                    error_code TEXT,
                    error_message TEXT
                );

                CREATE INDEX IF NOT EXISTS jobs_status_created_idx
                    ON jobs(status, created_at);
                CREATE INDEX IF NOT EXISTS jobs_expiry_idx
                    ON jobs(expires_at) WHERE expires_at IS NOT NULL;

                CREATE TABLE IF NOT EXISTS service_state (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL,
                    updated_at REAL NOT NULL
                );

                PRAGMA user_version = 1;
                """
            )

    @staticmethod
    def _record(row: sqlite3.Row) -> JobRecord:
        warnings_raw: Any = json.loads(row["warnings_json"])
        warnings = (
            tuple(str(item) for item in warnings_raw) if isinstance(warnings_raw, list) else ()
        )
        return JobRecord(
            task_id=row["task_id"],
            idempotency_key=row["idempotency_key"],
            source_sha256=row["source_sha256"],
            filename=row["filename"],
            profile=row["profile"],
            size_bytes=row["size_bytes"],
            status=row["status"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
            started_at=row["started_at"],
            completed_at=row["completed_at"],
            expires_at=row["expires_at"],
            attempts=row["attempts"],
            cancel_requested=bool(row["cancel_requested"]),
            page_count=row["page_count"],
            result_size_bytes=row["result_size_bytes"],
            result_sha256=row["result_sha256"],
            markdown_sha256=row["markdown_sha256"],
            warnings=warnings,
            error_code=row["error_code"],
            error_message=row["error_message"],
        )

    def get(self, task_id: str) -> JobRecord | None:
        with self._connect() as connection:
            row = connection.execute("SELECT * FROM jobs WHERE task_id = ?", (task_id,)).fetchone()
        return None if row is None else self._record(row)

    def get_by_idempotency_key(self, key: str) -> JobRecord | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT * FROM jobs WHERE idempotency_key = ?", (key,)
            ).fetchone()
        return None if row is None else self._record(row)

    def create(
        self,
        *,
        task_id: str,
        idempotency_key: str,
        source_sha256: str,
        filename: str,
        profile: str,
        size_bytes: int,
        max_active_tasks: int | None = None,
    ) -> CreateJobResult:
        now = time.time()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            existing_row = connection.execute(
                "SELECT * FROM jobs WHERE idempotency_key = ?", (idempotency_key,)
            ).fetchone()
            if existing_row is not None:
                existing = self._record(existing_row)
                connection.commit()
                conflict = (
                    existing.source_sha256 != source_sha256
                    or existing.profile != profile
                    or Path(existing.filename).suffix.lower() != Path(filename).suffix.lower()
                )
                return CreateJobResult(job=existing, created=False, conflict=conflict)

            if max_active_tasks is not None:
                active_row = connection.execute(
                    """
                    SELECT COUNT(*) AS count FROM jobs
                    WHERE status IN ('pending', 'processing')
                    """
                ).fetchone()
                assert active_row is not None
                if int(active_row["count"]) >= max_active_tasks:
                    connection.rollback()
                    raise QueueFullError("the conversion queue is full")

            connection.execute(
                """
                INSERT INTO jobs (
                    task_id, idempotency_key, source_sha256, filename, profile,
                    size_bytes, status, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
                """,
                (
                    task_id,
                    idempotency_key,
                    source_sha256,
                    filename,
                    profile,
                    size_bytes,
                    now,
                    now,
                ),
            )
            created_row = connection.execute(
                "SELECT * FROM jobs WHERE task_id = ?", (task_id,)
            ).fetchone()
            connection.commit()

        assert created_row is not None
        return CreateJobResult(job=self._record(created_row), created=True)

    def release_expired_idempotency_key(self, key: str) -> bool:
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM jobs WHERE idempotency_key = ? AND status = 'expired'", (key,)
            )
        return cursor.rowcount == 1

    def claim_next(self) -> JobRecord | None:
        now = time.time()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                """
                SELECT task_id FROM jobs
                WHERE status = 'pending'
                ORDER BY created_at, task_id
                LIMIT 1
                """
            ).fetchone()
            if row is None:
                connection.commit()
                return None
            task_id = row["task_id"]
            connection.execute(
                """
                UPDATE jobs
                SET status = 'processing', started_at = ?, updated_at = ?,
                    attempts = attempts + 1
                WHERE task_id = ? AND status = 'pending'
                """,
                (now, now, task_id),
            )
            claimed = connection.execute(
                "SELECT * FROM jobs WHERE task_id = ?", (task_id,)
            ).fetchone()
            connection.commit()
        assert claimed is not None
        return self._record(claimed)

    def mark_completed(
        self,
        task_id: str,
        *,
        page_count: int,
        result_size_bytes: int,
        result_sha256: str,
        markdown_sha256: str,
        warnings: list[str],
        ttl_seconds: int,
    ) -> bool:
        now = time.time()
        with self._connect() as connection:
            cursor = connection.execute(
                """
                UPDATE jobs
                SET status = 'completed', updated_at = ?, completed_at = ?, expires_at = ?,
                    page_count = ?, result_size_bytes = ?, markdown_sha256 = ?,
                    result_sha256 = ?, warnings_json = ?,
                    error_code = NULL, error_message = NULL
                WHERE task_id = ? AND status = 'processing' AND cancel_requested = 0
                """,
                (
                    now,
                    now,
                    now + ttl_seconds,
                    page_count,
                    result_size_bytes,
                    markdown_sha256,
                    result_sha256,
                    json.dumps(warnings, ensure_ascii=False),
                    task_id,
                ),
            )
        return cursor.rowcount == 1

    def mark_failed(
        self,
        task_id: str,
        *,
        code: str,
        message: str,
        ttl_seconds: int,
    ) -> None:
        now = time.time()
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE jobs
                SET status = 'failed', updated_at = ?, completed_at = ?, expires_at = ?,
                    error_code = ?, error_message = ?
                WHERE task_id = ? AND status IN ('pending', 'processing')
                """,
                (now, now, now + ttl_seconds, code, message, task_id),
            )

    def cancel(self, task_id: str, *, ttl_seconds: int) -> JobRecord | None:
        now = time.time()
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            row = connection.execute(
                "SELECT status FROM jobs WHERE task_id = ?", (task_id,)
            ).fetchone()
            if row is None:
                connection.commit()
                return None
            status = row["status"]
            if status == "processing":
                connection.execute(
                    "UPDATE jobs SET cancel_requested = 1, updated_at = ? WHERE task_id = ?",
                    (now, task_id),
                )
            elif status in {"pending", "completed", "failed"}:
                connection.execute(
                    """
                    UPDATE jobs
                    SET status = 'cancelled', cancel_requested = 1, updated_at = ?,
                        completed_at = COALESCE(completed_at, ?), expires_at = ?
                    WHERE task_id = ?
                    """,
                    (now, now, now + ttl_seconds, task_id),
                )
            updated = connection.execute(
                "SELECT * FROM jobs WHERE task_id = ?", (task_id,)
            ).fetchone()
            connection.commit()
        assert updated is not None
        return self._record(updated)

    def finish_cancelled(self, task_id: str, *, ttl_seconds: int) -> None:
        now = time.time()
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE jobs
                SET status = 'cancelled', updated_at = ?, completed_at = ?, expires_at = ?
                WHERE task_id = ? AND status = 'processing' AND cancel_requested = 1
                """,
                (now, now, now + ttl_seconds, task_id),
            )

    def cancellation_requested(self, task_id: str) -> bool:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT cancel_requested FROM jobs WHERE task_id = ?", (task_id,)
            ).fetchone()
        return bool(row and row["cancel_requested"])

    def recover_interrupted(self, *, max_attempts: int, failure_ttl_seconds: int) -> None:
        now = time.time()
        with self._connect() as connection:
            connection.execute(
                """
                UPDATE jobs
                SET status = 'cancelled', updated_at = ?, completed_at = ?, expires_at = ?
                WHERE status = 'processing' AND cancel_requested = 1
                """,
                (now, now, now + failure_ttl_seconds),
            )
            connection.execute(
                """
                UPDATE jobs
                SET status = 'failed', updated_at = ?, completed_at = ?, expires_at = ?,
                    error_code = 'worker_interrupted',
                    error_message = 'The conversion worker was interrupted repeatedly.'
                WHERE status = 'processing' AND attempts >= ?
                """,
                (now, now, now + failure_ttl_seconds, max_attempts),
            )
            connection.execute(
                """
                UPDATE jobs
                SET status = 'pending', updated_at = ?, started_at = NULL
                WHERE status = 'processing'
                """,
                (now,),
            )

    def set_worker_heartbeat(self, *, timestamp: float | None = None) -> None:
        now = time.time() if timestamp is None else timestamp
        with self._connect() as connection:
            connection.execute(
                """
                INSERT INTO service_state(key, value, updated_at)
                VALUES ('worker_heartbeat', ?, ?)
                ON CONFLICT(key) DO UPDATE
                SET value = excluded.value, updated_at = excluded.updated_at
                """,
                (str(now), now),
            )

    def worker_heartbeat(self) -> float | None:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT value FROM service_state WHERE key = 'worker_heartbeat'"
            ).fetchone()
        if row is None:
            return None
        try:
            return float(row["value"])
        except ValueError:
            return None

    def queue_depth(self) -> int:
        with self._connect() as connection:
            row = connection.execute(
                "SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending', 'processing')"
            ).fetchone()
        assert row is not None
        return int(row["count"])

    def expire_due(self, *, now: float | None = None) -> list[str]:
        current = time.time() if now is None else now
        with self._connect() as connection:
            connection.execute("BEGIN IMMEDIATE")
            rows = connection.execute(
                """
                SELECT task_id FROM jobs
                WHERE status IN ('completed', 'failed', 'cancelled')
                  AND expires_at IS NOT NULL AND expires_at <= ?
                """,
                (current,),
            ).fetchall()
            task_ids = [str(row["task_id"]) for row in rows]
            if task_ids:
                placeholders = ",".join("?" for _ in task_ids)
                connection.execute(
                    f"UPDATE jobs SET status = 'expired', updated_at = ? "
                    f"WHERE task_id IN ({placeholders})",
                    (current, *task_ids),
                )
            connection.commit()
        return task_ids

    def purge_tombstones(self, *, older_than: float) -> int:
        with self._connect() as connection:
            cursor = connection.execute(
                "DELETE FROM jobs WHERE status = 'expired' AND updated_at <= ?", (older_than,)
            )
        return cursor.rowcount

    def active_task_ids(self) -> set[str]:
        with self._connect() as connection:
            rows = connection.execute(
                "SELECT task_id FROM jobs WHERE status != 'expired'"
            ).fetchall()
        return {str(row["task_id"]) for row in rows}

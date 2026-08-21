"""Single-consumer worker with subprocess isolation and TTL cleanup."""

from __future__ import annotations

import hashlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
import zipfile
from contextlib import suppress
from pathlib import Path
from typing import Any

from .config import Settings
from .constants import RESULT_SCHEMA
from .storage import JobRecord, JobStore


class Worker:
    def __init__(self, settings: Settings, *, stop_event: threading.Event | None = None) -> None:
        self.settings = settings
        self.store = JobStore(settings.database_path)
        self.stop_event = stop_event or threading.Event()

    def initialize(self) -> None:
        self.settings.prepare_directories()
        self.store.initialize()
        self.store.recover_interrupted(
            max_attempts=self.settings.max_attempts,
            failure_ttl_seconds=self.settings.failure_ttl_seconds,
        )
        self._cleanup()
        self.store.set_worker_heartbeat()

    def run_forever(self) -> None:
        self.initialize()
        while not self.stop_event.is_set():
            self.store.set_worker_heartbeat()
            self._cleanup()
            if not self.settings.storage_status().can_fit(self.settings.max_result_bytes):
                self.stop_event.wait(self.settings.poll_seconds)
                continue
            job = self.store.claim_next()
            if job is None:
                self.stop_event.wait(self.settings.poll_seconds)
                continue
            self._process(job)

    def _input_path(self, job: JobRecord) -> Path:
        suffix = Path(job.filename).suffix.lower()
        return self.settings.incoming_dir / f"{job.task_id}{suffix}"

    def _result_path(self, task_id: str) -> Path:
        return self.settings.results_dir / f"{task_id}.zip"

    def _failure_path(self, task_id: str) -> Path:
        return self.settings.failed_dir / f"{task_id}.json"

    def _child_command(self, job: JobRecord) -> list[str]:
        return [
            sys.executable,
            "-m",
            "markitdown_service.conversion",
            "--input",
            str(self._input_path(job)),
            "--output",
            str(self._result_path(job.task_id)),
            "--failure",
            str(self._failure_path(job.task_id)),
            "--source-sha256",
            job.source_sha256,
            "--filename",
            job.filename,
            "--profile",
            job.profile,
            "--max-pages",
            str(self.settings.max_pages),
            "--max-result-bytes",
            str(self.settings.max_result_bytes),
            "--engine-version",
            self.settings.engine_version,
            "--engine-build-id",
            self.settings.engine_build_id,
        ]

    def _process(self, job: JobRecord) -> None:
        input_path = self._input_path(job)
        result_path = self._result_path(job.task_id)
        failure_path = self._failure_path(job.task_id)
        result_path.unlink(missing_ok=True)
        failure_path.unlink(missing_ok=True)

        if not input_path.is_file():
            self.store.mark_failed(
                job.task_id,
                code="input_missing",
                message="The staged document is missing.",
                ttl_seconds=self.settings.failure_ttl_seconds,
            )
            return

        creation_flags = 0
        if os.name == "nt":
            creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP
        process = subprocess.Popen(
            self._child_command(job),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            close_fds=True,
            start_new_session=os.name != "nt",
            creationflags=creation_flags,
        )
        deadline = time.monotonic() + self.settings.conversion_timeout_seconds
        outcome = "finished"
        while process.poll() is None:
            self.store.set_worker_heartbeat()
            if self.stop_event.is_set():
                outcome = "interrupted"
                self._terminate(process)
                break
            if self.store.cancellation_requested(job.task_id):
                outcome = "cancelled"
                self._terminate(process)
                break
            if time.monotonic() >= deadline:
                outcome = "timeout"
                self._terminate(process)
                break
            self.stop_event.wait(min(0.25, self.settings.poll_seconds))

        if outcome == "interrupted":
            return
        if outcome == "cancelled":
            self.store.finish_cancelled(job.task_id, ttl_seconds=self.settings.failure_ttl_seconds)
            self._remove_task_files(job)
            return
        if outcome == "timeout":
            self.store.mark_failed(
                job.task_id,
                code="conversion_timeout",
                message="The document conversion exceeded its time limit.",
                ttl_seconds=self.settings.failure_ttl_seconds,
            )
            self._remove_task_files(job)
            return

        if process.returncode == 0:
            try:
                manifest, result_sha256 = self._inspect_result(result_path, expected_job=job)
            except (OSError, ValueError, KeyError, json.JSONDecodeError, zipfile.BadZipFile):
                self.store.mark_failed(
                    job.task_id,
                    code="invalid_result",
                    message="The conversion worker produced an invalid result bundle.",
                    ttl_seconds=self.settings.failure_ttl_seconds,
                )
                self._remove_task_files(job)
                return
            completed = self.store.mark_completed(
                job.task_id,
                page_count=int(manifest["input"]["unit_count"]),
                result_size_bytes=result_path.stat().st_size,
                result_sha256=result_sha256,
                markdown_sha256=str(manifest["output"]["markdown_sha256"]),
                warnings=[str(value) for value in manifest.get("warnings", [])],
                ttl_seconds=self.settings.success_ttl_seconds,
            )
            input_path.unlink(missing_ok=True)
            failure_path.unlink(missing_ok=True)
            if not completed:
                result_path.unlink(missing_ok=True)
            return

        code, message = self._read_failure(failure_path)
        self.store.mark_failed(
            job.task_id,
            code=code,
            message=message,
            ttl_seconds=self.settings.failure_ttl_seconds,
        )
        self._remove_task_files(job)

    @staticmethod
    def _terminate(process: subprocess.Popen[bytes]) -> None:
        if process.poll() is not None:
            return
        try:
            if os.name == "nt":
                process.terminate()
            else:
                os.killpg(process.pid, signal.SIGTERM)
            process.wait(timeout=5)
        except (OSError, subprocess.TimeoutExpired):
            try:
                if os.name == "nt":
                    process.kill()
                else:
                    os.killpg(process.pid, signal.SIGKILL)
            except OSError:
                pass
            with suppress(subprocess.TimeoutExpired):
                process.wait(timeout=5)

    @staticmethod
    def _read_failure(path: Path) -> tuple[str, str]:
        try:
            value: Any = json.loads(path.read_text(encoding="utf-8"))
            code = str(value["code"])
            message = str(value["message"])
            if not code or not message:
                raise ValueError
            return code[:80], message[:300]
        except (OSError, ValueError, KeyError, TypeError, json.JSONDecodeError):
            return "conversion_failed", "The MarkItDown conversion process failed."

    def _inspect_result(self, path: Path, *, expected_job: JobRecord) -> tuple[dict[str, Any], str]:
        if path.stat().st_size > self.settings.max_result_bytes:
            raise ValueError("oversized result")
        result_digest = hashlib.sha256()
        with path.open("rb") as result_handle:
            for chunk in iter(lambda: result_handle.read(1024 * 1024), b""):
                result_digest.update(chunk)
        with zipfile.ZipFile(path) as archive:
            if set(archive.namelist()) != {"manifest.json", "document.md"}:
                raise ValueError("unexpected result entries")
            manifest_info = archive.getinfo("manifest.json")
            markdown_info = archive.getinfo("document.md")
            if manifest_info.file_size > 64 * 1024:
                raise ValueError("oversized manifest")
            if markdown_info.file_size > self.settings.max_result_bytes:
                raise ValueError("oversized markdown")
            manifest = json.loads(archive.read("manifest.json"))
            markdown = archive.read("document.md")
        if manifest["schema"] != RESULT_SCHEMA:
            raise ValueError("result schema mismatch")
        if manifest["source_sha256"] != expected_job.source_sha256:
            raise ValueError("source hash mismatch")
        if manifest["profile"] != expected_job.profile:
            raise ValueError("profile mismatch")
        expected_format = Path(expected_job.filename).suffix.lower().lstrip(".")
        if manifest["input"]["source_format"] != expected_format:
            raise ValueError("source format mismatch")
        expected_unit = (
            "page"
            if expected_format == "pdf"
            else ("slide" if expected_format == "pptx" else "document")
        )
        if manifest["input"]["unit_kind"] != expected_unit:
            raise ValueError("logical unit kind mismatch")
        if manifest["engine"]["version"] != self.settings.engine_version:
            raise ValueError("engine version mismatch")
        if manifest["engine"]["build_id"] != self.settings.engine_build_id:
            raise ValueError("engine build mismatch")
        if manifest["output"]["markdown_sha256"] != hashlib.sha256(markdown).hexdigest():
            raise ValueError("markdown hash mismatch")
        if manifest["output"]["markdown_bytes"] != len(markdown):
            raise ValueError("markdown size mismatch")
        return manifest, result_digest.hexdigest()

    def _remove_task_files(self, job: JobRecord) -> None:
        self._input_path(job).unlink(missing_ok=True)
        self._result_path(job.task_id).unlink(missing_ok=True)
        self._failure_path(job.task_id).unlink(missing_ok=True)

    def _cleanup(self) -> None:
        now = time.time()
        for task_id in self.store.expire_due(now=now):
            for suffix in (".pdf", ".pptx", ".docx"):
                (self.settings.incoming_dir / f"{task_id}{suffix}").unlink(missing_ok=True)
            self._result_path(task_id).unlink(missing_ok=True)
            self._failure_path(task_id).unlink(missing_ok=True)
        self.store.purge_tombstones(older_than=now - self.settings.tombstone_ttl_seconds)

        active = self.store.active_task_ids()
        cutoff = now - self.settings.orphan_ttl_seconds
        for directory in (
            self.settings.incoming_dir,
            self.settings.results_dir,
            self.settings.failed_dir,
        ):
            for candidate in directory.iterdir():
                if not candidate.is_file() or candidate.name.startswith("."):
                    continue
                task_id = candidate.name.split(".", maxsplit=1)[0]
                try:
                    modified = candidate.stat().st_mtime
                except OSError:
                    continue
                if task_id not in active and modified <= cutoff:
                    candidate.unlink(missing_ok=True)


def run_worker() -> None:
    settings = Settings.from_environment(require_tokens=False)
    stop_event = threading.Event()

    def request_stop(_signum: int, _frame: object) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, request_stop)
    signal.signal(signal.SIGINT, request_stop)
    Worker(settings, stop_event=stop_event).run_forever()

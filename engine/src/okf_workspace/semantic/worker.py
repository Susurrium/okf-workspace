"""Independent semantic worker process.

This module is deliberately outside FastAPI's process. Slow Codex execution or
FastEmbed model loading therefore cannot block the local API health endpoint.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from contextlib import suppress
from datetime import datetime
from pathlib import Path
from typing import BinaryIO, TextIO

from okf_workspace.ai.provider import CodexSettings
from okf_workspace.git import GitCheckpointError, create_checkpoint
from okf_workspace.notes.organize import replace_managed_region
from okf_workspace.okf.artifacts import render_artifact_body
from okf_workspace.okf.file_io import FileWriteConflict, atomic_write_bytes, document_lock
from okf_workspace.okf.frontmatter import (
    OkfDocument,
    parse_document,
    read_document,
    write_document,
)
from okf_workspace.okf.paths import resolve_bundle_path
from okf_workspace.okf.relations import inherited_context_fields, source_paths
from okf_workspace.okf.validator import validate_document
from okf_workspace.retrieval.index import SearchIndex

from .models import SemanticKind, SemanticRequest, SemanticStage, SemanticStatus
from .runner import (
    CodexSemanticRunner,
    ControllableSemanticRunner,
    SemanticCancelled,
    SemanticRunner,
)
from .store import SemanticOperationStore


class SemanticWorker:
    def __init__(self, vault: Path, state: Path, runner: SemanticRunner) -> None:
        self.vault = vault.resolve()
        self.state = state.resolve()
        self.runner = runner
        self.store = SemanticOperationStore(self.state)
        self.worker_id = f"worker-{os.getpid()}-{uuid.uuid4().hex[:8]}"

    def run_once(self) -> bool:
        request = self.store.claim_next(self.worker_id)
        if request is None:
            return False
        self._write_status("running", request.operation_id)
        self._log(
            "info",
            "operation_claimed",
            operation_id=request.operation_id,
            kind=request.kind.value,
            target=request.target,
        )
        stopped = threading.Event()
        heartbeat = threading.Thread(
            target=self._heartbeat,
            args=(request.operation_id, stopped),
            name=f"heartbeat-{request.operation_id}",
            daemon=True,
        )
        heartbeat.start()

        def on_stage(stage: SemanticStage, detail: str) -> None:
            if not self.store.set_stage(
                request.operation_id,
                self.worker_id,
                stage,
                detail=detail,
            ):
                raise SemanticCancelled("semantic operation is no longer owned by this worker")
            self._log(
                "info",
                "operation_stage",
                operation_id=request.operation_id,
                stage=stage.value,
                detail=detail,
            )

        try:
            if isinstance(self.runner, ControllableSemanticRunner):
                output = self.runner.generate_controlled(
                    request,
                    should_cancel=lambda: self.store.cancelled(request.operation_id),
                    on_stage=on_stage,
                )
            else:
                output = self.runner.generate(request)
            if self.store.cancelled(request.operation_id):
                raise SemanticCancelled("semantic operation cancelled")
            on_stage(SemanticStage.PUBLISHING, "正在写入目标笔记")
            self._publish(request, output.content)
            on_stage(SemanticStage.INDEXING, "内容已写入，正在刷新检索索引")
            try:
                SearchIndex(self.vault, self.state / "brain.sqlite").sync()
            except Exception as exc:
                # The Markdown result is already valid and authoritative. A
                # rebuildable search index must not turn that success into a
                # failed generation task.
                self._log(
                    "warning",
                    "index_refresh_deferred",
                    operation_id=request.operation_id,
                    error=str(exc),
                )
            self.store.complete(request.operation_id, actual_reads=output.actual_reads)
            self._log(
                "info",
                "operation_completed",
                operation_id=request.operation_id,
                actual_reads=list(output.actual_reads),
            )
        except SemanticCancelled as exc:
            self.store.update(request.operation_id, SemanticStatus.CANCELLED)
            self._log(
                "info",
                "operation_cancelled",
                operation_id=request.operation_id,
                detail=str(exc),
            )
        except Exception as exc:
            self.store.fail(request.operation_id, str(exc))
            self._log(
                "error",
                "operation_failed",
                operation_id=request.operation_id,
                error=str(exc),
            )
        finally:
            stopped.set()
            heartbeat.join(timeout=1)
            self._write_status("idle", None)
        return True

    def run_forever(self, stop: threading.Event, *, poll_seconds: float = 0.5) -> None:
        self._write_status("idle", None)
        next_idle_heartbeat = time.monotonic() + 15
        while not stop.is_set():
            if self.run_once():
                next_idle_heartbeat = time.monotonic() + 15
            else:
                if time.monotonic() >= next_idle_heartbeat:
                    # Keep the process observable without rewriting a state file
                    # on every short queue poll.
                    self._write_status("idle", None)
                    next_idle_heartbeat = time.monotonic() + 15
                stop.wait(poll_seconds)

    def _heartbeat(self, operation_id: str, stopped: threading.Event) -> None:
        while not stopped.wait(15):
            self._write_status("running", operation_id)
            if not self.store.heartbeat(operation_id, self.worker_id):
                return

    @staticmethod
    def _log(level: str, event: str, **fields: object) -> None:
        print(
            json.dumps(
                {
                    "time": datetime.now().astimezone().isoformat(timespec="seconds"),
                    "level": level,
                    "event": event,
                    **fields,
                },
                ensure_ascii=False,
            ),
            flush=True,
        )

    def _write_status(self, status: str, operation_id: str | None) -> None:
        path = self.state / "semantic-worker.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "schema": 1,
            "worker_id": self.worker_id,
            "pid": os.getpid(),
            "status": status,
            "operation_id": operation_id,
            "heartbeat_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        }
        descriptor, name = tempfile.mkstemp(
            prefix=".semantic-worker.", suffix=".tmp", dir=path.parent
        )
        temporary = Path(name)
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2)
                handle.write("\n")
            os.replace(temporary, path)
        finally:
            temporary.unlink(missing_ok=True)

    def _publish(self, request: SemanticRequest, content: str) -> None:
        path = resolve_bundle_path(self.vault, request.target)
        with suppress(GitCheckpointError):
            create_checkpoint(self.vault, f"checkpoint before {request.kind.value}")
        try:
            with document_lock(path):
                had_target = path.is_file()
                for attempt in range(3):
                    original = path.read_bytes() if path.is_file() else None
                    if had_target and original is None:
                        raise FileWriteConflict(f"Target was deleted during publication: {path}")
                    document = (
                        parse_document(original.decode("utf-8"), source=str(path))
                        if original is not None
                        else self._new_document(request, content)
                    )
                    self._prepare_document(request, path, document, content)
                    report = validate_document(self.vault, path, document)
                    if not report.valid:
                        details = "; ".join(
                            f"{issue.path}: {issue.message}" for issue in report.errors[:5]
                        )
                        raise RuntimeError(f"semantic output failed Vault validation: {details}")
                    try:
                        write_document(
                            path,
                            document,
                            create_only=original is None,
                            expected_sha256=hashlib.sha256(original).hexdigest()
                            if original is not None
                            else None,
                        )
                        break
                    except FileWriteConflict:
                        if attempt == 2:
                            raise
                        # Reread and merge into the latest human text, never roll
                        # back an entire note using an old snapshot.
        except Exception:
            # Keep useful generated output outside the Vault for recovery.
            recovery = self.state / "semantic-output" / f"{request.operation_id}.md"
            atomic_write_bytes(recovery, content.encode("utf-8"))
            raise
        with suppress(GitCheckpointError):
            create_checkpoint(self.vault, f"semantic: {request.kind.value} {request.target}")

    def _prepare_document(
        self,
        request: SemanticRequest,
        path: Path,
        document: OkfDocument,
        content: str,
    ) -> None:
        if request.kind in {
            SemanticKind.GENERATE_STUDY_GUIDE,
            SemanticKind.REFRESH_STUDY_GUIDE,
        }:
            if document.type != "Study Guide":
                raise ValueError("study material target must be a Study Guide")
            region = "study-material"
        else:
            if document.type != "Wiki":
                raise ValueError("Wiki target must use type: Wiki")
            region = "wiki-content"
        document.body = replace_managed_region(document.body, region, content)
        context_sources = tuple(dict.fromkeys((*request.sources, *source_paths(document))))
        inherited = inherited_context_fields(
            self.vault,
            context_sources,
            current=document.frontmatter,
        )
        explicit = {
            field: value
            for field, value in (("course", request.course), ("project", request.project))
            if value is not None
        }
        for field, value in inherited.items():
            document.frontmatter.setdefault(field, value)
        # Explicit workflow context is the user's current routing choice and wins.
        document.frontmatter.update(explicit)
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        document.frontmatter.setdefault("title", path.stem)
        document.frontmatter.setdefault("created_at", now)
        # Learning completion is a human decision, never a generation side effect.
        if document.frontmatter.get("status") == "stable":
            document.frontmatter.pop("status", None)
        document.frontmatter.pop("study_material_status", None)
        document.frontmatter.pop("generation_status", None)
        document.frontmatter.pop("updated_at", None)
        document.frontmatter.pop("owner", None)
        if request.kind is SemanticKind.GENERATE_WIKI:
            if not document.frontmatter.get("sources"):
                document.frontmatter["sources"] = [
                    {"resource": value if value.startswith("/") else f"/{value}"}
                    for value in request.sources
                ]
            document.frontmatter["generated"] = {
                "by": "process:codex-background",
                "at": now,
            }

    def _new_document(self, request: SemanticRequest, content: str) -> OkfDocument:
        if request.kind is SemanticKind.REFRESH_STUDY_GUIDE:
            raise FileNotFoundError(resolve_bundle_path(self.vault, request.target))
        title = Path(request.target).stem
        for relative in request.sources:
            source = resolve_bundle_path(self.vault, relative)
            if not source.is_file():
                continue
            source_title = read_document(source).frontmatter.get("title")
            if isinstance(source_title, str) and source_title.strip():
                title = source_title.strip()
                break
        now = datetime.now().astimezone().isoformat(timespec="seconds")
        sources = [
            {"resource": value if value.startswith("/") else f"/{value}"}
            for value in request.sources
        ]
        context = inherited_context_fields(self.vault, request.sources)
        context.update(
            {
                field: value
                for field, value in (("course", request.course), ("project", request.project))
                if value is not None
            }
        )
        if request.kind is SemanticKind.GENERATE_WIKI:
            visible = next(
                (
                    line.strip()
                    for line in content.splitlines()
                    if line.strip() and not line.lstrip().startswith(("#", "<!--"))
                ),
                title,
            )
            return OkfDocument(
                {
                    "type": "Wiki",
                    "title": title,
                    "description": visible[:200],
                    "sources": sources,
                    "created_at": now,
                    **context,
                },
                render_artifact_body(
                    self.vault,
                    "wiki",
                    title=title,
                    content=(
                        '<!-- ai:auto:start name="wiki-content" -->\n'
                        '<!-- ai:auto:end name="wiki-content" -->'
                    ),
                ),
            )
        return OkfDocument(
            {
                "type": "Study Guide",
                "title": title,
                "sources": sources,
                "created_at": now,
                **context,
            },
            render_artifact_body(
                self.vault,
                "study-guide",
                title=title,
                content="",
            ),
        )


def stop_when_stdin_closes(stop: threading.Event, stream: BinaryIO) -> None:
    """Stop a service-owned semantic worker when the API process disappears."""

    with suppress(OSError):
        stream.read()
    stop.set()


class SemanticWorkerProcess:
    def __init__(self, vault: Path, state: Path) -> None:
        self.vault = vault.resolve()
        self.state = state.resolve()
        self.process: subprocess.Popen[bytes] | None = None
        self.log: TextIO | None = None

    def start(self) -> None:
        if self.process is not None and self.process.poll() is None:
            return
        log_directory = self.state / "logs"
        log_directory.mkdir(parents=True, exist_ok=True)
        logs = sorted(
            log_directory.glob("semantic-worker-*.log"),
            key=lambda path: path.stat().st_mtime,
            reverse=True,
        )
        for stale in logs[7:]:
            stale.unlink(missing_ok=True)
        log_path = log_directory / f"semantic-worker-{datetime.now():%Y%m%d}.log"
        self.log = log_path.open("a", encoding="utf-8", buffering=1)
        environment = os.environ.copy()
        environment["PYTHONUTF8"] = "1"
        self.process = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "okf_workspace.semantic.worker",
                "--vault",
                str(self.vault),
                "--state",
                str(self.state),
                "--exit-on-stdin-close",
            ],
            stdin=subprocess.PIPE,
            stdout=self.log,
            stderr=self.log,
            env=environment,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )

    def stop(self) -> None:
        process = self.process
        self.process = None
        if process is not None and process.poll() is None:
            if process.stdin is not None:
                process.stdin.close()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.terminate()
                try:
                    process.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    process.kill()
        if self.log is not None:
            self.log.close()
            self.log = None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="okf-semantic-worker")
    parser.add_argument("--vault", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--exit-on-stdin-close", action="store_true")
    args = parser.parse_args(argv)
    stop = threading.Event()
    worker = SemanticWorker(
        args.vault,
        args.state,
        CodexSemanticRunner(args.vault, args.state, CodexSettings.from_env()),
    )
    if args.exit_on_stdin_close:
        threading.Thread(
            target=stop_when_stdin_closes,
            args=(stop, sys.stdin.buffer),
            name="okf-semantic-owner-watch",
            daemon=True,
        ).start()
    with suppress(KeyboardInterrupt):
        worker.run_forever(stop)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

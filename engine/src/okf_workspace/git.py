"""Local Git checkpoints for recoverable AI and automation writes."""

from __future__ import annotations

import os
import subprocess
import threading
import time
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

_GIT_TIMEOUT_SECONDS = 8
_LOCK_TIMEOUT_SECONDS = 30.0
_PROCESS_LOCK = threading.RLock()


class GitCheckpointError(RuntimeError):
    """Raised when a local checkpoint operation fails."""


@contextmanager
def _repository_write_lock(repository: Path) -> Generator[None, None, None]:
    """Serialize OKF Git writers across API and semantic-worker processes."""

    lock_path = repository / ".git" / "okf-workspace-checkpoint.lock"
    lock_path.parent.mkdir(parents=True, exist_ok=True)
    deadline = time.monotonic() + _LOCK_TIMEOUT_SECONDS
    with _PROCESS_LOCK, lock_path.open("a+b") as handle:
        handle.seek(0, os.SEEK_END)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise GitCheckpointError(
                        "another OKF Git checkpoint is still running after 30s"
                    ) from exc
                time.sleep(0.1)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _run(repository: Path, *arguments: str, check: bool = True) -> str:
    environment = os.environ.copy()
    environment.update(
        {
            "GCM_INTERACTIVE": "Never",
            "GIT_OPTIONAL_LOCKS": "0",
            "GIT_PAGER": "cat",
            "GIT_TERMINAL_PROMPT": "0",
            "PAGER": "cat",
        }
    )
    try:
        completed = subprocess.run(
            ["git", "-C", str(repository), *arguments],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            stdin=subprocess.DEVNULL,
            timeout=_GIT_TIMEOUT_SECONDS,
            env=environment,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except subprocess.TimeoutExpired as exc:
        raise GitCheckpointError(
            f"git {' '.join(arguments)} timed out after {_GIT_TIMEOUT_SECONDS}s"
        ) from exc
    if check and completed.returncode != 0:
        detail = completed.stderr.strip() or completed.stdout.strip()
        raise GitCheckpointError(f"git {' '.join(arguments)} failed: {detail}")
    return completed.stdout.strip()


def initialize_repository(repository: Path) -> None:
    repository = repository.resolve()
    repository.mkdir(parents=True, exist_ok=True)
    if not (repository / ".git").is_dir():
        _run(repository, "init", "--initial-branch=main")
    if not _run(repository, "config", "--local", "--get", "user.name", check=False):
        _run(repository, "config", "--local", "user.name", "OKF Workspace")
    if not _run(repository, "config", "--local", "--get", "user.email", check=False):
        _run(repository, "config", "--local", "user.email", "okf-workspace@local")


def checkpointing_enabled(repository: Path) -> bool:
    """Return whether this Vault explicitly opted into local Git checkpoints."""

    return (repository.resolve() / ".git").is_dir()


def create_checkpoint(repository: Path, message: str) -> str | None:
    repository = repository.resolve()
    if not checkpointing_enabled(repository):
        return None
    with _repository_write_lock(repository):
        _run(repository, "add", "-A")
        staged = _run(repository, "diff", "--cached", "--name-only")
        if not staged:
            return _run(repository, "rev-parse", "HEAD", check=False) or None
        _run(repository, "commit", "-m", message)
        return _run(repository, "rev-parse", "HEAD")


def undo_last_checkpoint(repository: Path) -> str:
    repository = repository.resolve()
    if not checkpointing_enabled(repository):
        raise GitCheckpointError(
            "Vault Git checkpoints are not enabled; run `okf checkpoint` to opt in"
        )
    with _repository_write_lock(repository):
        if _run(repository, "status", "--porcelain"):
            raise GitCheckpointError("working tree must be clean before undo")
        head = _run(repository, "rev-parse", "HEAD")
        parent = _run(repository, "rev-parse", f"{head}^", check=False)
        if not parent:
            raise GitCheckpointError("the initial checkpoint cannot be reverted automatically")
        _run(repository, "revert", "--no-edit", head)
        return _run(repository, "rev-parse", "HEAD")


def latest_checkpoint_summary(repository: Path) -> dict[str, object] | None:
    repository = repository.resolve()
    if not (repository / ".git").is_dir():
        return None
    commit = _run(repository, "rev-parse", "HEAD", check=False)
    if not commit:
        return None
    message = _run(repository, "log", "-1", "--format=%s")
    changed = _run(
        repository,
        "-c",
        "core.quotepath=false",
        "show",
        "--format=",
        "--name-only",
        "HEAD",
    )
    files = [line for line in changed.splitlines() if line.strip()]
    return {"checkpoint": commit, "message": message, "files": files}

"""Small, shared file-write primitives; Markdown remains the authority.

Locks coordinate Workspace processes only. Version checks detect intervening
editor changes up to publication; editors that do not participate in the lock
are not part of a filesystem transaction.
"""

from __future__ import annotations

import hashlib
import os
import tempfile
import threading
import time
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path

_LOCKS: dict[str, threading.RLock] = {}
_LOCKS_GUARD = threading.Lock()
_HELD = threading.local()


class FileWriteConflict(RuntimeError):
    """The file changed after it was read; stale bytes were not published."""


def file_sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


@contextmanager
def document_lock(path: Path, *, timeout: float = 30.0) -> Generator[None]:
    """Reentrant per-path mutex shared by threads and local Workspace processes.

    The path can be a virtual transaction identity. Nothing is created at that
    path. Lock files live outside the Vault and must not be unlinked on release
    (another process may already hold a descriptor to the same lock file).
    """

    key = hashlib.sha256(os.path.normcase(str(path.resolve())).encode()).hexdigest()
    with _LOCKS_GUARD:
        local_lock = _LOCKS.setdefault(key, threading.RLock())
    if not local_lock.acquire(timeout=timeout):
        raise TimeoutError(f"Timed out waiting to write {path.name}")
    held: set[str] = getattr(_HELD, "keys", set())
    _HELD.keys = held
    try:
        if key in held:
            yield
            return
        root = Path(tempfile.gettempdir()) / "okf-workspace-file-locks"
        root.mkdir(parents=True, exist_ok=True)
        with (root / f"{key}.lock").open("a+b") as handle:
            if handle.seek(0, os.SEEK_END) == 0:
                handle.write(b"\0")
                handle.flush()
            deadline = time.monotonic() + timeout
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
                        raise TimeoutError(f"Timed out waiting to write {path.name}") from exc
                    time.sleep(0.025)
            held.add(key)
            try:
                yield
            finally:
                held.remove(key)
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
    finally:
        local_lock.release()


def atomic_write_bytes(
    path: Path,
    content: bytes,
    *,
    create_only: bool = False,
    expected_sha256: str | None = None,
) -> None:
    """Publish flushed bytes, optionally requiring absence or an exact version."""

    if create_only and expected_sha256 is not None:
        raise ValueError("create_only and expected_sha256 are mutually exclusive")
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(fd, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        with document_lock(path):
            if create_only:
                # Hard-link publication is atomic and fails if *any* writer won.
                # Unlike exists()+replace(), it never overwrites a concurrent file.
                os.link(temporary, path)
            else:
                for attempt in range(5):
                    if expected_sha256 is not None:
                        try:
                            current = file_sha256(path)
                        except FileNotFoundError as exc:
                            raise FileWriteConflict(f"File disappeared: {path}") from exc
                        if current != expected_sha256:
                            raise FileWriteConflict(f"File changed: {path}")
                    try:
                        os.replace(temporary, path)
                        break
                    except PermissionError as exc:
                        if getattr(exc, "winerror", None) not in {5, 32, 33} or attempt == 4:
                            raise
                        # Windows 暂时占用文件时短暂等待；重试前重新核对版本。
                        time.sleep(0.025 * (attempt + 1))
    finally:
        temporary.unlink(missing_ok=True)

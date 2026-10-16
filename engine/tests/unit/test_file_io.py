from __future__ import annotations

import multiprocessing
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import pytest

import okf_workspace.okf.file_io as file_io
from okf_workspace.okf.file_io import (
    FileWriteConflict,
    atomic_write_bytes,
    document_lock,
    file_sha256,
)
from okf_workspace.okf.frontmatter import OkfDocument, write_document


def _no_delay(_seconds: float) -> None:
    pass


class _WindowsPermissionError(PermissionError):
    winerror: int

    def __init__(self, message: str, code: int) -> None:
        super().__init__(message)
        self.winerror = code


def _try_create(value: tuple[str, int]) -> int | None:
    path, number = value
    try:
        atomic_write_bytes(Path(path), str(number).encode(), create_only=True)
        return number
    except FileExistsError:
        return None


def _increment(value: str) -> None:
    path = Path(value)
    for _ in range(5):
        with document_lock(path):
            # atomic_write_bytes reenters the same transaction lock.
            current = int(path.read_text())
            atomic_write_bytes(path, str(current + 1).encode())


def test_cross_process_create_has_exactly_one_winner(tmp_path: Path) -> None:
    path = tmp_path / "winner.md"
    with ProcessPoolExecutor(4, mp_context=multiprocessing.get_context("spawn")) as pool:
        results = list(pool.map(_try_create, [(str(path), n) for n in range(12)]))
    winners = [n for n in results if n is not None]
    assert len(winners) == 1
    assert path.read_text() == str(winners[0])
    assert not list(tmp_path.glob("*.tmp"))


def test_cross_process_read_modify_write_and_reentrant_lock(tmp_path: Path) -> None:
    path = tmp_path / "counter"
    path.write_text("0")
    with ProcessPoolExecutor(4, mp_context=multiprocessing.get_context("spawn")) as pool:
        list(pool.map(_increment, [str(path)] * 4))
    assert path.read_text() == "20"


def test_stale_document_and_deleted_target_are_not_overwritten(tmp_path: Path) -> None:
    path = tmp_path / "note.md"
    document = OkfDocument({"type": "Wiki"}, "initial")
    write_document(path, document)
    expected = file_sha256(path)
    path.write_text("user edit", encoding="utf-8")
    with pytest.raises(FileWriteConflict):
        write_document(path, document, expected_sha256=expected)
    assert path.read_text() == "user edit"
    path.unlink()
    with pytest.raises(FileWriteConflict):
        write_document(path, document, expected_sha256=expected)
    assert not path.exists()


def test_windows_replace_retry_rechecks_external_edits(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "retry.md"
    path.write_bytes(b"original")
    before = file_sha256(path)

    def occupied(_source: Path, _target: Path) -> None:
        raise _WindowsPermissionError("Windows sharing violation", 32)

    def external_edit(_seconds: float) -> None:
        path.write_bytes(b"new user content")

    monkeypatch.setattr(file_io.os, "replace", occupied)
    monkeypatch.setattr(file_io.time, "sleep", external_edit)
    with pytest.raises(FileWriteConflict):
        atomic_write_bytes(path, b"stale result", expected_sha256=before)
    assert path.read_bytes() == b"new user content"
    assert not list(tmp_path.glob("*.tmp"))


def test_windows_replace_retry_is_bounded_and_eventually_publishes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "retry.md"
    path.write_bytes(b"original")
    replace = file_io.os.replace
    calls = 0

    def occupied_once(source: Path, target: Path) -> None:
        nonlocal calls
        calls += 1
        if calls < 3:
            raise _WindowsPermissionError("Windows access denied", 5)
        replace(source, target)

    monkeypatch.setattr(file_io.os, "replace", occupied_once)
    monkeypatch.setattr(file_io.time, "sleep", _no_delay)
    atomic_write_bytes(path, b"published")
    assert path.read_bytes() == b"published"
    assert calls == 3


def test_permanent_windows_denial_keeps_original_and_reports_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    path = tmp_path / "denied.md"
    path.write_bytes(b"original")
    calls = 0

    def denied(_source: Path, _target: Path) -> None:
        nonlocal calls
        calls += 1
        raise _WindowsPermissionError("permanent denial", 5)

    monkeypatch.setattr(file_io.os, "replace", denied)
    monkeypatch.setattr(file_io.time, "sleep", _no_delay)
    with pytest.raises(PermissionError, match="permanent"):
        atomic_write_bytes(path, b"must not publish")
    assert calls == 5
    assert path.read_bytes() == b"original"
    assert not list(tmp_path.glob("*.tmp"))

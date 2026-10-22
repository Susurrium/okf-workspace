# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

import multiprocessing
import os
import subprocess
import threading
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor
from importlib import import_module
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from okf_workspace.ai.policy import WritePolicyError
from okf_workspace.ai.writer import AIWriter
from okf_workspace.api import LocalTokenStore, create_app
from okf_workspace.config import BrainPaths
from okf_workspace.notes import NoteService
from okf_workspace.okf.file_io import FileWriteConflict
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document


def test_field_update_rejects_an_editor_change_before_publication(
    vault: Path, tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    target = NoteService(vault).create_reflection("并发状态", "原始正文")
    paths = BrainPaths(vault, tmp_path / "originals", tmp_path / "state")
    client = TestClient(create_app(paths))
    marker = "\n用户在提交前新增的正文。\n"

    def edit_before_publish(
        path: Path, document: OkfDocument, *, create_only: bool = False,
        expected_sha256: str | None = None,
    ) -> None:
        # 外部编辑器不参与 Engine 文件锁；实际发布仍由原写入器执行。
        path.write_bytes(path.read_bytes() + marker.encode())
        write_document(path, document, create_only=create_only, expected_sha256=expected_sha256)

    monkeypatch.setattr(
        import_module("okf_workspace.api.app"), "write_document", edit_before_publish,
    )
    response = client.post(
        f"/notes/{target.relative_to(vault).as_posix()}/fields",
        headers={"Authorization": f"Bearer {LocalTokenStore(paths.state).ensure()}"},
        json={"status": "draft"},
    )
    assert response.status_code == 409
    assert read_document(target).body.endswith(marker)
    assert "status" not in read_document(target).frontmatter


def test_concurrent_daily_appends_keep_every_entry(vault: Path) -> None:
    service = NoteService(vault)
    target = service.create_daily()
    gate = threading.Barrier(8)

    def append(index: int) -> None:
        gate.wait(timeout=10)
        NoteService(vault).append_daily_capture(f"独立记录-{index}-结束")

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(append, range(8)))
    body = read_document(target).body
    assert all(body.count(f"独立记录-{index}-结束") == 1 for index in range(8))


def test_daily_append_keeps_an_external_editor_change(
    vault: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    service = NoteService(vault)
    target = service.create_daily()
    marker = "\n编辑器写入的原始内容。\n"

    def edit_before_publish(
        path: Path, document: OkfDocument, *, create_only: bool = False,
        expected_sha256: str | None = None,
    ) -> None:
        path.write_bytes(path.read_bytes() + marker.encode())
        write_document(path, document, create_only=create_only, expected_sha256=expected_sha256)

    monkeypatch.setattr(
        import_module("okf_workspace.notes.create"), "write_document", edit_before_publish,
    )
    with pytest.raises(FileWriteConflict):
        service.append_daily_capture("未提交的追加内容")
    assert read_document(target).body.endswith(marker)
    assert "未提交的追加内容" not in read_document(target).body


@pytest.mark.parametrize("fields", [
    {"type": "Capture"}, {"type": "Wiki", "dashboard": True},
    {"type": "Study Guide", "dashboard": "true"},
])
def test_study_fields_reject_changed_document_identity(
    vault: Path, tmp_path: Path, fields: dict[str, object],
) -> None:
    target = vault / "learning/guides/identity.md"
    write_document(target, OkfDocument({**fields, "title": "身份保护"}, "# 原文\n"))
    before = target.read_bytes()
    paths = BrainPaths(vault, tmp_path / "originals", tmp_path / "state")
    client = TestClient(create_app(paths))
    response = client.post(
        "/notes/learning/guides/identity.md/fields",
        headers={"Authorization": f"Bearer {LocalTokenStore(paths.state).ensure()}"},
        json={"studied": True},
    )
    assert response.status_code == 400
    assert target.read_bytes() == before


def _append_daily_in_process(arguments: tuple[str, int]) -> None:
    vault, owner = arguments
    for index in range(3):
        NoteService(Path(vault)).append_daily_capture(f"进程-{owner}-记录-{index}-结束")


def test_daily_creation_and_append_are_safe_across_processes(vault: Path) -> None:
    with ProcessPoolExecutor(4, mp_context=multiprocessing.get_context("spawn")) as pool:
        list(pool.map(_append_daily_in_process, [(str(vault), owner) for owner in range(4)]))
    body = read_document(NoteService(vault).create_daily()).body
    assert all(body.count(f"进程-{owner}-记录-{index}-结束") == 1
               for owner in range(4) for index in range(3))


@pytest.mark.parametrize("relative", ["sources/text/protected.md", "self/audit.md"])
def test_ai_writer_rejects_case_aliases_before_changing_bytes(vault: Path, relative: str) -> None:
    target = vault / relative
    write_document(target, OkfDocument({"type": "Source Text", "title": "保护内容"},
                                     "# 保护内容\n\n## 正文\n\n原文。\n"))
    before = target.read_bytes()
    with pytest.raises(WritePolicyError):
        AIWriter(vault).replace_section(relative.upper(), "## 正文", "替换内容。")
    assert target.read_bytes() == before


def test_ai_writer_checks_resolved_in_vault_alias(vault: Path) -> None:
    target = vault / "sources/text/protected.md"
    write_document(target, OkfDocument({"type": "Source Text", "title": "保护内容"},
                                     "# 保护内容\n\n## 正文\n\n原文。\n"))
    alias = vault / "knowledge/alias/protected.md"
    alias.parent.mkdir(parents=True, exist_ok=True)
    alias.parent.rmdir()
    if os.name == "nt":
        subprocess.run(
            ["pwsh", "-NoProfile", "-NonInteractive", "-Command",
             "New-Item -ItemType Junction -Path $env:OKF_TEST_ALIAS "
             "-Target $env:OKF_TEST_TARGET -ErrorAction Stop | Out-Null"],
            env={**os.environ, "OKF_TEST_ALIAS": str(alias.parent),
                 "OKF_TEST_TARGET": str(target.parent)},
            check=True, capture_output=True, timeout=20,
            creationflags=subprocess.CREATE_NO_WINDOW,
        )
    else:
        alias.parent.symlink_to(target.parent, target_is_directory=True)
    before = target.read_bytes()
    with pytest.raises(WritePolicyError):
        AIWriter(vault).replace_section("knowledge/alias/protected.md", "## 正文", "替换内容。")
    assert target.read_bytes() == before

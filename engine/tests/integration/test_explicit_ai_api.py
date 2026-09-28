# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false
# pyright: reportUnknownArgumentType=false

from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from okf_workspace.api import LocalTokenStore, create_app
from okf_workspace.config import BrainPaths
from okf_workspace.notes import NoteService


class StubProvider:
    def __init__(self, content: str, on_complete: Callable[[], None] | None = None) -> None:
        self.content = content
        self.on_complete = on_complete

    def complete(self, *, system: str, user: str) -> str:
        if self.on_complete is not None:
            self.on_complete()
        return self.content


def _client(vault: Path, tmp_path: Path) -> tuple[TestClient, dict[str, str]]:
    paths = BrainPaths(vault=vault, originals=tmp_path / "originals", state=tmp_path / "state")
    token = LocalTokenStore(paths.state).ensure()
    return TestClient(create_app(paths)), {"Authorization": f"Bearer {token}"}


def test_explicit_ai_api_reports_collision_input_output_and_stale_write(
    vault: Path,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    notes = NoteService(vault)
    source = notes.create_wiki("来源", "来源内容。")
    notes.create_wiki("已有目标", "不要覆盖。")
    large = notes.create_wiki("超长来源", "A" * 200_001)
    notes.create_course("course", "课程")
    lesson = notes.create_lesson("course", "第一课", human_notes="原始记录。")
    client, headers = _client(vault, tmp_path)
    monkeypatch.setattr(
        "okf_workspace.api.app.provider_from_env", lambda: StubProvider("安全内容。")
    )

    collision = client.post(
        "/ai/knowledge/create",
        headers=headers,
        json={"title": "已有目标", "paths": [source.relative_to(vault).as_posix()]},
    )
    assert collision.status_code == 409

    too_large = client.post(
        "/ai/self-test",
        headers=headers,
        json={"path": large.relative_to(vault).as_posix()},
    )
    assert too_large.status_code == 413

    monkeypatch.setattr(
        "okf_workspace.api.app.provider_from_env", lambda: StubProvider("# 错误标题")
    )
    invalid = client.post(
        "/ai/lessons/organize",
        headers=headers,
        json={"path": lesson.relative_to(vault).as_posix()},
    )
    assert invalid.status_code == 502

    def edit_lesson() -> None:
        lesson.write_text(lesson.read_text(encoding="utf-8") + "\n用户新编辑。", encoding="utf-8")

    monkeypatch.setattr(
        "okf_workspace.api.app.provider_from_env", lambda: StubProvider("整理内容。", edit_lesson)
    )
    stale = client.post(
        "/ai/lessons/organize",
        headers=headers,
        json={"path": lesson.relative_to(vault).as_posix()},
    )
    assert stale.status_code == 409
    assert "用户新编辑" in lesson.read_text(encoding="utf-8")
    assert "整理内容" not in lesson.read_text(encoding="utf-8")

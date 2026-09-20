from __future__ import annotations

from datetime import datetime, timedelta
from pathlib import Path

from okf_workspace.dashboard.views import _recent_project_log  # pyright: ignore[reportPrivateUsage]
from okf_workspace.notes.captures import process_capture
from okf_workspace.notes.create import NoteService
from okf_workspace.notes.project_logs import render_project_log_append


def test_project_log_direct_and_capture_entries_append_in_one_order(vault: Path) -> None:
    now = datetime.now().astimezone()
    service = NoteService(vault, clock=lambda: now)
    service.create_project("chronological", "正序项目")
    path = service.append_project_log("chronological", "第一条直接进展")
    capture = service.create_capture("第二条想法", "想法正文", project="chronological")
    process_capture(vault, capture.relative_to(vault).as_posix(), destination="project-log")
    service.append_project_log("chronological", "第三条直接进展")
    text = path.read_text(encoding="utf-8")
    assert text.index("第一条直接进展") < text.index("第二条想法") < text.index("第三条直接进展")
    assert "第三条直接进展" in _recent_project_log(path)
    assert "第一条直接进展" not in _recent_project_log(path)
    tomorrow = NoteService(vault, clock=lambda: now + timedelta(days=1))
    tomorrow.append_project_log("chronological", "下一天进展")
    assert "下一天进展" in _recent_project_log(path)


def test_project_log_preserves_descending_history_and_appends_at_end() -> None:
    existing = (
        "# Log\r\n\r\n## 2026-09-08\r\n\r\n- 原来的最新进展\r\n\r\n"
        "## 2026-09-07\r\n\r\n- 更早记录\r\n"
    )
    updated = render_project_log_append(existing, "## 2026-09-08", "新的进展")
    assert updated.startswith(existing.rstrip())
    assert updated.endswith("## 2026-09-08\n\n- 新的进展\n")

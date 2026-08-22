"""Seven high-frequency Dashboard page projections."""

from __future__ import annotations

import re
from dataclasses import asdict
from datetime import date
from pathlib import Path

from okf_workspace.feeds import FeedCache, FeedEdition, FeedKind
from okf_workspace.ingestion import INGESTED_VIA_VALUES, normalize_ingested_via
from okf_workspace.okf.frontmatter import FrontmatterError, read_document
from okf_workspace.projections.tasks import collect_tasks

from .catalog import NoteSummary, scan_notes

_MARKDOWN_DECORATION = re.compile(r"[#>*_`\[\]()-]+")


def _summary(note: NoteSummary) -> dict[str, object]:
    return asdict(note)


def _ingestion_channel(note: NoteSummary) -> str:
    return normalize_ingested_via(note.ingested_via) or "unlabeled"


def _ingestion_counts(notes: list[NoteSummary]) -> dict[str, int]:
    counts = {channel: 0 for channel in sorted(INGESTED_VIA_VALUES)}
    counts["unlabeled"] = 0
    for note in notes:
        counts[_ingestion_channel(note)] += 1
    return counts


def _plain(value: str, *, limit: int = 300) -> str:
    visible = " ".join(
        line.strip()
        for line in value.splitlines()
        if line.strip() and not line.strip().startswith("<!--")
    )
    return _MARKDOWN_DECORATION.sub(" ", visible).strip()[:limit]


def _section(body: str, title: str) -> str:
    lines = body.splitlines()
    start = -1
    level = 0
    for index, line in enumerate(lines):
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if match and match.group(2).strip() == title:
            start = index + 1
            level = len(match.group(1))
            break
    if start < 0:
        return ""
    end = len(lines)
    for index in range(start, len(lines)):
        match = re.match(r"^(#{1,6})\s+", lines[index])
        if match and len(match.group(1)) <= level:
            end = index
            break
    return _plain("\n".join(lines[start:end]))


def _recent_project_log(path: Path) -> str:
    if not path.is_file():
        return ""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return ""
    headings = list(re.finditer(r"(?m)^##\s+.+$", text))
    if headings:
        text = text[headings[0].start() : headings[1].start() if len(headings) > 1 else None]
    return _plain(text, limit=500)


def _project_summary(vault: Path, note: NoteSummary) -> dict[str, object]:
    result = _summary(note)
    project_file = vault / note.path
    try:
        body = read_document(project_file).body
    except (FrontmatterError, OSError):
        body = ""
    project_root = project_file.parent
    result.update(
        {
            "current_state": _section(body, "当前状态"),
            "next_action": _section(body, "下一步"),
            "recent_log": _recent_project_log(project_root / "log.md"),
            "log_path": (project_root / "log.md").relative_to(vault).as_posix(),
            "decisions": [
                path.relative_to(vault).as_posix()
                for path in sorted((project_root / "decisions").rglob("*.md"))
                if path.name != "index.md"
            ],
            "outputs": [
                path.relative_to(vault).as_posix()
                for path in sorted((project_root / "outputs").rglob("*"))
                if path.is_file() and path.name != "index.md"
            ],
        }
    )
    return result


def _feed_summary(latest: FeedEdition) -> dict[str, object]:
    return {
        "digest_id": latest.edition_id,
        "issued_at": latest.edition_at,
        "title": latest.title,
        "section": latest.stream,
        "item_count": len(latest.items),
    }


def _latest_feed(cache: FeedCache, feed: FeedKind) -> dict[str, object] | None:
    editions = cache.list_editions(feed)
    return _feed_summary(editions[0]) if editions else None


def _latest_ai_daily_streams(cache: FeedCache) -> list[dict[str, object]]:
    editions = cache.list_editions(FeedKind.AI_DAILY)
    if not editions:
        return []
    latest_date = editions[0].edition_at
    stream_order = {"hotspot": 0, "news": 1, "learning": 2}
    latest = [edition for edition in editions if edition.edition_at == latest_date]
    latest.sort(key=lambda edition: stream_order.get(edition.stream or "", 99))
    return [_feed_summary(edition) for edition in latest]


def today_view(vault: Path, state: Path, target_date: date | None = None) -> dict[str, object]:
    root = vault.resolve()
    value = target_date or date.today()
    notes = scan_notes(root, today=value)
    cache = FeedCache(state)
    daily = f"life/daily/{value:%Y}/{value:%m}/{value}.md"
    open_captures = [
        note
        for note in notes
        if note.note_type == "Capture"
        and note.path.startswith("inbox/captures/")
        and note.capture_status == "open"
    ]
    undecided_sources = [
        note for note in notes if note.note_type == "Source" and note.purpose == "undecided"
    ]
    waiting_decision = open_captures + undecided_sources
    active_projects = [note for note in notes if note.project_status == "active"]
    stale = [note for note in notes if note.stale]
    return {
        "date": str(value),
        "daily": {"path": daily, "exists": (root / daily).is_file()},
        "tasks": [asdict(item) for item in collect_tasks(root)],
        "active_projects": [_project_summary(root, note) for note in active_projects],
        "recent_study": [
            _summary(note)
            for note in notes
            if note.note_type == "Study Guide" and note.studied_at is None
        ][:8],
        "open_inbox_count": len(waiting_decision),
        "inbox_by_ingested_via": _ingestion_counts(waiting_decision),
        "latest_ai_daily": _latest_feed(cache, FeedKind.AI_DAILY),
        "latest_ai_daily_streams": _latest_ai_daily_streams(cache),
        "latest_treehole": _latest_feed(cache, FeedKind.TREEHOLE),
        "stale_knowledge": [_summary(note) for note in stale],
    }


def dashboard_view(vault: Path, area: str) -> dict[str, object]:
    notes = scan_notes(vault)
    if area == "inbox":
        captures = [
            note
            for note in notes
            if note.note_type == "Capture" and note.path.startswith("inbox/captures/")
        ]
        captures.sort(key=lambda item: item.modified_at, reverse=True)
        open_captures = [note for note in captures if note.capture_status == "open"]
        undecided_sources = [
            note
            for note in notes
            if note.note_type == "Source" and note.purpose == "undecided"
        ]
        generated = [
            note for note in notes if note.note_type in {"Study Guide", "Wiki"}
        ]
        linked_sources = {source for note in generated for source in note.source_paths}
        pending_generation = [
            note
            for note in notes
            if note.note_type == "Source"
            and note.purpose in {"study", "wiki"}
            and note.path not in linked_sources
        ]
        waiting_decision = open_captures + undecided_sources
        return {
            "captures": [_summary(note) for note in open_captures],
            "processed_captures": [
                _summary(note) for note in captures if note.capture_status == "processed"
            ],
            "pending_imports": [_summary(note) for note in undecided_sources],
            "pending_generation": [_summary(note) for note in pending_generation],
            "by_ingested_via": _ingestion_counts(waiting_decision + pending_generation),
            "stage_counts": {
                "waiting_decision": len(waiting_decision),
                "waiting_generation": len(pending_generation),
            },
        }
    if area == "learning":
        study_guides = [note for note in notes if note.note_type == "Study Guide"]
        linked_sources = {source for note in study_guides for source in note.source_paths}
        return {
            "pending_guides": [
                _summary(note)
                for note in study_guides
                if note.studied_at is None and not note.material_ready
            ]
            + [
                _summary(note)
                for note in notes
                if note.note_type == "Source"
                and note.purpose == "study"
                and note.path not in linked_sources
            ],
            "ready_guides": [
                _summary(note)
                for note in study_guides
                if note.studied_at is None and note.material_ready
            ],
            "completed_guides": [
                _summary(note) for note in study_guides if note.studied_at is not None
            ],
            "courses": [
                _summary(note)
                for note in notes
                if note.note_type == "Course" and note.course_status == "active"
            ],
            "guides": [
                _summary(note) for note in notes if note.path.startswith("learning/guides/")
            ],
            "lessons": [_summary(note) for note in notes if note.note_type == "Lesson"],
            "unstudied_wiki": [
                _summary(note)
                for note in notes
                if note.note_type == "Wiki"
                and note.studied_at is None
                and note.status != "deprecated"
            ],
        }
    if area == "projects":
        projects = [note for note in notes if note.note_type == "Project"]
        order = {"active": 0, "paused": 1, "completed": 2}
        projects.sort(key=lambda item: (order.get(item.project_status or "", 9), item.title))
        return {"projects": [_project_summary(vault, note) for note in projects]}
    if area == "knowledge":
        allowed = {"Wiki", "Wiki Map"}
        return {"notes": [_summary(note) for note in notes if note.note_type in allowed]}
    if area == "life":
        prefixes = ("life/daily/", "life/reflections/", "life/reviews/", "life/areas/")
        return {"notes": [_summary(note) for note in notes if note.path.startswith(prefixes)]}
    raise ValueError(f"unknown dashboard area: {area}")

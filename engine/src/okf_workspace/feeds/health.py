"""Durable stream health independent of cached, last-successful Feed editions."""

from __future__ import annotations

import json
from collections.abc import Mapping
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from okf_workspace.okf.file_io import atomic_write_bytes, document_lock

STREAMS = ("hotspot", "news", "learning", "papers")


def _status_path(state: Path) -> Path:
    return state / "feed-sync" / "ai-daily-stream-status.json"


def read_stream_status(state: Path) -> dict[str, object] | None:
    path = _status_path(state)
    try:
        if path.stat().st_size > 1024 * 1024:
            return None
        value = cast(object, json.loads(path.read_text(encoding="utf-8")))
    except (OSError, ValueError):
        return None
    if not isinstance(value, dict):
        return None
    payload = cast(dict[str, object], value)
    if payload.get("version") != 1 or not isinstance(payload.get("streams"), dict):
        return None
    return payload


def commit_stream_status(
    state: Path,
    streams: Mapping[str, object],
    *,
    phase: str = "producer",
    message: str | None = None,
) -> None:
    """Merge only the attempted streams, keeping all other lanes' health intact."""

    path = _status_path(state)
    now = datetime.now(UTC).isoformat()
    with document_lock(path):
        current = read_stream_status(state) or {}
        merged = dict(cast(Mapping[str, object], current.get("streams", {})))
        for name, raw in streams.items():
            if name not in STREAMS or not isinstance(raw, Mapping):
                continue
            value = dict(cast(Mapping[str, object], raw))
            previous = merged.get(name)
            old: Mapping[str, object] = (
                cast(Mapping[str, object], previous) if isinstance(previous, Mapping) else {}
            )
            status = value.get("status", "unknown")
            failing = status in {"error", "degraded"}
            errors: list[str] = []
            sources = value.get("sources")
            if isinstance(sources, list):
                for source in cast(list[object], sources):
                    if isinstance(source, Mapping):
                        error = cast(Mapping[str, object], source).get("last_error")
                        if isinstance(error, str) and error:
                            errors.append(error)
            value.update(
                last_attempt_at=now,
                last_success_at=now if status == "ok" else old.get("last_success_at"),
                last_error_at=now if failing else old.get("last_error_at"),
                message=(message or "；".join(errors)[:300] or "远端内容更新暂时失败。")
                if failing
                else None,
                phase=phase,
            )
            merged[name] = value
        payload = {"version": 1, "updated_at": now, "streams": merged}
        atomic_write_bytes(
            path,
            (json.dumps(payload, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
        )


def stream_health(state: Path) -> dict[str, object]:
    payload = read_stream_status(state)
    if payload is None:
        return {}
    statuses = cast(Mapping[str, object], payload["streams"])
    result: dict[str, object] = {}
    fields = ("status", "last_success_at", "last_error_at", "last_attempt_at", "message", "phase")
    for name in STREAMS:
        raw = statuses.get(name)
        if not isinstance(raw, Mapping):
            continue
        value = cast(Mapping[str, object], raw)
        result[name] = {field: value.get(field) for field in fields}
    return result

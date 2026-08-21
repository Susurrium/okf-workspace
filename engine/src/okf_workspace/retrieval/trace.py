"""Persist compact retrieval traces outside the Vault."""

from __future__ import annotations

import json
from dataclasses import asdict
from datetime import UTC, datetime
from pathlib import Path

from .models import ContextItem, SearchHit


def write_trace(
    directory: Path,
    *,
    query: str,
    hits: list[SearchHit],
    contexts: list[ContextItem],
) -> Path:
    directory.mkdir(parents=True, exist_ok=True)
    moment = datetime.now(UTC)
    target = directory / f"{moment:%Y%m%dT%H%M%S%fZ}.json"
    payload = {
        "query": query,
        "created_at": moment.isoformat(),
        "candidates": [asdict(hit) for hit in hits],
        "actual_reads": [asdict(item) for item in contexts],
    }
    target.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2, default=str) + "\n",
        encoding="utf-8",
        newline="\n",
    )
    return target

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from threading import Barrier

import pytest

from okf_workspace.importers.models import (
    ConversionStatus,
    ImportIntent,
    ImportRequest,
    OriginalRecord,
    ParserName,
)
from okf_workspace.importers.state import ConversionStore


def test_concurrent_conversion_updates_preserve_both_output_fields(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "input.pdf"
    source.write_bytes(b"%PDF")
    store = ConversionStore(tmp_path)
    store.update(
        "conv-test",
        status=ConversionStatus.QUEUED,
        request=ImportRequest(source=source, intent=ImportIntent.SOURCE),
        original=OriginalRecord("digest", "input.pdf", ".pdf", 4, source, "resource"),
        parser=ParserName.MARKITDOWN,
    )
    original_load = store.load

    def slow_load(conversion_id: str) -> dict[str, object]:
        record = original_load(conversion_id)
        time.sleep(0.02)
        return record

    monkeypatch.setattr(store, "load", slow_load)
    ready = Barrier(2)

    def transition(key: str) -> None:
        ready.wait(timeout=5)
        store.transition("conv-test", ConversionStatus.QUEUED, outputs={key: key})

    with ThreadPoolExecutor(max_workers=2) as pool:
        list(pool.map(transition, ("source", "semantic_operation_id")))

    outputs = original_load("conv-test")["outputs"]
    assert outputs == {"source": "source", "semantic_operation_id": "semantic_operation_id"}

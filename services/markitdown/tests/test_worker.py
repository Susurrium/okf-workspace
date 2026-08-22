from __future__ import annotations

import hashlib
import zipfile
from dataclasses import replace

from pypdf import PdfWriter

from markitdown_service.config import Settings
from markitdown_service.worker import Worker


def test_worker_runs_real_markitdown_child_and_commits_only_verified_result(
    settings: Settings,
) -> None:
    worker_settings = replace(
        settings,
        max_result_bytes=1024 * 1024,
        conversion_timeout_seconds=60,
    )
    worker = Worker(worker_settings)
    worker.initialize()

    task_id = "a" * 32
    input_path = worker_settings.incoming_dir / f"{task_id}.pdf"
    writer = PdfWriter()
    writer.add_blank_page(width=72, height=72)
    with input_path.open("wb") as handle:
        writer.write(handle)
    source_hash = hashlib.sha256(input_path.read_bytes()).hexdigest()
    worker.store.create(
        task_id=task_id,
        idempotency_key="worker-integration-key-0001",
        source_sha256=source_hash,
        filename="blank.pdf",
        profile="fallback-text-v1",
        size_bytes=input_path.stat().st_size,
    )
    claimed = worker.store.claim_next()
    assert claimed is not None

    worker._process(claimed)

    completed = worker.store.get(task_id)
    assert completed is not None
    assert completed.status == "completed"
    assert completed.page_count == 1
    assert completed.warnings == (
        "pdf_text_only_images_not_extracted",
        "empty_markdown",
    )
    assert not input_path.exists()
    result_path = worker_settings.results_dir / f"{task_id}.zip"
    with zipfile.ZipFile(result_path) as archive:
        assert set(archive.namelist()) == {"manifest.json", "document.md"}

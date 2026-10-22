from __future__ import annotations

import cProfile
import hashlib
import pstats
import threading
import zipfile
from dataclasses import replace

from pypdf import PdfWriter

from markitdown_service.config import Settings
from markitdown_service.worker import Worker


def test_idle_polling_does_not_repeat_cleanup_or_spool_scans(settings: Settings) -> None:
    class StopAfterPolls(threading.Event):
        polls = 0

        def wait(self, timeout: float | None = None) -> bool:
            self.polls += 1
            if self.polls >= 10:
                self.set()
            return self.is_set()

    worker = Worker(settings, stop_event=StopAfterPolls())
    profiler = cProfile.Profile()
    profiler.runcall(worker.run_forever)
    functions = pstats.Stats(profiler).get_stats_profile().func_profiles
    assert functions["_cleanup"].ncalls == "1"
    assert "storage_status" not in functions


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

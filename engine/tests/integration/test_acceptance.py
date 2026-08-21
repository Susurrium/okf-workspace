from __future__ import annotations

from pathlib import Path

from okf_workspace.acceptance import run_one_session_uat, run_performance_benchmark


def test_quick_performance_benchmark_covers_scale_and_incremental_paths() -> None:
    report = run_performance_benchmark(full=False)

    assert report.wiki_count == 200
    assert report.chunk_count == 1_000
    assert report.vector_dimensions == 32
    assert report.long_document_covered_line >= report.long_document_last_line
    assert report.long_document_fences_balanced is True
    assert report.passed, report.thresholds


def test_one_session_uat_executes_daily_capture_ai_import_feed_and_restore() -> None:
    root = Path(__file__).parents[2]
    report = run_one_session_uat(root)

    assert report.passed, report.steps

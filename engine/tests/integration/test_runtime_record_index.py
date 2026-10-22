from __future__ import annotations

import cProfile
import json
import pstats
import subprocess
import sys
from pathlib import Path

import pytest

from okf_workspace.importers.models import (
    ConversionStatus,
    ImportIntent,
    ImportRequest,
    OriginalRecord,
    ParserName,
)
from okf_workspace.importers.state import ConversionStore
from okf_workspace.semantic.models import SemanticKind, SemanticRequest
from okf_workspace.semantic.store import SemanticOperationStore


def semantic_store(tmp_path: Path) -> SemanticOperationStore:
    store = SemanticOperationStore(tmp_path / "state")
    for number in range(20):
        identifier = f"op-{number}"
        store.create(
            SemanticRequest(identifier, SemanticKind.GENERATE_WIKI, "target.md"),
            fingerprint=str(number),
            source_hashes={},
        )
        store.complete(identifier, actual_reads=())
    return store


def test_idle_claim_does_not_reopen_completed_history(tmp_path: Path) -> None:
    store = semantic_store(tmp_path)
    assert store.claim_next("worker") is None
    profiler = cProfile.Profile()
    assert profiler.runcall(store.claim_next, "worker") is None
    assert "read_text" not in pstats.Stats(profiler).get_stats_profile().func_profiles


def test_real_processes_share_catalog_and_claim_one_request_once(tmp_path: Path) -> None:
    store = semantic_store(tmp_path)
    store.create(
        SemanticRequest("op-shared", SemanticKind.GENERATE_WIKI, "target.md"),
        fingerprint="shared",
        source_hashes={},
    )
    worker = Path(__file__).parents[1] / "fixtures" / "runtime-record-worker.py"
    processes = [
        subprocess.Popen(
            [sys.executable, str(worker), str(tmp_path / "state"), f"worker-{number}"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        for number in range(2)
    ]
    results: list[object] = []
    for process in processes:
        stdout, stderr = process.communicate(timeout=20)
        assert process.returncode == 0, stderr
        results.append(json.loads(stdout))
    assert results.count("op-shared") == 1
    assert results.count(None) == 1
    assert store.claim_next("parent") is None


def test_catalog_observes_other_store_writes_and_claims_only_once(tmp_path: Path) -> None:
    store = semantic_store(tmp_path)
    assert store.claim_next("worker") is None
    other = SemanticOperationStore(tmp_path / "state")
    other.create(
        SemanticRequest("op-new", SemanticKind.GENERATE_WIKI, "target.md"),
        fingerprint="new",
        source_hashes={},
    )
    claimed = store.claim_next("worker")
    assert claimed is not None and claimed.operation_id == "op-new"
    assert other.claim_next("another-worker") is None


def test_interrupted_catalog_update_is_rebuilt_from_durable_json(tmp_path: Path) -> None:
    store = semantic_store(tmp_path)
    payload = store.load("op-0")
    payload["status"] = "queued"
    path = store.path("op-0")
    with pytest.raises(OSError, match="interrupted"), store.catalog.writing(path, payload):
        path.write_text(json.dumps(payload), encoding="utf-8")
        raise OSError("interrupted")
    recovered = SemanticOperationStore(tmp_path / "state").claim_next("worker")
    assert recovered is not None and recovered.operation_id == "op-0"


def test_conversion_candidates_exclude_finished_history_but_include_pending_handoff(
    tmp_path: Path,
) -> None:
    store = ConversionStore(tmp_path / "state")
    original = OriginalRecord(
        "0" * 64,
        "source.pdf",
        ".pdf",
        100,
        tmp_path / "source.pdf",
        "/sources/originals/source.pdf",
    )
    for number in range(20):
        identifier = f"conversion-{number}"
        store.update(
            identifier,
            status=ConversionStatus.IMPORTED,
            request=ImportRequest(original.stored_path, ImportIntent.SOURCE),
            original=original,
            parser=ParserName.MARKITDOWN,
        )
    assert store.work_candidates() == []
    store.update(
        "handoff",
        status=ConversionStatus.IMPORTED,
        request=ImportRequest(original.stored_path, ImportIntent.WIKI, generate=True),
        original=original,
        parser=ParserName.MARKITDOWN,
    )
    assert [record["conversion_id"] for record in store.work_candidates()] == ["handoff"]


def test_pages_reject_changed_snapshots_and_delta_preserves_terminal_transitions(
    tmp_path: Path,
) -> None:
    store = semantic_store(tmp_path)
    first = store.catalog.page(limit=5)
    version = int(first["version"])
    assert len(first["items"]) == 5
    store.retry("op-0")
    store.complete("op-0", actual_reads=())
    with pytest.raises(ValueError, match="snapshot"):
        store.catalog.page(limit=5, offset=5, snapshot_version=version)
    delta = store.catalog.page(after_version=version, after_index_id=first["index_id"])
    assert len(delta["items"]) == 1
    assert delta["items"][0]["status"] == "completed"
    store.path("op-1").unlink()
    store.catalog.reconcile()
    assert (
        store.catalog.page(after_version=version, after_index_id=first["index_id"])[
            "requires_reset"
        ]
        is True
    )


def test_corrupt_derived_index_rebuilds_and_invalidates_equal_version_clients(
    tmp_path: Path,
) -> None:
    store = semantic_store(tmp_path)
    before = store.catalog.page()
    original = store.path("op-0").read_bytes()
    store.catalog.database.write_bytes(b"invalid sqlite header")
    recovered = store.catalog.page(after_version=20, after_index_id=before["index_id"])
    assert recovered["requires_reset"] is True
    assert recovered["index_id"] != before["index_id"]
    assert len(recovered["items"]) == 20
    assert store.path("op-0").read_bytes() == original
    unchanged = store.catalog.page(
        after_version=recovered["version"], after_index_id=recovered["index_id"]
    )
    assert unchanged["requires_reset"] is False
    assert unchanged["items"] == []


def test_filtered_deltas_replace_status_membership_and_identity_rejects_before_write(
    tmp_path: Path,
) -> None:
    store = semantic_store(tmp_path)
    store.retry("op-0")
    initial = store.catalog.page(status="queued")
    store.cancel("op-0")
    current = store.catalog.page(
        status="queued", after_version=initial["version"], after_index_id=initial["index_id"]
    )
    assert current["requires_reset"] is True and current["items"] == []
    path = store.path("op-0")
    original = path.read_bytes()
    payload = store.load("op-0")
    payload["operation_id"] = "op-different"
    with pytest.raises(ValueError, match="身份与路径"), store.catalog.writing(path, payload):
        raise AssertionError("invalid identity reached the JSON writer")
    assert path.read_bytes() == original

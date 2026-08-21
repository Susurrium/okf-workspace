from __future__ import annotations

import time
from pathlib import Path

from markitdown_service.storage import JobStore


def create_job(store: JobStore, task_id: str, key: str) -> None:
    result = store.create(
        task_id=task_id,
        idempotency_key=key,
        source_sha256="a" * 64,
        filename="paper.pdf",
        profile="fallback-text-v1",
        size_bytes=100,
    )
    assert result.created


def test_claim_order_and_idempotency(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.sqlite")
    store.initialize()
    create_job(store, "a" * 32, "idempotency-key-0001")
    create_job(store, "b" * 32, "idempotency-key-0002")

    first = store.claim_next()
    second = store.claim_next()
    assert first is not None and first.task_id == "a" * 32
    assert second is not None and second.task_id == "b" * 32
    assert store.claim_next() is None

    duplicate = store.create(
        task_id="c" * 32,
        idempotency_key="idempotency-key-0001",
        source_sha256="a" * 64,
        filename="ignored.pdf",
        profile="fallback-text-v1",
        size_bytes=100,
    )
    assert duplicate.created is False
    assert duplicate.conflict is False
    assert duplicate.job.task_id == "a" * 32


def test_recover_interrupted_retries_once_then_fails(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.sqlite")
    store.initialize()
    create_job(store, "a" * 32, "idempotency-key-0001")
    assert store.claim_next() is not None

    store.recover_interrupted(max_attempts=2, failure_ttl_seconds=60)
    recovered = store.get("a" * 32)
    assert recovered is not None and recovered.status == "pending"
    assert store.claim_next() is not None

    store.recover_interrupted(max_attempts=2, failure_ttl_seconds=60)
    failed = store.get("a" * 32)
    assert failed is not None
    assert failed.status == "failed"
    assert failed.error_code == "worker_interrupted"


def test_expiry_and_tombstone_purge(tmp_path: Path) -> None:
    store = JobStore(tmp_path / "jobs.sqlite")
    store.initialize()
    create_job(store, "a" * 32, "idempotency-key-0001")
    store.cancel("a" * 32, ttl_seconds=1)

    expired = store.expire_due(now=time.time() + 2)
    assert expired == ["a" * 32]
    assert store.get("a" * 32).status == "expired"  # type: ignore[union-attr]
    assert store.purge_tombstones(older_than=time.time() + 3) == 1
    assert store.get("a" * 32) is None

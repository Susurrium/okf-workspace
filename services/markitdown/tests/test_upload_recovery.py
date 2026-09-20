from __future__ import annotations

import asyncio
import hashlib
import os
import time
from dataclasses import replace

import httpx
import pytest

from markitdown_service.api import create_app
from markitdown_service.config import Settings
from markitdown_service.storage import JobStore
from markitdown_service.worker import Worker


def test_cleanup_removes_only_expired_owned_temporary_files(settings: Settings) -> None:
    worker = Worker(settings)
    worker.initialize()
    old = time.time() - settings.orphan_ttl_seconds - 10
    stale_upload = settings.incoming_dir / f".{('a' * 32)}.upload"
    stale_result = settings.results_dir / f".{('b' * 32)}.zip.random.tmp"
    active_upload = settings.incoming_dir / f".{('c' * 32)}.upload"
    active_result = settings.results_dir / f".{('d' * 32)}.zip.random.tmp"
    unexpected = settings.incoming_dir / ".operator-note"
    fresh = settings.incoming_dir / f".{('e' * 32)}.upload"
    for path in (stale_upload, stale_result, active_upload, active_result, unexpected):
        path.write_bytes(b"test")
        os.utime(path, (old, old))
    fresh.write_bytes(b"still fresh")
    worker.store.hold_upload("c" * 32, expires_at=time.time() + 120)
    worker.store.create(
        task_id="d" * 32,
        idempotency_key="active-conversion-test",
        source_sha256="a" * 64,
        filename="document.pdf",
        profile="fallback-text-v1",
        size_bytes=4,
    )
    worker._cleanup()
    assert not stale_upload.exists()
    assert not stale_result.exists()
    assert active_upload.exists()
    assert active_result.exists()
    assert fresh.exists()
    assert unexpected.exists()
    worker.store.release_upload("c" * 32)
    worker._cleanup()
    assert not active_upload.exists()


def test_expired_upload_lease_is_recovered_after_process_crash(settings: Settings) -> None:
    worker = Worker(settings)
    worker.initialize()
    task_id = "f" * 32
    orphan = settings.incoming_dir / f".{task_id}.upload"
    orphan.write_bytes(b"interrupted body")
    old = time.time() - 2 * settings.orphan_ttl_seconds
    os.utime(orphan, (old, old))
    worker.store.hold_upload(task_id, expires_at=old)
    worker._cleanup()
    assert not orphan.exists()
    assert task_id not in worker.store.protected_task_ids(now=time.time())


@pytest.mark.parametrize("kind", ["idle", "total"])
def test_upload_timeout_releases_capacity_and_durable_lease(
    settings: Settings,
    token: str,
    kind: str,
) -> None:
    configured = replace(
        settings,
        upload_timeout_seconds=0.06 if kind == "total" else 1,
        upload_idle_timeout_seconds=0.02 if kind == "idle" else 1,
    )
    app = create_app(configured)
    pdf = b"%PDF-1.4\nbody\n%%EOF\n"
    headers = {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/pdf",
        "Idempotency-Key": "timeout-recovery-test",
        "X-Source-SHA256": hashlib.sha256(pdf).hexdigest(),
    }

    async def scenario() -> None:
        async with (
            app.router.lifespan_context(app),
            httpx.AsyncClient(
                transport=httpx.ASGITransport(app=app), base_url="http://test"
            ) as client,
        ):

            async def body():
                yield b"%PDF-"
                if kind == "idle":
                    await asyncio.sleep(1)
                else:
                    for _ in range(30):
                        await asyncio.sleep(0.01)
                        yield b"x"

            response = await client.post("/v1/tasks", headers=headers, content=body())
            assert response.status_code == 408
            assert kind in response.json()["detail"]
            assert not any(configured.incoming_dir.iterdir())
            store = JobStore(configured.database_path)
            assert not store.protected_task_ids(now=time.time())
            retry = await client.post("/v1/tasks", headers=headers, content=pdf)
            assert retry.status_code == 202
            assert retry.json()["status"] == "pending"

    asyncio.run(scenario())

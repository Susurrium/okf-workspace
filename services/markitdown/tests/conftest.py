from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from markitdown_service.api import create_app
from markitdown_service.config import Settings


@pytest.fixture
def token() -> str:
    return "test-token-" + "x" * 48


@pytest.fixture
def settings(tmp_path: Path, token: str) -> Settings:
    return Settings(
        state_dir=tmp_path / "state",
        spool_dir=tmp_path / "spool",
        api_tokens=(token,),
        max_upload_bytes=1024,
        max_result_bytes=4096,
        max_spool_bytes=1024 * 1024,
        min_free_bytes=1,
        max_pages=20,
        success_ttl_seconds=60,
        failure_ttl_seconds=60,
        tombstone_ttl_seconds=60,
        orphan_ttl_seconds=60,
        worker_stale_seconds=15,
        engine_version="0.1.6",
        engine_build_id="markitdown-0.1.6-py31213-v3",
    )


@pytest.fixture
def client(settings: Settings) -> Iterator[TestClient]:
    with TestClient(create_app(settings)) as test_client:
        yield test_client


@pytest.fixture
def authorization(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}

from __future__ import annotations

import hashlib
from pathlib import Path
from typing import cast

import httpx
import pytest
from fastapi.testclient import TestClient

from okf_originals_service.app import create_app

TOKEN = "test-credential-" + "a" * 32
HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def test_authenticated_verified_idempotent_storage(tmp_path: Path) -> None:
    client = cast(httpx.Client, TestClient(create_app(tmp_path, TOKEN, "fixture-store")))
    payload = b"%PDF-1.7 original"
    digest = hashlib.sha256(payload).hexdigest()
    path = f"/v1/blobs/{digest}"
    assert client.put(path, content=payload).status_code == 401
    assert client.get("/v1/status", headers=HEADERS).json()["store_id"] == "fixture-store"
    assert client.get(path, headers=HEADERS).status_code == 404
    assert client.put(path, content=b"bad", headers=HEADERS).status_code == 422
    assert not list(tmp_path.rglob(".upload-*"))
    for _ in range(2):
        assert client.put(path, content=payload, headers=HEADERS).json() == {
            "sha256": digest, "size_bytes": len(payload), "store_id": "fixture-store",
        }
    assert client.head(path, headers=HEADERS).headers["content-length"] == str(len(payload))
    assert client.get(path, headers=HEADERS).content == payload
    assert client.get(path).status_code == 401
    # Wrong subsequent uploads cannot replace the good version.
    assert client.put(path, content=b"damaged", headers=HEADERS).status_code == 422
    assert client.get(path, headers=HEADERS).content == payload
    assert len(list(tmp_path.glob("*/*"))) == 1
    assert client.delete(path, headers=HEADERS).status_code == 405


def test_limits_and_unsafe_paths(tmp_path: Path) -> None:
    client = cast(httpx.Client, TestClient(create_app(tmp_path, TOKEN, "fixture-store")))
    assert client.put("/v1/blobs/not-a-hash", content=b"x", headers=HEADERS).status_code == 400
    assert client.put("/v1/blobs/" + "a" * 64, content=b"x", headers={
        **HEADERS, "Content-Length": str(65 * 1024 * 1024),
    }).status_code == 413
    assert client.get("/v1/status", headers={"Authorization": "Bearer bad"}).status_code == 401


def test_chunked_oversize_upload_never_publishes_partial_bytes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("okf_originals_service.app.MAX_BYTES", 4)
    client = cast(httpx.Client, TestClient(create_app(tmp_path, TOKEN, "fixture-store")))
    digest = hashlib.sha256(b"abcdef").hexdigest()
    response = client.put(f"/v1/blobs/{digest}", content=iter([b"abc", b"def"]), headers=HEADERS)
    assert response.status_code == 413
    assert not (tmp_path / digest[:2] / digest).exists()
    assert not list(tmp_path.rglob(".upload-*"))

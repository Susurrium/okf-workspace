from __future__ import annotations

import hashlib
import io
import time
import zipfile
from dataclasses import replace

from fastapi.testclient import TestClient

from markitdown_service.api import create_app
from markitdown_service.config import Settings
from markitdown_service.conversion import write_result_bundle
from markitdown_service.storage import JobStore

PDF_BYTES = b"%PDF-1.4\nminimal-test-body\n%%EOF\n"
PPTX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
DOCX_MEDIA_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"


def pptx_bytes() -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("ppt/presentation.xml", "<p:presentation/>")
        archive.writestr("ppt/slides/slide1.xml", "<p:sld/>")
    return stream.getvalue()


def docx_bytes() -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w", zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("[Content_Types].xml", "<Types/>")
        archive.writestr("word/document.xml", "<w:document/>")
    return stream.getvalue()


def submission_headers(authorization: dict[str, str], body: bytes = PDF_BYTES) -> dict[str, str]:
    return {
        **authorization,
        "Content-Type": "application/pdf",
        "Idempotency-Key": "test-idempotency-key-0001",
        "X-Source-SHA256": hashlib.sha256(body).hexdigest(),
        "X-Filename": "%E8%AE%BA%E6%96%87.pdf",
        "X-MarkItDown-Profile": "fallback-text-v1",
    }


def test_livez_is_public_but_health_requires_auth(
    client: TestClient,
    authorization: dict[str, str],
    settings: Settings,
) -> None:
    assert client.get("/livez").json() == {"status": "alive"}
    unauthorized = client.get("/v1/health")
    assert unauthorized.status_code == 401
    assert unauthorized.headers["www-authenticate"] == "Bearer"

    store = JobStore(settings.database_path)
    store.set_worker_heartbeat()
    response = client.get("/v1/health", headers=authorization)
    assert response.status_code == 200
    payload = response.json()
    assert payload["healthy"] is True
    assert payload["engine_version"] == "0.1.6"
    assert payload["engine_build_id"] == "markitdown-0.1.6-py31213-assets-v3"
    assert payload["result_schema"] == "markitdown-result/v3"
    assert payload["default_profile"] == "fallback-assets-v2"
    assert payload["supported_profiles"] == ["fallback-assets-v2", "fallback-text-v1"]
    assert payload["capabilities"]["formats"]["pdf"]["assets"] is False
    assert payload["capabilities"]["formats"]["pptx"]["assets"] == "embedded"
    assert payload["capabilities"]["formats"]["docx"]["assets"] == "embedded"
    assert payload["capabilities"]["network_access"] is False
    assert payload["storage_healthy"] is True
    assert payload["spool_limit_bytes"] == settings.max_spool_bytes


def test_health_is_degraded_without_a_fresh_worker(
    client: TestClient, authorization: dict[str, str]
) -> None:
    response = client.get("/v1/health", headers=authorization)
    assert response.status_code == 503
    assert response.json()["status"] == "degraded"


def test_storage_reservation_degrades_health_and_rejects_upload(
    authorization: dict[str, str],
    settings: Settings,
) -> None:
    constrained = replace(settings, max_spool_bytes=8)
    with TestClient(create_app(constrained)) as client:
        store = JobStore(constrained.database_path)
        store.set_worker_heartbeat()
        health = client.get("/v1/health", headers=authorization)
        assert health.status_code == 503
        assert health.json()["storage_healthy"] is False

        response = client.post(
            "/v1/tasks",
            headers=submission_headers(authorization),
            content=PDF_BYTES,
        )
        assert response.status_code == 503
        assert response.headers["retry-after"] == "60"
        assert not any(constrained.incoming_dir.iterdir())


def test_raw_pdf_submission_is_streamed_and_idempotent(
    client: TestClient,
    authorization: dict[str, str],
    settings: Settings,
) -> None:
    headers = submission_headers(authorization)
    response = client.post("/v1/tasks", headers=headers, content=PDF_BYTES)
    assert response.status_code == 202
    payload = response.json()
    task_id = payload["task_id"]
    assert payload["status"] == "pending"
    assert payload["status_url"] == f"/v1/tasks/{task_id}"
    assert payload["result_url"] == f"/v1/tasks/{task_id}/result"
    assert (settings.incoming_dir / f"{task_id}.pdf").read_bytes() == PDF_BYTES

    record = JobStore(settings.database_path).get(task_id)
    assert record is not None
    assert record.filename == "论文.pdf"
    assert record.source_sha256 == hashlib.sha256(PDF_BYTES).hexdigest()

    duplicate = client.post("/v1/tasks", headers=headers, content=PDF_BYTES)
    assert duplicate.status_code == 200
    assert duplicate.json()["task_id"] == task_id
    tampered_replay = client.post(
        "/v1/tasks",
        headers=headers,
        content=b"%PDF-1.4\ndifferent body with a stale hash\n%%EOF\n",
    )
    assert tampered_replay.status_code == 422

    status_response = client.get(payload["status_url"], headers=authorization)
    assert status_response.status_code == 200
    assert status_response.json()["progress"] == 0.0

    alias_response = client.get(f"/v1/tasks/{task_id}/status", headers=authorization)
    assert alias_response.json()["task_id"] == task_id
    waiting_result = client.get(payload["result_url"], headers=authorization)
    assert waiting_result.status_code == 202
    assert waiting_result.json()["status"] == "pending"


def test_raw_pptx_submission_preserves_format_and_filename(
    client: TestClient,
    authorization: dict[str, str],
    settings: Settings,
) -> None:
    body = pptx_bytes()
    headers = {
        **authorization,
        "Content-Type": PPTX_MEDIA_TYPE,
        "Idempotency-Key": "test-pptx-idempotency-key-0001",
        "X-Source-SHA256": hashlib.sha256(body).hexdigest(),
        "X-Filename": "%E8%AF%BE%E4%BB%B6.pptx",
        "X-MarkItDown-Profile": "fallback-text-v1",
    }

    response = client.post("/v1/tasks", headers=headers, content=body)

    assert response.status_code == 202
    task_id = response.json()["task_id"]
    assert (settings.incoming_dir / f"{task_id}.pptx").read_bytes() == body
    record = JobStore(settings.database_path).get(task_id)
    assert record is not None
    assert record.filename == "课件.pptx"


def test_raw_docx_submission_preserves_format_and_filename(
    client: TestClient,
    authorization: dict[str, str],
    settings: Settings,
) -> None:
    body = docx_bytes()
    response = client.post(
        "/v1/tasks",
        headers={
            **authorization,
            "Content-Type": DOCX_MEDIA_TYPE,
            "Idempotency-Key": "test-docx-idempotency-key-0001",
            "X-Source-SHA256": hashlib.sha256(body).hexdigest(),
            "X-Filename": "%E7%AC%94%E8%AE%B0.docx",
            "X-MarkItDown-Profile": "fallback-text-v1",
        },
        content=body,
    )
    assert response.status_code == 202
    task_id = response.json()["task_id"]
    assert (settings.incoming_dir / f"{task_id}.docx").read_bytes() == body
    record = JobStore(settings.database_path).get(task_id)
    assert record is not None
    assert record.filename == "笔记.docx"


def test_submission_rejects_non_pdf_hash_mismatch_and_oversize(
    client: TestClient,
    authorization: dict[str, str],
    settings: Settings,
) -> None:
    headers = submission_headers(authorization)

    wrong_type = client.post(
        "/v1/tasks",
        headers={**headers, "Content-Type": "application/octet-stream"},
        content=PDF_BYTES,
    )
    assert wrong_type.status_code == 415

    not_pdf = b"not a pdf"
    invalid_magic = client.post(
        "/v1/tasks",
        headers={
            **headers,
            "Idempotency-Key": "test-idempotency-key-0002",
            "X-Source-SHA256": hashlib.sha256(not_pdf).hexdigest(),
        },
        content=not_pdf,
    )
    assert invalid_magic.status_code == 422

    mismatch = client.post(
        "/v1/tasks",
        headers={
            **headers,
            "Idempotency-Key": "test-idempotency-key-0003",
            "X-Source-SHA256": "0" * 64,
        },
        content=PDF_BYTES,
    )
    assert mismatch.status_code == 422

    oversized = b"%PDF-" + b"x" * settings.max_upload_bytes
    too_large = client.post(
        "/v1/tasks",
        headers={
            **headers,
            "Idempotency-Key": "test-idempotency-key-0004",
            "X-Source-SHA256": hashlib.sha256(oversized).hexdigest(),
        },
        content=oversized,
    )
    assert too_large.status_code == 413
    assert not any(settings.incoming_dir.glob(".*.upload"))


def test_idempotency_key_cannot_be_reused_for_another_source(
    client: TestClient, authorization: dict[str, str]
) -> None:
    headers = submission_headers(authorization)
    assert client.post("/v1/tasks", headers=headers, content=PDF_BYTES).status_code == 202
    other = b"%PDF-1.4\ndifferent\n%%EOF\n"
    response = client.post(
        "/v1/tasks",
        headers={**headers, "X-Source-SHA256": hashlib.sha256(other).hexdigest()},
        content=other,
    )
    assert response.status_code == 409


def test_completed_result_download_and_delete(
    client: TestClient,
    authorization: dict[str, str],
    settings: Settings,
) -> None:
    headers = submission_headers(authorization)
    submitted = client.post("/v1/tasks", headers=headers, content=PDF_BYTES).json()
    task_id = submitted["task_id"]
    store = JobStore(settings.database_path)
    claimed = store.claim_next()
    assert claimed is not None and claimed.task_id == task_id

    result_path = settings.results_dir / f"{task_id}.zip"
    manifest = write_result_bundle(
        result_path,
        markdown="# Converted\n",
        source_sha256=claimed.source_sha256,
        source_size_bytes=claimed.size_bytes,
        source_format="pdf",
        unit_kind="page",
        unit_count=1,
        profile=claimed.profile,
        engine_version=settings.engine_version,
        engine_build_id=settings.engine_build_id,
        max_result_bytes=settings.max_result_bytes,
    )
    assert store.mark_completed(
        task_id,
        page_count=1,
        result_size_bytes=result_path.stat().st_size,
        result_sha256=hashlib.sha256(result_path.read_bytes()).hexdigest(),
        markdown_sha256=manifest["output"]["markdown_sha256"],
        warnings=[],
        ttl_seconds=60,
    )

    response = client.get(f"/v1/tasks/{task_id}/result", headers=authorization)
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/zip"
    assert response.headers["x-source-sha256"] == claimed.source_sha256
    assert response.headers["x-result-sha256"] == hashlib.sha256(response.content).hexdigest()

    deleted = client.delete(f"/v1/tasks/{task_id}", headers=authorization)
    assert deleted.status_code == 200
    assert deleted.json()["status"] == "cancelled"
    assert not result_path.exists()
    assert client.get(f"/v1/tasks/{task_id}/result", headers=authorization).status_code == 409


def test_failed_task_uses_client_compatible_error_fields(
    client: TestClient,
    authorization: dict[str, str],
    settings: Settings,
) -> None:
    headers = submission_headers(authorization)
    task_id = client.post("/v1/tasks", headers=headers, content=PDF_BYTES).json()["task_id"]
    store = JobStore(settings.database_path)
    assert store.claim_next() is not None
    store.mark_failed(
        task_id,
        code="conversion_timeout",
        message="The conversion exceeded its time limit.",
        ttl_seconds=60,
    )

    payload = client.get(f"/v1/tasks/{task_id}", headers=authorization).json()
    assert payload["status"] == "failed"
    assert payload["error"] == "The conversion exceeded its time limit."
    assert payload["error_code"] == "conversion_timeout"
    assert payload["retryable"] is True


def test_expired_task_returns_gone(
    client: TestClient,
    authorization: dict[str, str],
    settings: Settings,
) -> None:
    headers = submission_headers(authorization)
    task_id = client.post("/v1/tasks", headers=headers, content=PDF_BYTES).json()["task_id"]
    store = JobStore(settings.database_path)
    store.cancel(task_id, ttl_seconds=1)
    store.expire_due(now=time.time() + 2)

    response = client.get(f"/v1/tasks/{task_id}", headers=authorization)
    assert response.status_code == 410
    assert response.json()["status"] == "expired"

    resubmitted = client.post("/v1/tasks", headers=headers, content=PDF_BYTES)
    assert resubmitted.status_code == 202
    assert resubmitted.json()["task_id"] != task_id


def test_queue_bound_rejects_new_work_without_leaving_a_pdf(
    authorization: dict[str, str],
    settings: Settings,
) -> None:
    bounded_settings = replace(settings, max_active_tasks=1)
    first_headers = submission_headers(authorization)
    with TestClient(create_app(bounded_settings)) as client:
        first = client.post("/v1/tasks", headers=first_headers, content=PDF_BYTES)
        assert first.status_code == 202

        other = b"%PDF-1.4\nsecond\n%%EOF\n"
        second_headers = {
            **first_headers,
            "Idempotency-Key": "test-idempotency-key-queue",
            "X-Source-SHA256": hashlib.sha256(other).hexdigest(),
        }
        response = client.post("/v1/tasks", headers=second_headers, content=other)
        assert response.status_code == 429
        assert response.headers["retry-after"] == "5"
        assert len(list(settings.incoming_dir.glob("*.pdf"))) == 1

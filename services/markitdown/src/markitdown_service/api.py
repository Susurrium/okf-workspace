"""FastAPI boundary for authenticated, raw PDF/PPTX/DOCX task submission."""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import os
import re
import time
import unicodedata
import urllib.parse
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response, status
from fastapi.responses import FileResponse, JSONResponse
from starlette.requests import ClientDisconnect

from . import __version__
from .config import Settings
from .constants import (
    BACKEND_NAME,
    DEFAULT_PROFILE,
    HEALTH_CAPABILITIES,
    RESULT_SCHEMA,
    SUPPORTED_PROFILES,
)
from .storage import JobRecord, JobStore, QueueFullError

SHA256_PATTERN = re.compile(r"^[0-9a-fA-F]{64}$")
IDEMPOTENCY_PATTERN = re.compile(r"^[A-Za-z0-9._:-]{16,200}$")
SUPPORTED_MEDIA_TYPES = {
    "application/pdf": ".pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
}


def _iso8601(timestamp: float | None) -> str | None:
    if timestamp is None:
        return None
    return datetime.fromtimestamp(timestamp, tz=UTC).isoformat().replace("+00:00", "Z")


def _task_urls(task_id: str) -> tuple[str, str]:
    return f"/v1/tasks/{task_id}", f"/v1/tasks/{task_id}/result"


def _progress(status_value: str) -> float:
    return {
        "pending": 0.0,
        "processing": 0.5,
        "completed": 1.0,
        "failed": 1.0,
        "cancelled": 1.0,
        "expired": 1.0,
    }[status_value]


def _task_payload(job: JobRecord) -> dict[str, object]:
    status_url, result_url = _task_urls(job.task_id)
    payload: dict[str, object] = {
        "task_id": job.task_id,
        "status": job.status,
        "backend": BACKEND_NAME,
        "profile": job.profile,
        "progress": _progress(job.status),
        "warnings": list(job.warnings),
        "error": job.error_message,
        "created_at": _iso8601(job.created_at),
        "updated_at": _iso8601(job.updated_at),
        "expires_at": _iso8601(job.expires_at),
        "status_url": status_url,
        "result_url": result_url,
    }
    if job.page_count is not None:
        suffix = os.path.splitext(job.filename)[1].lower()
        payload["source_format"] = suffix.lstrip(".")
        payload["unit_kind"] = (
            "page" if suffix == ".pdf" else ("slide" if suffix == ".pptx" else "document")
        )
        payload["unit_count"] = job.page_count
    if job.error_code is not None:
        payload["error_code"] = job.error_code
        payload["retryable"] = job.error_code in {
            "worker_interrupted",
            "conversion_timeout",
        }
    return payload


def _submission_payload(job: JobRecord) -> dict[str, object]:
    status_url, result_url = _task_urls(job.task_id)
    return {
        "task_id": job.task_id,
        "status": job.status,
        "backend": BACKEND_NAME,
        "status_url": status_url,
        "result_url": result_url,
    }


def _safe_filename(value: str | None, *, required_suffix: str) -> str:
    if not value:
        return f"document{required_suffix}"
    decoded = urllib.parse.unquote(value, errors="replace")
    decoded = decoded.replace("\\", "/").rsplit("/", maxsplit=1)[-1]
    normalized = unicodedata.normalize("NFC", decoded)
    cleaned = "".join(character for character in normalized if character.isprintable())
    cleaned = cleaned.strip().strip(".")[:120]
    if not cleaned:
        return f"document{required_suffix}"
    current_suffix = os.path.splitext(cleaned)[1]
    if current_suffix.lower() != required_suffix:
        cleaned = (cleaned[: -len(current_suffix)] if current_suffix else cleaned) + required_suffix
    return cleaned


def _get_settings(request: Request) -> Settings:
    return request.app.state.settings


def _get_store(request: Request) -> JobStore:
    return request.app.state.store


SettingsDependency = Annotated[Settings, Depends(_get_settings)]
StoreDependency = Annotated[JobStore, Depends(_get_store)]


async def _upload_slot(request: Request) -> AsyncIterator[None]:
    semaphore: asyncio.Semaphore = request.app.state.upload_semaphore
    try:
        await asyncio.wait_for(semaphore.acquire(), timeout=0.05)
    except TimeoutError as exc:
        raise HTTPException(
            status_code=429,
            detail="another PDF upload is already in progress",
            headers={"Retry-After": "2"},
        ) from exc
    try:
        yield
    finally:
        semaphore.release()


UploadSlotDependency = Annotated[None, Depends(_upload_slot)]


async def _bounded_upload(request: Request, settings: Settings) -> AsyncIterator[bytes]:
    deadline = time.monotonic() + settings.upload_timeout_seconds
    stream = request.stream()
    try:
        while True:
            remaining = deadline - time.monotonic()
            total_limit = remaining <= settings.upload_idle_timeout_seconds
            try:
                if remaining <= 0:
                    raise TimeoutError
                chunk = await asyncio.wait_for(
                    anext(stream),
                    timeout=min(remaining, settings.upload_idle_timeout_seconds),
                )
            except StopAsyncIteration:
                return
            except TimeoutError as exc:
                raise HTTPException(
                    status_code=408,
                    detail=(
                        "document upload exceeded its total time limit"
                        if total_limit
                        else "document upload exceeded its idle time limit"
                    ),
                    headers={"Retry-After": "2"},
                ) from exc
            yield chunk
    finally:
        await stream.aclose()


def _authorized(
    request: Request,
    authorization: str | None = Header(default=None),
) -> None:
    settings: Settings = request.app.state.settings
    scheme, separator, supplied = (authorization or "").partition(" ")
    valid = separator == " " and scheme.lower() == "bearer" and bool(supplied)
    if valid:
        supplied_digest = hashlib.sha256(supplied.encode("utf-8")).digest()
        valid = any(
            hmac.compare_digest(
                supplied_digest,
                hashlib.sha256(expected.encode("utf-8")).digest(),
            )
            for expected in settings.api_tokens
        )
    if not valid:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid bearer token",
            headers={"WWW-Authenticate": "Bearer"},
        )


def create_app(configured_settings: Settings | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        settings = configured_settings or Settings.from_environment(require_tokens=True)
        if not settings.api_tokens:
            raise RuntimeError("the API process requires at least one bearer token")
        settings.prepare_directories()
        store = JobStore(settings.database_path)
        store.initialize()
        app.state.settings = settings
        app.state.store = store
        app.state.upload_semaphore = asyncio.Semaphore(settings.max_concurrent_uploads)
        yield

    application = FastAPI(
        title="Obsidian MarkItDown Fallback Service",
        version=__version__,
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )

    @application.get("/livez", include_in_schema=False)
    async def livez() -> dict[str, str]:
        return {"status": "alive"}

    @application.get("/v1/health", dependencies=[Depends(_authorized)])
    async def health(
        settings: SettingsDependency,
        store: StoreDependency,
    ) -> JSONResponse:
        now = time.time()
        heartbeat = store.worker_heartbeat()
        storage = settings.storage_status()
        storage_healthy = storage.can_fit(settings.max_upload_bytes + settings.max_result_bytes)
        healthy = (
            heartbeat is not None
            and now - heartbeat <= settings.worker_stale_seconds
            and storage_healthy
        )
        value = {
            "status": "healthy" if healthy else "degraded",
            "healthy": healthy,
            "service_version": settings.service_version,
            "engine": BACKEND_NAME,
            "engine_version": settings.engine_version,
            "engine_build_id": settings.engine_build_id,
            "release_manifest_sha256": settings.release_manifest_sha256,
            "result_schema": RESULT_SCHEMA,
            "default_profile": DEFAULT_PROFILE,
            "supported_profiles": sorted(SUPPORTED_PROFILES),
            "worker_heartbeat": _iso8601(heartbeat),
            "queue_depth": store.queue_depth(),
            "spool_bytes": storage.spool_bytes,
            "spool_limit_bytes": storage.spool_limit_bytes,
            "filesystem_free_bytes": storage.filesystem_free_bytes,
            "minimum_free_bytes": storage.minimum_free_bytes,
            "storage_healthy": storage_healthy,
            "capabilities": HEALTH_CAPABILITIES,
        }
        return JSONResponse(value, status_code=200 if healthy else 503)

    @application.post(
        "/v1/tasks",
        status_code=status.HTTP_202_ACCEPTED,
        dependencies=[Depends(_authorized)],
    )
    async def create_task(
        request: Request,
        settings: SettingsDependency,
        store: StoreDependency,
        _upload_slot_acquired: UploadSlotDependency,
        content_type: str | None = Header(default=None),
        content_length: str | None = Header(default=None),
        idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
        source_sha256: str | None = Header(default=None, alias="X-Source-SHA256"),
        original_filename: str | None = Header(default=None, alias="X-Filename"),
        profile: str = Header(default=DEFAULT_PROFILE, alias="X-MarkItDown-Profile"),
    ) -> JSONResponse:
        del _upload_slot_acquired
        media_type = (content_type or "").split(";", maxsplit=1)[0].strip().lower()
        required_suffix = SUPPORTED_MEDIA_TYPES.get(media_type)
        if required_suffix is None:
            raise HTTPException(
                status_code=415,
                detail="Content-Type must identify a PDF, PPTX, or DOCX document",
            )
        if not idempotency_key or not IDEMPOTENCY_PATTERN.fullmatch(idempotency_key):
            raise HTTPException(status_code=400, detail="invalid or missing Idempotency-Key")
        if not source_sha256 or not SHA256_PATTERN.fullmatch(source_sha256):
            raise HTTPException(status_code=400, detail="invalid or missing X-Source-SHA256")
        source_sha256 = source_sha256.lower()
        if profile not in SUPPORTED_PROFILES:
            raise HTTPException(status_code=422, detail="unsupported MarkItDown profile")
        if content_length is not None:
            try:
                declared_length = int(content_length)
            except ValueError as exc:
                raise HTTPException(status_code=400, detail="invalid Content-Length") from exc
            if declared_length < 0:
                raise HTTPException(status_code=400, detail="invalid Content-Length")
            if declared_length > settings.max_upload_bytes:
                raise HTTPException(status_code=413, detail="document exceeds the upload limit")
        else:
            declared_length = settings.max_upload_bytes

        storage = settings.storage_status()
        required_capacity = declared_length + settings.max_result_bytes
        if not storage.can_fit(required_capacity):
            raise HTTPException(
                status_code=503,
                detail="service spool does not have enough reserved capacity",
                headers={"Retry-After": "60"},
            )

        expired = store.get_by_idempotency_key(idempotency_key)
        if expired is not None and expired.status == "expired":
            store.release_expired_idempotency_key(idempotency_key)

        task_id = uuid.uuid4().hex
        temporary_path = settings.incoming_dir / f".{task_id}.upload"
        final_path = settings.incoming_dir / f"{task_id}{required_suffix}"
        digest = hashlib.sha256()
        total = 0
        prefix = bytearray()
        stored = False
        # The lease is durable so the separate Worker can distinguish an active
        # hidden upload from files left behind by a killed API process.
        store.hold_upload(
            task_id,
            expires_at=time.time() + settings.upload_timeout_seconds + 30,
        )
        try:
            with temporary_path.open("xb") as output:
                temporary_path.chmod(0o600)
                async for chunk in _bounded_upload(request, settings):
                    total += len(chunk)
                    if total > settings.max_upload_bytes:
                        raise HTTPException(
                            status_code=413,
                            detail="document exceeds the upload limit",
                        )
                    if len(prefix) < 8:
                        prefix.extend(chunk[: 8 - len(prefix)])
                    digest.update(chunk)
                    output.write(chunk)
                    if total % (4 * 1024 * 1024) < len(
                        chunk
                    ) and not settings.storage_status().can_fit(settings.max_result_bytes):
                        raise HTTPException(
                            status_code=503,
                            detail="service spool capacity was exhausted during upload",
                            headers={"Retry-After": "60"},
                        )
                output.flush()
                os.fsync(output.fileno())
            if required_suffix == ".pdf" and not bytes(prefix).startswith(b"%PDF-"):
                raise HTTPException(status_code=422, detail="request body is not a PDF")
            if required_suffix == ".pptx" and not bytes(prefix).startswith(b"PK"):
                raise HTTPException(status_code=422, detail="request body is not a PPTX package")
            if required_suffix == ".docx" and not bytes(prefix).startswith(b"PK"):
                raise HTTPException(status_code=422, detail="request body is not a DOCX package")
            if not hmac.compare_digest(digest.hexdigest(), source_sha256):
                raise HTTPException(status_code=422, detail="source SHA-256 mismatch")
            os.replace(temporary_path, final_path)
            create_result = store.create(
                task_id=task_id,
                idempotency_key=idempotency_key,
                source_sha256=source_sha256,
                filename=_safe_filename(
                    original_filename,
                    required_suffix=required_suffix,
                ),
                profile=profile,
                size_bytes=total,
                max_active_tasks=settings.max_active_tasks,
            )
            if not create_result.created:
                final_path.unlink(missing_ok=True)
                if create_result.conflict:
                    raise HTTPException(status_code=409, detail="idempotency key conflicts")
                return JSONResponse(_submission_payload(create_result.job), status_code=200)
            stored = True
        except ClientDisconnect as exc:
            raise HTTPException(
                status_code=400, detail="client disconnected during upload"
            ) from exc
        except QueueFullError as exc:
            raise HTTPException(
                status_code=429,
                detail="conversion queue is full",
                headers={"Retry-After": "5"},
            ) from exc
        finally:
            temporary_path.unlink(missing_ok=True)
            if not stored:
                final_path.unlink(missing_ok=True)
            store.release_upload(task_id)

        return JSONResponse(_submission_payload(create_result.job), status_code=202)

    async def task_status(task_id: str, store: JobStore) -> JSONResponse:
        job = store.get(task_id)
        if job is None:
            raise HTTPException(status_code=404, detail="task not found")
        if job.status == "expired":
            return JSONResponse(_task_payload(job), status_code=410)
        return JSONResponse(_task_payload(job))

    @application.get("/v1/tasks/{task_id}", dependencies=[Depends(_authorized)])
    async def get_task(task_id: str, store: StoreDependency) -> JSONResponse:
        return await task_status(task_id, store)

    @application.get("/v1/tasks/{task_id}/status", dependencies=[Depends(_authorized)])
    async def get_task_status(task_id: str, store: StoreDependency) -> JSONResponse:
        return await task_status(task_id, store)

    @application.get("/v1/tasks/{task_id}/result", dependencies=[Depends(_authorized)])
    async def get_result(
        task_id: str,
        settings: SettingsDependency,
        store: StoreDependency,
    ) -> Response:
        job = store.get(task_id)
        if job is None:
            raise HTTPException(status_code=404, detail="task not found")
        if job.status == "expired":
            raise HTTPException(status_code=410, detail="task result expired")
        if job.status in {"pending", "processing"}:
            return JSONResponse(_task_payload(job), status_code=202)
        if job.status != "completed":
            raise HTTPException(status_code=409, detail=f"task is {job.status}")
        if not job.result_sha256:
            raise HTTPException(status_code=500, detail="task result digest is missing")
        result_path = settings.results_dir / f"{task_id}.zip"
        if not result_path.is_file():
            raise HTTPException(status_code=500, detail="task result is missing")
        return FileResponse(
            result_path,
            media_type="application/zip",
            filename=f"{task_id}.zip",
            headers={
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
                "X-Source-SHA256": job.source_sha256,
                "X-Result-SHA256": job.result_sha256,
            },
        )

    @application.delete("/v1/tasks/{task_id}", dependencies=[Depends(_authorized)])
    async def delete_task(
        task_id: str,
        settings: SettingsDependency,
        store: StoreDependency,
    ) -> JSONResponse:
        job = store.cancel(task_id, ttl_seconds=settings.failure_ttl_seconds)
        if job is None:
            raise HTTPException(status_code=404, detail="task not found")
        if job.status != "processing":
            suffix = os.path.splitext(job.filename)[1].lower()
            (settings.incoming_dir / f"{task_id}{suffix}").unlink(missing_ok=True)
            (settings.results_dir / f"{task_id}.zip").unlink(missing_ok=True)
            (settings.failed_dir / f"{task_id}.json").unlink(missing_ok=True)
        status_code = 202 if job.status == "processing" else 200
        payload = _task_payload(job)
        if job.status == "processing":
            payload["status"] = "cancelling"
        return JSONResponse(payload, status_code=status_code)

    return application


app = create_app()

"""Reusable MinerU and MarkItDown API clients with one normalized export."""

from __future__ import annotations

import hashlib
import json
import mimetypes
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Protocol, cast

import httpx

from .archive import normalize_zip
from .models import ParserExport, ParserName
from .originals import sha256_file

MAX_RESULT_BYTES = 512 * 1024 * 1024
MARKITDOWN_ASSET_PROFILE = "fallback-assets-v2"
MARKITDOWN_LEGACY_PROFILE = "fallback-text-v1"


def _conversion_identity(digest: str, working: Path) -> str:
    """Explicit re-conversion must not reuse a vendor's previous successful task."""
    status = working.parent / "status.json"
    if not status.is_file():
        return digest
    loaded = cast(object, json.loads(status.read_text(encoding="utf-8")))
    revision = (
        cast(Mapping[str, object], loaded).get("generation_revision")
        if isinstance(loaded, dict) else None
    )
    return hashlib.sha256(f"{digest}:{revision}".encode()).hexdigest() if revision else digest


class ParserClientError(RuntimeError):
    """A parser was unreachable, failed, or violated its API contract."""


class RetryableConversionError(ParserClientError):
    """A conversion can resume or be submitted again after a delay."""


class ParserClient(Protocol):
    parser: ParserName

    def convert(
        self,
        source: Path,
        working_directory: Path,
        *,
        timeout_seconds: float = 900.0,
    ) -> ParserExport: ...


def _json_object(response: httpx.Response, operation: str) -> Mapping[str, object]:
    try:
        loaded = cast(object, response.json())
    except json.JSONDecodeError as exc:
        raise ParserClientError(f"{operation} returned invalid JSON") from exc
    if not isinstance(loaded, dict):
        raise ParserClientError(f"{operation} returned a non-object JSON body")
    return cast(Mapping[str, object], loaded)


def _required_string(
    payload: Mapping[str, object],
    key: str,
    operation: str,
) -> str:
    value = payload.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ParserClientError(f"{operation} response is missing {key}")
    return value.strip()


def _error(response: httpx.Response, operation: str) -> ParserClientError:
    detail = response.text.strip()[:1000] or "<empty response>"
    error_type = (
        RetryableConversionError if response.status_code == 429 or response.status_code >= 500
        else ParserClientError
    )
    return error_type(f"{operation} failed with HTTP {response.status_code}: {detail}")


def _write_result(response: httpx.Response, target: Path) -> None:
    if response.status_code != 200:
        raise _error(response, "downloading parser result")
    content_type = response.headers.get("content-type", "").partition(";")[0].lower()
    if content_type not in {"application/zip", "application/x-zip-compressed"}:
        raise ParserClientError(
            f"parser result is not a ZIP archive: {content_type or '<missing>'}"
        )
    declared = response.headers.get("content-length")
    if declared is not None and int(declared) > MAX_RESULT_BYTES:
        raise ParserClientError("parser result exceeds the compressed size limit")
    size = 0
    digest = hashlib.sha256()
    prefix = bytearray()
    with target.open("wb") as handle:
        for block in response.iter_bytes(chunk_size=1024 * 1024):
            size += len(block)
            if size > MAX_RESULT_BYTES:
                raise ParserClientError("parser result exceeds the compressed size limit")
            if len(prefix) < 4:
                prefix.extend(block[: 4 - len(prefix)])
            handle.write(block)
            digest.update(block)
    if bytes(prefix) not in {b"PK\x03\x04", b"PK\x05\x06", b"PK\x07\x08"}:
        raise ParserClientError("parser result has an invalid ZIP signature")
    expected = response.headers.get("x-result-sha256")
    if expected and expected.casefold() != digest.hexdigest():
        raise ParserClientError("parser result hash does not match response header")


class _AsyncClient:
    parser: ParserName
    task_prefix: str

    def __init__(
        self,
        base_url: str,
        *,
        client: httpx.Client | None = None,
        poll_seconds: float = 1.0,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.poll_seconds = poll_seconds
        self._owns_client = client is None
        self.client = client or httpx.Client(
            timeout=120.0,
            follow_redirects=False,
            # Explicit authenticated parser endpoints are reached directly;
            # unrelated desktop proxy variables must not reroute Vault uploads.
            trust_env=False,
        )

    def close(self) -> None:
        if self._owns_client:
            self.client.close()

    def __enter__(self) -> _AsyncClient:
        return self

    def __exit__(self, *exc_info: object) -> None:
        self.close()

    def _url(self, path: str) -> str:
        return f"{self.base_url}{path}"

    @property
    def request_headers(self) -> Mapping[str, str]:
        return {}

    def _wait(self, task_id: str, timeout_seconds: float) -> None:
        deadline = time.monotonic() + timeout_seconds
        while True:
            response = self.client.get(
                self._url(f"{self.task_prefix}/{task_id}"),
                headers=self.request_headers,
            )
            if response.status_code != 200:
                raise _error(response, f"polling {self.parser.value}")
            payload = _json_object(response, f"polling {self.parser.value}")
            status = _required_string(payload, "status", "task status")
            if status == "completed":
                return
            if status == "failed":
                detail = payload.get("error")
                raise ParserClientError(
                    f"{self.parser.value} conversion failed: {detail or 'unknown error'}"
                )
            if status not in {"pending", "queued", "processing", "converting"}:
                raise ParserClientError(
                    f"{self.parser.value} returned unknown task status {status!r}"
                )
            if time.monotonic() >= deadline:
                raise RetryableConversionError(
                    f"{self.parser.value} conversion exceeded {timeout_seconds} seconds"
                )
            time.sleep(self.poll_seconds)

    def _download(
        self,
        task_id: str,
        working_directory: Path,
        parser_version: str,
    ) -> ParserExport:
        working_directory.mkdir(parents=True, exist_ok=True)
        archive = working_directory / f"{self.parser.value}-result.zip"
        with self.client.stream(
            "GET",
            self._url(f"{self.task_prefix}/{task_id}/result"),
            headers={**self.request_headers, "Accept": "application/zip"},
        ) as response:
            _write_result(response, archive)
        return normalize_zip(
            archive,
            parser=self.parser,
            parser_version=parser_version,
        )


class MinerUClient(_AsyncClient):
    parser = ParserName.MINERU
    task_prefix = "/tasks"

    def convert(
        self,
        source: Path,
        working_directory: Path,
        *,
        timeout_seconds: float = 900.0,
    ) -> ParserExport:
        health = self.client.get(self._url("/health"))
        if health.status_code != 200:
            raise _error(health, "checking MinerU")
        health_payload = _json_object(health, "checking MinerU")
        version_value = health_payload.get("version")
        version = version_value if isinstance(version_value, str) else "unknown"
        content_type = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
        form = {
            "backend": "hybrid-engine",
            "parse_method": "auto",
            "effort": "high",
            "formula_enable": "true",
            "table_enable": "true",
            "image_analysis": "true",
            "return_md": "true",
            "return_images": "true",
            "response_format_zip": "true",
            "return_original_file": "false",
        }
        digest = sha256_file(source)
        with source.open("rb") as handle:
            response = self.client.post(
                self._url("/tasks"),
                data=form,
                files={"files": (source.name, handle, content_type)},
                headers={
                    "Idempotency-Key": (
                        f"okf-mineru-{_conversion_identity(digest, working_directory)}"
                    ),
                },
            )
        if response.status_code not in {200, 202}:
            raise _error(response, "submitting MinerU")
        task_id = _required_string(
            _json_object(response, "submitting MinerU"),
            "task_id",
            "task submission",
        )
        self._wait(task_id, timeout_seconds)
        return self._download(task_id, working_directory, version)


class MarkItDownClient(_AsyncClient):
    parser = ParserName.MARKITDOWN
    task_prefix = "/v1/tasks"

    def __init__(
        self,
        base_url: str,
        bearer_token: str,
        *,
        client: httpx.Client | None = None,
        poll_seconds: float = 1.0,
    ) -> None:
        super().__init__(
            base_url,
            client=client,
            poll_seconds=poll_seconds,
        )
        self.token = bearer_token.strip()

    @property
    def request_headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.token}"} if self.token else {}

    def convert(
        self,
        source: Path,
        working_directory: Path,
        *,
        timeout_seconds: float = 900.0,
    ) -> ParserExport:
        health = self.client.get(
            self._url("/v1/health"),
            headers=self.request_headers,
        )
        if health.status_code != 200:
            raise _error(health, "checking MarkItDown")
        health_payload = _json_object(health, "checking MarkItDown")
        version = _required_string(
            health_payload,
            "engine_version",
            "MarkItDown health",
        )
        result_schema = health_payload.get("result_schema")
        profile = (
            MARKITDOWN_ASSET_PROFILE
            if result_schema == "markitdown-result/v3"
            else MARKITDOWN_LEGACY_PROFILE
        )
        build_id_value = health_payload.get("engine_build_id")
        build_identity = (
            build_id_value.strip()
            if isinstance(build_id_value, str) and build_id_value.strip()
            else version
        )
        build_key = hashlib.sha256(build_identity.encode("utf-8")).hexdigest()[:16]
        digest = sha256_file(source)
        media_type = mimetypes.guess_type(source.name)[0] or "application/octet-stream"
        headers = {
            **self.request_headers,
            "Idempotency-Key": (
                f"okf-markitdown-{profile}-{build_key}-"
                f"{_conversion_identity(digest, working_directory)}"
            ),
            "X-Source-SHA256": digest,
            "X-Filename": source.name,
            "X-MarkItDown-Profile": profile,
            "Content-Type": media_type,
        }
        with source.open("rb") as handle:
            response = self.client.post(
                self._url("/v1/tasks"),
                content=handle,
                headers=headers,
            )
        if response.status_code not in {200, 202}:
            raise _error(response, "submitting MarkItDown")
        task_id = _required_string(
            _json_object(response, "submitting MarkItDown"),
            "task_id",
            "task submission",
        )
        self._wait(task_id, timeout_seconds)
        return self._download(task_id, working_directory, version)

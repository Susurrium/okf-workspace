#!/usr/bin/env python3
"""Verify the private API identity and, optionally, one real PDF conversion."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile
from contextlib import suppress
from pathlib import Path
from typing import Any

MAX_JSON_BYTES = 1_048_576
MAX_RESULT_BYTES = 134_217_728
EXPECTED_CAPABILITIES = {
    "page_map": False,
    "assets": False,
    "ocr": False,
    "formulas": False,
    "tables": "best_effort",
    "headings": "best_effort",
}


class VerificationError(RuntimeError):
    """Raised when the deployed service violates its pinned contract."""


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args: object, **kwargs: object) -> None:
        del args, kwargs


def _read_token(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise VerificationError(f"token path is not a regular file: {path}")
    lines = [
        line.strip()
        for line in path.read_text(encoding="utf-8").splitlines()
        if line.strip() and not line.lstrip().startswith("#")
    ]
    if not lines or len(lines[0]) < 32:
        raise VerificationError("token file contains no valid active token")
    return lines[0]


def _safe_base_url(value: str, *, expected_hostname: str | None) -> str:
    parsed = urllib.parse.urlsplit(value)
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        raise VerificationError(
            "base URL must not contain credentials, a query, or a fragment"
        )
    if parsed.path not in {"", "/"}:
        raise VerificationError("base URL must use the service root path")
    if parsed.scheme == "http" and parsed.hostname not in {
        "127.0.0.1",
        "localhost",
        "::1",
    }:
        raise VerificationError("cleartext HTTP is allowed only on loopback")
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        raise VerificationError("base URL must be loopback HTTP or private HTTPS")
    if parsed.scheme == "https":
        if expected_hostname is None:
            raise VerificationError("HTTPS verification requires --expected-hostname")
        normalized_hostname = expected_hostname.strip().lower().rstrip(".")
        if not normalized_hostname.endswith(".ts.net"):
            raise VerificationError("expected HTTPS hostname must be a *.ts.net name")
        if parsed.hostname.lower().rstrip(".") != normalized_hostname:
            raise VerificationError(
                "HTTPS base URL does not match the confirmed hostname"
            )
    return value.rstrip("/")


def _request(
    url: str,
    *,
    token: str,
    method: str = "GET",
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 10,
) -> tuple[int, dict[str, str], bytes]:
    request_headers = {"Authorization": f"Bearer {token}"}
    request_headers.update(headers or {})
    request = urllib.request.Request(
        url,
        data=data,
        headers=request_headers,
        method=method,
    )
    handlers: list[Any] = [urllib.request.ProxyHandler({}), _NoRedirect()]
    if url.startswith("https://"):
        handlers.append(
            urllib.request.HTTPSHandler(context=ssl.create_default_context())
        )
    opener = urllib.request.build_opener(*handlers)
    try:
        with opener.open(request, timeout=timeout) as response:
            payload = response.read(MAX_RESULT_BYTES + 1)
            if len(payload) > MAX_RESULT_BYTES:
                raise VerificationError("HTTP response exceeds the verification limit")
            response_headers = {
                key.lower(): value for key, value in response.headers.items()
            }
            return response.status, response_headers, payload
    except urllib.error.HTTPError as exc:
        detail = exc.read(8192).decode("utf-8", errors="replace")
        raise VerificationError(f"HTTP {exc.code} from {url}: {detail[:500]}") from exc
    except urllib.error.URLError as exc:
        raise VerificationError(f"cannot reach {url}: {exc.reason}") from exc
    except (ConnectionError, TimeoutError, OSError) as exc:
        raise VerificationError(f"cannot reach {url}: {exc}") from exc


def _json_payload(payload: bytes, *, location: str) -> dict[str, Any]:
    if len(payload) > MAX_JSON_BYTES:
        raise VerificationError(f"{location} JSON exceeds the size limit")
    try:
        value = json.loads(payload)
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise VerificationError(f"{location} is not valid JSON") from exc
    if not isinstance(value, dict):
        raise VerificationError(f"{location} must be a JSON object")
    return value


def _health(
    base_url: str,
    token: str,
    *,
    expected_build_id: str,
    expected_release_manifest_sha256: str,
    timeout_seconds: float,
) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_seconds
    last_error = "no response"
    while time.monotonic() < deadline:
        try:
            status, _headers, payload = _request(
                f"{base_url}/v1/health", token=token, timeout=5
            )
            if status != 200:
                raise VerificationError(f"unexpected health status: {status}")
            health = _json_payload(payload, location="health response")
            expected = {
                "healthy": True,
                "status": "healthy",
                "service_version": "1.3.0",
                "engine": "markitdown",
                "engine_version": "0.1.6",
                "engine_build_id": expected_build_id,
                "release_manifest_sha256": expected_release_manifest_sha256,
                "result_schema": "markitdown-result/v3",
                "default_profile": "fallback-assets-v2",
                "supported_profiles": ["fallback-assets-v2", "fallback-text-v1"],
            }
            mismatches = [
                f"{key}={health.get(key)!r}, expected {value!r}"
                for key, value in expected.items()
                if health.get(key) != value
            ]
            if mismatches:
                raise VerificationError(
                    "health identity mismatch: " + "; ".join(mismatches)
                )
            capabilities = health.get("capabilities")
            formats = (
                capabilities.get("formats") if isinstance(capabilities, dict) else None
            )
            if (
                not isinstance(capabilities, dict)
                or not isinstance(formats, dict)
                or formats.get("pdf")
                != {"markdown": True, "assets": False, "ocr": False}
                or formats.get("pptx")
                != {"markdown": True, "assets": "embedded", "ocr": False}
                or formats.get("docx")
                != {"markdown": True, "assets": "embedded", "ocr": False}
                or capabilities.get("network_access") is not False
            ):
                raise VerificationError("health capability contract mismatch")
            return health
        except VerificationError as exc:
            last_error = str(exc)
            time.sleep(2)
    raise VerificationError(f"service did not become healthy: {last_error}")


def _verify_bundle(
    payload: bytes,
    *,
    source_sha256: str,
    result_sha256: str,
    expected_build_id: str,
    expected_markdown_text: str | None,
) -> None:
    if not payload.startswith(b"PK\x03\x04"):
        raise VerificationError("result is not a ZIP archive")
    if hashlib.sha256(payload).hexdigest() != result_sha256:
        raise VerificationError("result response SHA-256 does not match its header")
    descriptor, temporary_name = tempfile.mkstemp(
        prefix="markitdown-verify-", suffix=".zip"
    )
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(payload)
        with zipfile.ZipFile(temporary_name) as archive:
            if archive.namelist() != ["manifest.json", "document.md"]:
                raise VerificationError(
                    "PDF result ZIP does not have the exact v3 entry order"
                )
            entries = archive.infolist()
            if any(info.is_dir() or info.flag_bits & 0x1 for info in entries):
                raise VerificationError(
                    "result ZIP contains a directory or encrypted entry"
                )
            if entries[0].file_size > MAX_JSON_BYTES:
                raise VerificationError("result manifest exceeds the size limit")
            if entries[1].file_size > MAX_RESULT_BYTES:
                raise VerificationError("result Markdown exceeds the size limit")
            manifest_bytes = archive.read("manifest.json")
            markdown = archive.read("document.md")
        manifest = _json_payload(manifest_bytes, location="manifest")
        if manifest.get("schema") != "markitdown-result/v3":
            raise VerificationError("manifest schema mismatch")
        if manifest.get("source_sha256") != source_sha256:
            raise VerificationError("manifest source SHA-256 mismatch")
        if manifest.get("profile") != "fallback-assets-v2":
            raise VerificationError("manifest profile mismatch")
        expected_engine = {
            "name": "markitdown",
            "version": "0.1.6",
            "service_version": "1.3.0",
            "build_id": expected_build_id,
        }
        if manifest.get("engine") != expected_engine:
            raise VerificationError("manifest engine identity mismatch")
        if manifest.get("capabilities") != EXPECTED_CAPABILITIES:
            raise VerificationError("manifest capabilities mismatch")
        input_metadata = manifest.get("input")
        if (
            not isinstance(input_metadata, dict)
            or input_metadata.get("source_format") != "pdf"
            or input_metadata.get("unit_kind") != "page"
            or not isinstance(input_metadata.get("unit_count"), int)
            or input_metadata["unit_count"] <= 0
            or input_metadata.get("embedded_image_relationships") != 0
            or input_metadata.get("embedded_image_references") != 0
            or input_metadata.get("external_image_relationships") != 0
            or input_metadata.get("external_image_references") != 0
            or input_metadata.get("embedded_image_parts") != 0
        ):
            raise VerificationError("manifest input identity mismatch")
        output = manifest.get("output")
        if not isinstance(output, dict):
            raise VerificationError("manifest output is missing")
        if output.get("markdown_bytes") != len(markdown):
            raise VerificationError("manifest Markdown byte count mismatch")
        if output.get("markdown_sha256") != hashlib.sha256(markdown).hexdigest():
            raise VerificationError("manifest Markdown SHA-256 mismatch")
        if output.get("image_references") != 0 or output.get("assets") != []:
            raise VerificationError("PDF fallback unexpectedly declared image assets")
        warnings = manifest.get("warnings")
        if (
            not isinstance(warnings, list)
            or "pdf_text_only_images_not_extracted" not in warnings
        ):
            raise VerificationError("PDF text-only warning is missing")
        try:
            markdown_text = markdown.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise VerificationError("result Markdown is not valid UTF-8") from exc
        if (
            expected_markdown_text is not None
            and expected_markdown_text not in markdown_text
        ):
            raise VerificationError(
                "result Markdown does not contain the expected canary text"
            )
    finally:
        Path(temporary_name).unlink(missing_ok=True)


def _conversion(
    base_url: str,
    token: str,
    pdf_path: Path,
    *,
    timeout_seconds: float,
    expected_build_id: str,
    expected_markdown_text: str | None,
) -> None:
    if pdf_path.is_symlink() or not pdf_path.is_file():
        raise VerificationError(f"PDF is not a regular file: {pdf_path}")
    pdf = pdf_path.read_bytes()
    if not pdf.startswith(b"%PDF-"):
        raise VerificationError("verification input is not a PDF")
    if len(pdf) > 67_108_864:
        raise VerificationError("verification PDF exceeds the default upload limit")
    source_sha256 = hashlib.sha256(pdf).hexdigest()
    idempotency_key = f"smoke-{source_sha256[:32]}-{uuid.uuid4().hex}"
    status, _headers, payload = _request(
        f"{base_url}/v1/tasks",
        token=token,
        method="POST",
        data=pdf,
        headers={
            "Content-Type": "application/pdf",
            "X-Filename": urllib.parse.quote(pdf_path.name, safe=""),
            "X-Source-SHA256": source_sha256,
            "Idempotency-Key": idempotency_key,
            "X-MarkItDown-Profile": "fallback-assets-v2",
        },
        timeout=30,
    )
    if status not in {200, 202}:
        raise VerificationError(f"unexpected submission status: {status}")
    submission = _json_payload(payload, location="submission response")
    task_id = submission.get("task_id")
    if not isinstance(task_id, str) or not task_id:
        raise VerificationError("submission response has no task ID")

    try:
        deadline = time.monotonic() + timeout_seconds
        result_url = (
            f"{base_url}/v1/tasks/{urllib.parse.quote(task_id, safe='')}/result"
        )
        while True:
            if time.monotonic() >= deadline:
                raise VerificationError(
                    "conversion did not complete before the smoke-test timeout"
                )
            _code, _status_headers, status_payload = _request(
                f"{base_url}/v1/tasks/{urllib.parse.quote(task_id, safe='')}",
                token=token,
                timeout=10,
            )
            task = _json_payload(status_payload, location="task response")
            task_status = task.get("status")
            if task_status == "completed":
                break
            if task_status in {"failed", "cancelled", "expired"}:
                raise VerificationError(
                    f"conversion ended as {task_status}: "
                    f"{task.get('error_code')} {task.get('error')}"
                )
            if task_status not in {"pending", "processing"}:
                raise VerificationError(f"unexpected task status: {task_status!r}")
            time.sleep(1)

        result_status, result_headers, result = _request(
            result_url, token=token, timeout=30
        )
        if result_status != 200:
            raise VerificationError(f"unexpected result status: {result_status}")
        if result_headers.get("x-source-sha256") != source_sha256:
            raise VerificationError("result source SHA-256 header mismatch")
        result_sha256 = result_headers.get("x-result-sha256", "")
        if len(result_sha256) != 64:
            raise VerificationError("result SHA-256 header is missing")
        _verify_bundle(
            result,
            source_sha256=source_sha256,
            result_sha256=result_sha256,
            expected_build_id=expected_build_id,
            expected_markdown_text=expected_markdown_text,
        )
    finally:
        with suppress(VerificationError):
            _request(
                f"{base_url}/v1/tasks/{urllib.parse.quote(task_id, safe='')}",
                token=token,
                method="DELETE",
                timeout=10,
            )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:18010")
    parser.add_argument("--expected-hostname")
    parser.add_argument("--token-file", type=Path, required=True)
    parser.add_argument(
        "--expected-build-id", default="markitdown-0.1.6-py31213-assets-v3"
    )
    parser.add_argument("--expected-release-manifest-sha256", required=True)
    parser.add_argument("--health-timeout", type=float, default=30)
    parser.add_argument("--conversion-timeout", type=float, default=660)
    parser.add_argument("--pdf", type=Path)
    parser.add_argument("--expected-markdown-text")
    args = parser.parse_args()

    if args.expected_markdown_text is not None:
        if args.pdf is None:
            parser.error("--expected-markdown-text requires --pdf")
        if (
            not args.expected_markdown_text.strip()
            or len(args.expected_markdown_text) > 200
            or not args.expected_markdown_text.isprintable()
        ):
            parser.error("--expected-markdown-text must be 1-200 printable characters")

    try:
        base_url = _safe_base_url(
            args.base_url,
            expected_hostname=args.expected_hostname,
        )
        token = _read_token(args.token_file)
        health = _health(
            base_url,
            token,
            expected_build_id=args.expected_build_id,
            expected_release_manifest_sha256=args.expected_release_manifest_sha256,
            timeout_seconds=args.health_timeout,
        )
        print(
            "Health verified: "
            f"service={health['service_version']} engine={health['engine_version']} "
            f"build={health['engine_build_id']} queue={health.get('queue_depth')}"
        )
        if args.pdf is not None:
            _conversion(
                base_url,
                token,
                args.pdf,
                timeout_seconds=args.conversion_timeout,
                expected_build_id=args.expected_build_id,
                expected_markdown_text=args.expected_markdown_text,
            )
            print("Real PDF conversion and result-bundle verification passed.")
    except (OSError, VerificationError) as exc:
        print(f"VERIFY FAILED: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

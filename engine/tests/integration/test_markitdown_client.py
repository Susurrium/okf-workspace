from __future__ import annotations

import hashlib
import io
import json
import zipfile
from pathlib import Path

import httpx
import pytest

from okf_workspace.importers.clients import MarkItDownClient, RetryableConversionError


def test_parser_client_does_not_inherit_unrelated_desktop_proxies(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        monkeypatch.setenv(name, "unsupported-proxy://localhost:1")
    monkeypatch.delenv("NO_PROXY", raising=False)
    with MarkItDownClient("https://parser.example.test", "fixture-token") as client:
        assert client.request_headers == {"Authorization": "Bearer fixture-token"}


def result_zip() -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as bundle:
        bundle.writestr(
            "manifest.json",
            json.dumps(
                {
                    "schema": "markitdown-result/v2",
                    "profile": "fallback-text-v1",
                }
            ),
        )
        bundle.writestr(
            "document.md",
            "# Converted\n\nThis is complete converted Markdown content.\n",
        )
    return stream.getvalue()


def test_explicit_reparse_starts_new_vendor_task_but_retries_keep_identity(tmp_path: Path) -> None:
    source = tmp_path / "manual.docx"
    source.write_bytes(b"docx-fixture")
    working = tmp_path / "conversion" / "working"
    working.mkdir(parents=True)
    submissions: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/health":
            return httpx.Response(200, json={"engine_version": "1.2.3"})
        if request.method == "POST":
            submissions.append(
                (request.headers["idempotency-key"], request.headers["x-source-sha256"])
            )
            return httpx.Response(202, json={"task_id": "task-1"})
        if request.url.path.endswith("/result"):
            return httpx.Response(
                200, content=result_zip(), headers={"content-type": "application/zip"}
            )
        return httpx.Response(200, json={"status": "completed"})

    with httpx.Client(transport=httpx.MockTransport(handler)) as http:
        client = MarkItDownClient("http://127.0.0.1:18010", "secret", client=http)
        client.convert(source, working)
        status = working.parent / "status.json"
        status.write_text(json.dumps({"generation_revision": "explicit-reparse"}), encoding="utf-8")
        client.convert(source, working)
        client.convert(source, working)
    assert submissions[0][0] != submissions[1][0]
    assert submissions[1] == submissions[2]
    assert {digest for _, digest in submissions} == {
        hashlib.sha256(source.read_bytes()).hexdigest()
    }


@pytest.mark.parametrize("status", [429, 500, 503])
def test_temporary_service_failures_are_retryable(tmp_path: Path, status: int) -> None:
    source = tmp_path / "document.pdf"
    source.write_bytes(b"%PDF fixture")
    with httpx.Client(transport=httpx.MockTransport(lambda _: httpx.Response(status))) as http:
        client = MarkItDownClient("http://127.0.0.1:18010", "secret", client=http)
        with pytest.raises(RetryableConversionError):
            client.convert(source, tmp_path / "working")


def test_reused_markitdown_contract_submits_polls_and_exports(tmp_path: Path) -> None:
    source = tmp_path / "manual.docx"
    source.write_bytes(b"docx-fixture")
    archive = result_zip()
    calls: list[tuple[str, str]] = []

    def handler(request: httpx.Request) -> httpx.Response:
        calls.append((request.method, request.url.path))
        assert request.headers["authorization"] == "Bearer secret"
        if request.method == "POST":
            assert request.headers["x-markitdown-profile"] == "fallback-text-v1"
        if request.url.path == "/v1/health":
            return httpx.Response(
                200,
                json={"status": "healthy", "engine_version": "1.2.3"},
            )
        if request.url.path == "/v1/tasks" and request.method == "POST":
            return httpx.Response(202, json={"task_id": "task-1", "status": "pending"})
        if request.url.path == "/v1/tasks/task-1":
            return httpx.Response(
                200,
                json={
                    "task_id": "task-1",
                    "status": "completed",
                    "backend": "markitdown",
                },
            )
        if request.url.path == "/v1/tasks/task-1/result":
            return httpx.Response(
                200,
                content=archive,
                headers={"content-type": "application/zip"},
            )
        return httpx.Response(404)

    transport = httpx.MockTransport(handler)
    with httpx.Client(transport=transport, follow_redirects=False) as http:
        client = MarkItDownClient(
            "http://127.0.0.1:18010",
            "secret",
            client=http,
            poll_seconds=0,
        )
        export = client.convert(source, tmp_path / "working")

    assert export.parser.value == "markitdown"
    assert export.parser_version == "1.2.3"
    assert export.markdown.startswith("# Converted")
    assert export.bundle_schema == "markitdown-result/v2"
    assert export.profile == "fallback-text-v1"
    assert calls == [
        ("GET", "/v1/health"),
        ("POST", "/v1/tasks"),
        ("GET", "/v1/tasks/task-1"),
        ("GET", "/v1/tasks/task-1/result"),
    ]


def test_v3_health_selects_asset_profile_and_reads_asset_manifest(tmp_path: Path) -> None:
    source = tmp_path / "manual.pptx"
    source.write_bytes(b"pptx-fixture")
    image = b"image-bytes"
    digest = hashlib.sha256(image).hexdigest()
    image_path = f"images/{digest}.png"
    markdown = f"# Converted\n\nComplete body text with a figure.\n\n![figure]({image_path})\n"
    manifest: dict[str, object] = {
        "schema": "markitdown-result/v3",
        "profile": "fallback-assets-v2",
        "input": {"embedded_image_references": 1, "external_image_references": 0},
        "output": {
            "markdown_sha256": hashlib.sha256(markdown.encode()).hexdigest(),
            "markdown_bytes": len(markdown.encode()),
            "image_references": 1,
            "assets": [
                {
                    "path": image_path,
                    "sha256": digest,
                    "mime_type": "image/png",
                    "size_bytes": len(image),
                }
            ],
        },
        "warnings": [],
    }
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as bundle:
        bundle.writestr("manifest.json", json.dumps(manifest))
        bundle.writestr("document.md", markdown)
        bundle.writestr(image_path, image)
    archive = stream.getvalue()

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/v1/health":
            return httpx.Response(
                200,
                json={
                    "status": "healthy",
                    "engine_version": "0.1.6",
                    "engine_build_id": "markitdown-0.1.6-py31213-assets-v3",
                    "result_schema": "markitdown-result/v3",
                },
            )
        if request.url.path == "/v1/tasks" and request.method == "POST":
            assert request.headers["x-markitdown-profile"] == "fallback-assets-v2"
            assert "fallback-assets-v2" in request.headers["idempotency-key"]
            build_key = hashlib.sha256(b"markitdown-0.1.6-py31213-assets-v3").hexdigest()[:16]
            assert build_key in request.headers["idempotency-key"]
            return httpx.Response(202, json={"task_id": "task-v3", "status": "pending"})
        if request.url.path == "/v1/tasks/task-v3":
            return httpx.Response(200, json={"task_id": "task-v3", "status": "completed"})
        if request.url.path == "/v1/tasks/task-v3/result":
            return httpx.Response(
                200,
                content=archive,
                headers={"content-type": "application/zip"},
            )
        return httpx.Response(404)

    with httpx.Client(
        transport=httpx.MockTransport(handler),
        follow_redirects=False,
    ) as http:
        export = MarkItDownClient(
            "http://127.0.0.1:18010",
            "secret",
            client=http,
            poll_seconds=0,
        ).convert(source, tmp_path / "working")

    assert export.assets == {image_path: image}
    assert export.expected_image_references == 1
    assert export.output_image_references == 1
    assert export.bundle_schema == "markitdown-result/v3"

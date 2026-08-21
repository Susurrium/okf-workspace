from __future__ import annotations

import io
import zipfile
from pathlib import Path

import httpx

from okf_workspace.importers.clients import MarkItDownClient


def result_zip() -> bytes:
    stream = io.BytesIO()
    with zipfile.ZipFile(stream, "w") as bundle:
        bundle.writestr(
            "document.md",
            "# Converted\n\nThis is complete converted Markdown content.\n",
        )
    return stream.getvalue()


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
    assert calls == [
        ("GET", "/v1/health"),
        ("POST", "/v1/tasks"),
        ("GET", "/v1/tasks/task-1"),
        ("GET", "/v1/tasks/task-1/result"),
    ]

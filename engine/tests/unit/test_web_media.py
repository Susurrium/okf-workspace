from __future__ import annotations

from pathlib import Path

import httpx
from pytest import MonkeyPatch

from okf_workspace.notes import web_media
from okf_workspace.okf.frontmatter import OkfDocument, read_document, write_document


def test_web_media_mirror_updates_reachable_images_without_blocking_failures(
    vault: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    source_text = vault / "sources/text/web/article.md"
    write_document(
        source_text,
        OkfDocument(
            {
                "type": "Source Text",
                "title": "Article - 完整正文",
                "created_at": "2026-08-20T12:00:00+08:00",
                "parser": "obsidian-web-clipper",
                "sources": [{"resource": "/sources/records/web/article.md"}],
            },
            (
                "# Article\n\n"
                "![可用图片](https://93.184.216.34/hero.png)\n\n"
                "![失效图片](https://93.184.216.34/missing.jpg)\n"
            ),
        ),
    )

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("hero.png"):
            return httpx.Response(
                200,
                headers={"content-type": "image/png"},
                content=b"synthetic-png",
            )
        return httpx.Response(404)

    def client() -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(handler))

    def no_checkpoint(_vault: Path, _message: str) -> None:
        return None

    monkeypatch.setattr(web_media, "_http_client", client)
    monkeypatch.setattr(web_media, "create_checkpoint", no_checkpoint)

    mirrored = web_media.mirror_web_source_images(
        vault,
        source_text.relative_to(vault).as_posix(),
    )

    assert len(mirrored) == 1
    assert (vault / mirrored[0]).read_bytes() == b"synthetic-png"
    document = read_document(source_text)
    assert "https://93.184.216.34/hero.png" not in document.body
    assert f"/{mirrored[0]}" in document.body
    assert "https://93.184.216.34/missing.jpg" in document.body
    assert document.frontmatter["assets"] == [f"/{mirrored[0]}"]


def test_web_media_rejects_private_hosts_and_active_svg(
    vault: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    source_text = vault / "sources/text/web/unsafe.md"
    write_document(
        source_text,
        OkfDocument(
            {
                "type": "Source Text",
                "title": "Unsafe - 完整正文",
                "created_at": "2026-08-20T12:00:00+08:00",
                "parser": "obsidian-web-clipper",
                "sources": [{"resource": "/sources/records/web/unsafe.md"}],
            },
            (
                "# Unsafe\n\n"
                "![](http://127.0.0.1/private.png)\n"
                "![](https://93.184.216.34/active.svg)\n"
            ),
        ),
    )
    requests: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(str(request.url))
        return httpx.Response(200, headers={"content-type": "image/svg+xml"}, content=b"<svg/>")

    def client() -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(handler))

    monkeypatch.setattr(web_media, "_http_client", client)

    mirrored = web_media.mirror_web_source_images(
        vault,
        source_text.relative_to(vault).as_posix(),
    )

    assert mirrored == ()
    assert requests == ["https://93.184.216.34/active.svg"]
    assert read_document(source_text).frontmatter.get("assets") is None


def test_web_media_rereads_source_text_before_writeback(
    vault: Path,
    monkeypatch: MonkeyPatch,
) -> None:
    source_text = vault / "sources/text/web/concurrent.md"
    write_document(
        source_text,
        OkfDocument(
            {
                "type": "Source Text",
                "title": "Concurrent - 完整正文",
                "created_at": "2026-08-20T12:00:00+08:00",
                "parser": "obsidian-web-clipper",
                "sources": [{"resource": "/sources/records/web/concurrent.md"}],
            },
            "# Concurrent\n\n![](https://93.184.216.34/hero.png)\n",
        ),
    )

    def download(_client: httpx.Client, _url: str) -> tuple[bytes, str]:
        latest = read_document(source_text)
        latest.body += "\n## 后续摘录\n\n并发到达的新内容。\n"
        write_document(source_text, latest)
        return b"synthetic-png", ".png"

    def client() -> httpx.Client:
        return httpx.Client(transport=httpx.MockTransport(lambda _request: httpx.Response(500)))

    def no_checkpoint(_vault: Path, _message: str) -> None:
        return None

    monkeypatch.setattr(web_media, "_download", download)
    monkeypatch.setattr(web_media, "_http_client", client)
    monkeypatch.setattr(web_media, "create_checkpoint", no_checkpoint)

    web_media.mirror_web_source_images(
        vault,
        source_text.relative_to(vault).as_posix(),
    )

    updated = read_document(source_text)
    assert "并发到达的新内容" in updated.body
    assert "https://93.184.216.34/hero.png" not in updated.body

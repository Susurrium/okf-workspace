"""Best-effort background mirroring for remote images in a Web Source Text."""

from __future__ import annotations

import hashlib
import ipaddress
import os
import re
import socket
import tempfile
from contextlib import suppress
from pathlib import Path
from typing import cast
from urllib.parse import urljoin, urlsplit

import httpx

from okf_workspace.git import GitCheckpointError, create_checkpoint
from okf_workspace.okf.frontmatter import read_document, write_document
from okf_workspace.okf.paths import resolve_bundle_path

from .web_captures import web_source_write_lock

_MARKDOWN_IMAGE = re.compile(r"!\[[^\]]*\]\((https?://[^\s)]+)(?:\s+[^)]*)?\)", re.IGNORECASE)
_MAX_IMAGES = 24
_MAX_IMAGE_BYTES = 12 * 1024 * 1024
_MAX_TOTAL_BYTES = 64 * 1024 * 1024
_EXTENSIONS = {".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"}
_CONTENT_EXTENSIONS = {
    "image/avif": ".avif",
    "image/gif": ".gif",
    "image/jpeg": ".jpg",
    "image/png": ".png",
    "image/webp": ".webp",
}


def _extension(url: str, content_type: str) -> str | None:
    suffix = Path(urlsplit(url).path).suffix.casefold()
    if suffix in _EXTENSIONS:
        return suffix
    return _CONTENT_EXTENSIONS.get(content_type.split(";", 1)[0].strip().casefold())


def _public_web_url(url: str) -> bool:
    parsed = urlsplit(url)
    if parsed.scheme.casefold() not in {"http", "https"} or not parsed.hostname:
        return False
    host = parsed.hostname.casefold()
    if host == "localhost" or host.endswith((".localhost", ".local", ".internal")):
        return False
    try:
        addresses = {ipaddress.ip_address(host)}
    except ValueError:
        try:
            resolved = socket.getaddrinfo(
                host,
                parsed.port or (443 if parsed.scheme.casefold() == "https" else 80),
                type=socket.SOCK_STREAM,
            )
        except OSError:
            return False
        addresses = {ipaddress.ip_address(item[4][0]) for item in resolved}
    return bool(addresses) and all(address.is_global for address in addresses)


def _download(client: httpx.Client, url: str) -> tuple[bytes, str] | None:
    current = url
    for _redirect in range(6):
        if not _public_web_url(current):
            return None
        with client.stream("GET", current) as response:
            if response.is_redirect:
                location = response.headers.get("location")
                if not location:
                    return None
                current = urljoin(current, location)
                continue
            response.raise_for_status()
            declared = response.headers.get("content-length")
            if declared is not None:
                with suppress(ValueError):
                    if int(declared) > _MAX_IMAGE_BYTES:
                        return None
            extension = _extension(current, response.headers.get("content-type", ""))
            if extension is None:
                return None
            payload = bytearray()
            for chunk in response.iter_bytes():
                payload.extend(chunk)
                if len(payload) > _MAX_IMAGE_BYTES:
                    return None
            return bytes(payload), extension
    return None


def _http_client() -> httpx.Client:
    return httpx.Client(
        follow_redirects=False,
        timeout=httpx.Timeout(10.0, connect=5.0),
        headers={"User-Agent": "OKF-Workspace-Web-Mirror/1"},
    )


def _atomic_bytes(path: Path, content: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(
        prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
    )
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def mirror_web_source_images(vault: Path, relative: str) -> tuple[str, ...]:
    """Mirror reachable Markdown images; individual failures never invalidate the Source."""

    vault = vault.resolve()
    source_text = resolve_bundle_path(vault, relative)
    if not source_text.is_relative_to(vault / "sources" / "text"):
        raise ValueError("image mirroring only accepts a Source Text")
    document = read_document(source_text)
    if document.type != "Source Text":
        raise ValueError("image mirroring only accepts a Source Text")
    urls = tuple(dict.fromkeys(_MARKDOWN_IMAGE.findall(document.body)))[:_MAX_IMAGES]
    if not urls:
        return ()

    downloaded: list[str] = []
    replacements: dict[str, str] = {}
    total = 0
    assets_root = vault / "sources" / "assets" / source_text.stem
    with _http_client() as client:
        for url in urls:
            try:
                result = _download(client, url)
            except (httpx.HTTPError, OSError, ValueError):
                continue
            if result is None:
                continue
            content, extension = result
            if total + len(content) > _MAX_TOTAL_BYTES:
                break
            filename = f"{hashlib.sha256(url.encode()).hexdigest()[:12]}{extension}"
            target = assets_root / filename
            try:
                if not target.is_file():
                    _atomic_bytes(target, content)
            except OSError:
                continue
            relative_asset = target.relative_to(vault).as_posix()
            replacements[url] = f"/{relative_asset}"
            downloaded.append(relative_asset)
            total += len(content)

    if not replacements:
        return ()
    with web_source_write_lock():
        # Re-read after downloads so a repeated clip that arrived meanwhile is never
        # overwritten by the older snapshot used to discover image URLs.
        document = read_document(source_text)
        for remote, local in replacements.items():
            document.body = document.body.replace(remote, local)
        existing = document.frontmatter.get("assets")
        assets = (
            [value for value in cast(list[object], existing) if isinstance(value, str)]
            if isinstance(existing, list)
            else []
        )
        document.frontmatter["assets"] = list(
            dict.fromkeys([*assets, *(f"/{path}" for path in downloaded)])
        )
        write_document(source_text, document)
    with suppress(GitCheckpointError):
        create_checkpoint(vault, f"media: mirror Web Source images {source_text.stem}")
    return tuple(downloaded)

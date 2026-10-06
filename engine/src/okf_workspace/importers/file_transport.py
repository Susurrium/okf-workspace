"""Authenticated immutable-byte transport and independent desktop replication."""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import cast
from urllib.parse import urlsplit

import httpx

from okf_workspace.okf.file_io import atomic_write_bytes

from .originals import OriginalStore, sha256_file

LOGGER = logging.getLogger(__name__)
MAX_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class FileTransportConfig:
    base_url: str
    token: str
    store_id: str

    def validate(self) -> None:
        parsed = urlsplit(self.base_url)
        local = parsed.hostname in {"localhost", "127.0.0.1", "::1"}
        if (
            (parsed.scheme != "https" and not (local and parsed.scheme == "http"))
            or not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            raise ValueError("Original file service requires HTTPS (HTTP is local-only)")
        if len(self.token) < 32 or not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", self.store_id):
            raise ValueError("Original file service credentials or store identity are invalid")

    @classmethod
    def load(cls, state: Path) -> FileTransportConfig | None:
        path = state / "config" / "original-files.json"
        if path.is_file():
            values = cast(dict[str, str], json.loads(path.read_text(encoding="utf-8")))
            config = cls(values["base_url"], values["token"], values["store_id"])
        elif os.environ.get("OKF_FILES_URL"):
            config = cls(
                os.environ["OKF_FILES_URL"],
                Path(os.environ["OKF_FILES_TOKEN_FILE"]).read_text(encoding="utf-8").strip(),
                os.environ["OKF_FILES_STORE_ID"],
            )
        else:
            return None
        config.validate()
        return config

    def save(self, state: Path) -> None:
        self.validate()
        atomic_write_bytes(
            state / "config" / "original-files.json",
            json.dumps(
                {
                    "base_url": self.base_url,
                    "token": self.token,
                    "store_id": self.store_id,
                }
            ).encode("utf-8"),
        )
        os.chmod(state / "config" / "original-files.json", 0o600)


class FileTransport:
    def __init__(self, config: FileTransportConfig, *, client: httpx.Client | None = None):
        config.validate()
        self.config = config
        self.client = client or httpx.Client(timeout=60, follow_redirects=False, trust_env=False)

    def close(self) -> None:
        self.client.close()

    def _url(self, path: str) -> str:
        return self.config.base_url.rstrip("/") + path

    @property
    def headers(self) -> dict[str, str]:
        return {"Authorization": f"Bearer {self.config.token}"}

    def verify_store(self) -> None:
        response = self.client.get(self._url("/v1/status"), headers=self.headers)
        response.raise_for_status()
        data = cast(dict[str, object], response.json())
        if data.get("store_id") != self.config.store_id:
            raise ValueError("Original file store identity mismatch")

    def upload(self, path: Path, digest: str) -> None:
        self.verify_store()
        if not 0 < path.stat().st_size <= MAX_BYTES or sha256_file(path) != digest:
            raise ValueError("Original is damaged or exceeds the upload limit")
        existing = self.client.head(self._url(f"/v1/blobs/{digest}"), headers=self.headers)
        if existing.status_code == 200:
            if (
                existing.headers.get("x-okf-store-id") == self.config.store_id
                and existing.headers.get("x-content-sha256") == digest
                and existing.headers.get("content-length") == str(path.stat().st_size)
            ):
                return
            raise ValueError("Existing remote original metadata mismatch")
        if existing.status_code != 404:
            existing.raise_for_status()
        with path.open("rb") as content:
            response = self.client.put(
                self._url(f"/v1/blobs/{digest}"),
                headers=self.headers,
                content=content,
            )
        response.raise_for_status()
        data = cast(dict[str, object], response.json())
        if (
            data.get("sha256") != digest
            or data.get("size_bytes") != path.stat().st_size
            or data.get("store_id") != self.config.store_id
        ):
            raise ValueError("Original upload acknowledgement mismatch")

    def download(self, digest: str, target: Path, *, size: int | None = None) -> None:
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise ValueError("Invalid Original SHA-256")
        self.verify_store()
        hasher = hashlib.sha256()
        total = 0
        try:
            with self.client.stream(
                "GET",
                self._url(f"/v1/blobs/{digest}"),
                headers=self.headers,
            ) as response:
                response.raise_for_status()
                if response.headers.get("x-okf-store-id") != self.config.store_id:
                    raise ValueError("Original download store mismatch")
                with target.open("wb") as output:
                    for chunk in response.iter_bytes(1024 * 1024):
                        total += len(chunk)
                        if total > MAX_BYTES or (size is not None and total > size):
                            raise ValueError("Original download exceeds declared size")
                        hasher.update(chunk)
                        output.write(chunk)
            if not total or (size is not None and total != size) or hasher.hexdigest() != digest:
                raise ValueError("Original download integrity check failed")
        except Exception:
            target.unlink(missing_ok=True)
            raise


class OriginalReplication:
    """Scan durable originals, so CLI imports and restart recovery use the same outbox."""

    def __init__(self, originals: OriginalStore, state: Path):
        self.originals = originals
        self.state = state

    def run_once(self, stop: threading.Event | None = None) -> int:
        config = FileTransportConfig.load(self.state)
        if config is None:
            return 0
        namespace = hashlib.sha256(
            f"{config.base_url.rstrip('/')}:{config.store_id}".encode(),
        ).hexdigest()
        receipts = self.state / "original-replication" / namespace
        count = 0
        transport = FileTransport(config)
        try:
            for manifest in self.originals.root.glob("sha256/*/*/manifest.json"):
                if stop is not None and stop.is_set():
                    break
                digest = manifest.parent.name
                receipt = receipts / f"{digest}.json"
                if receipt.is_file():
                    continue
                try:
                    source = self.originals.resolve(digest, verify=True)
                    transport.upload(source, digest)
                    atomic_write_bytes(receipt, json.dumps({"sha256": digest}).encode())
                    count += 1
                except httpx.HTTPError:
                    # Bound retries during a network outage; keep every local original.
                    LOGGER.warning("Original replication deferred for %s", digest)
                    break
                except (ValueError, OSError):
                    # A damaged/oversize local file must not starve later originals.
                    LOGGER.warning("Original replication skipped an invalid file: %s", digest)
        finally:
            transport.close()
        return count

    def run_forever(self, stop: threading.Event) -> None:
        while not stop.is_set():
            try:
                self.run_once(stop)
            except (ValueError, OSError, KeyError):
                LOGGER.warning("Original file service configuration is unavailable")
            stop.wait(30)

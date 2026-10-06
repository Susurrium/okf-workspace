"""One private store per Workspace. Bytes are committed only after hash verification."""

# pyright: reportUnusedFunction=false
from __future__ import annotations

import hashlib
import os
import re
import secrets
import tempfile
from pathlib import Path
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException, Request, Response
from fastapi.responses import FileResponse

MAX_BYTES = 64 * 1024 * 1024


def create_app(root: Path, token: str, store_id: str) -> FastAPI:
    if len(token) < 32 or not re.fullmatch(r"[a-zA-Z0-9_-]{8,80}", store_id):
        raise ValueError("Configure a token of at least 32 characters and a stable store ID")
    root = root.resolve()
    root.mkdir(parents=True, exist_ok=True)
    app = FastAPI(title="OKF Original Files", docs_url=None, redoc_url=None)

    def authorize(authorization: Annotated[str | None, Header()] = None) -> None:
        if not secrets.compare_digest(authorization or "", f"Bearer {token}"):
            raise HTTPException(401, "Invalid credentials")

    protected = [Depends(authorize)]

    def blob_path(digest: str) -> Path:
        if not re.fullmatch(r"[0-9a-f]{64}", digest):
            raise HTTPException(400, "Invalid SHA-256")
        path = root / digest[:2] / digest
        if not path.resolve().is_relative_to(root):
            raise HTTPException(400, "Invalid file path")
        return path

    def headers(digest: str) -> dict[str, str]:
        return {
            "X-Content-SHA256": digest, "X-OKF-Store-ID": store_id,
            "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff",
        }

    @app.get("/health")
    def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/status", dependencies=protected)
    def status() -> dict[str, str | int]:
        return {"store_id": store_id, "max_bytes": MAX_BYTES}

    @app.put("/v1/blobs/{digest}", dependencies=protected)
    async def upload(digest: str, request: Request) -> dict[str, str | int]:
        path = blob_path(digest)
        length = request.headers.get("content-length")
        if length is not None and (not length.isdigit() or int(length) > MAX_BYTES):
            raise HTTPException(413, "File exceeds 64 MiB")
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, name = tempfile.mkstemp(prefix=".upload-", dir=path.parent)
        temporary = Path(name)
        size = 0
        hasher = hashlib.sha256()
        try:
            with os.fdopen(descriptor, "wb") as output:
                async for chunk in request.stream():
                    size += len(chunk)
                    if size > MAX_BYTES:
                        raise HTTPException(413, "File exceeds 64 MiB")
                    hasher.update(chunk)
                    output.write(chunk)
                output.flush()
                os.fsync(output.fileno())
            if not size or hasher.hexdigest() != digest:
                raise HTTPException(422, "File hash mismatch or empty file")
            # Concurrent writers for a digest can only publish identical verified bytes.
            os.replace(temporary, path)
            if os.name != "nt":
                directory_fd = os.open(path.parent, os.O_RDONLY)
                try:
                    os.fsync(directory_fd)
                finally:
                    os.close(directory_fd)
        finally:
            temporary.unlink(missing_ok=True)
        return {"sha256": digest, "size_bytes": size, "store_id": store_id}

    @app.head("/v1/blobs/{digest}", dependencies=protected)
    def exists(digest: str) -> Response:
        path = blob_path(digest)
        if not path.is_file():
            raise HTTPException(404, "Original has not been uploaded")
        return Response(headers={**headers(digest), "Content-Length": str(path.stat().st_size)})

    @app.get("/v1/blobs/{digest}", dependencies=protected)
    def download(digest: str) -> FileResponse:
        path = blob_path(digest)
        if not path.is_file():
            raise HTTPException(404, "Original has not been uploaded")
        return FileResponse(path, media_type="application/octet-stream", headers=headers(digest))

    return app


def app_from_env() -> FastAPI:
    return create_app(
        Path(os.environ["OKF_FILES_ROOT"]),
        Path(os.environ["OKF_FILES_TOKEN_FILE"]).read_text(encoding="utf-8").strip(),
        os.environ["OKF_FILES_STORE_ID"],
    )

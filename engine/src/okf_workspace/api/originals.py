"""Local access to Vault originals; all replication is owned by LiveSync."""

# pyright: reportUnusedFunction=false
from __future__ import annotations

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from okf_workspace.config import BrainPaths
from okf_workspace.importers.originals import VaultOriginalStore


def original_routes(paths: BrainPaths) -> APIRouter:
    router = APIRouter(prefix="/documents")
    originals = VaultOriginalStore(paths.vault, paths.state)

    @router.get("/originals/{digest}/content")
    def content(digest: str, filename: str) -> FileResponse:
        try:
            path = originals.resolve(digest, verify=True)
        except FileNotFoundError as exc:
            raise HTTPException(404, "原件尚未同步到本机") from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc
        return FileResponse(path, filename=path.name, headers={"Cache-Control": "no-store"})

    @router.post("/originals/{digest}/open")
    def open_original(digest: str, filename: str) -> dict[str, str]:
        raise HTTPException(410, "请通过 Obsidian 打开笔记库中的原件")

    return router

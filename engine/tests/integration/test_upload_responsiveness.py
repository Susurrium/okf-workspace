from __future__ import annotations

import asyncio
import threading
from pathlib import Path

import httpx

from okf_workspace.api import LocalTokenStore, create_app
from okf_workspace.config import BrainPaths
from okf_workspace.importers import DocumentImporter
from okf_workspace.importers.models import ParserExport, ParserName
from okf_workspace.okf.templates import initialize_vault


def test_blocked_converter_does_not_block_the_api_event_loop(tmp_path: Path) -> None:
    started, release = threading.Event(), threading.Event()

    class Converter:
        parser = ParserName.MARKITDOWN

        def convert(
            self, source: Path, working_directory: Path, *, timeout_seconds: float = 900
        ) -> ParserExport:
            started.set()
            release.wait(2)
            return ParserExport(
                markdown="# Test\n\n" + "Complete document evidence. " * 30,
                assets={},
                parser=ParserName.MARKITDOWN,
                parser_version="fixture",
            )

    paths = BrainPaths(
        initialize_vault(tmp_path / "vault"), tmp_path / "originals", tmp_path / "state"
    )
    importer = DocumentImporter(
        vault=paths.vault,
        originals=paths.originals,
        state=paths.state,
        clients={ParserName.MARKITDOWN: Converter()},
    )
    app = create_app(paths, document_importer=importer, semantic_enabled=False)
    token = LocalTokenStore(paths.state).ensure()

    async def scenario() -> None:
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app), base_url="http://test"
        ) as client:
            upload = asyncio.create_task(
                client.post(
                    "/documents/import",
                    headers={"Authorization": f"Bearer {token}"},
                    data={"intent": "source", "parser": "markitdown"},
                    files={"file": ("document.pdf", b"synthetic-pdf", "application/pdf")},
                )
            )
            try:
                assert await asyncio.to_thread(started.wait, 5)
                health = await client.get("/health")
                assert health.status_code == 200
                assert not upload.done(), "转换仍在执行时，健康请求必须能够完成"
            finally:
                release.set()
                result = await upload
                assert result.status_code == 200, result.text

    asyncio.run(scenario())

"""Run the authenticated local Dashboard API on loopback only."""

from __future__ import annotations

import argparse
import contextlib
import os
import sys
import threading
from datetime import datetime
from pathlib import Path
from typing import BinaryIO, TextIO

import uvicorn
from fastapi import FastAPI

from okf_workspace.api import create_app
from okf_workspace.config import apply_deployment_config


def redirect_bounded_logs(directory: Path, *, keep: int = 12) -> TextIO:
    directory.mkdir(parents=True, exist_ok=True)
    files = sorted(
        directory.glob("local-api-*.log"),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    for stale in files[keep - 1 :]:
        stale.unlink(missing_ok=True)
    target = directory / f"local-api-{datetime.now():%Y%m%d-%H%M%S}.log"
    stream = target.open("a", encoding="utf-8", buffering=1)
    sys.stdout = stream
    sys.stderr = stream
    return stream


def stop_when_stdin_closes(server: uvicorn.Server, stream: BinaryIO) -> None:
    """Stop an Obsidian-owned service when its parent-side pipe disappears."""

    with contextlib.suppress(OSError):
        stream.read()
    server.should_exit = True


def run_plugin_owned_server(
    app: FastAPI,
    *,
    host: str,
    port: int,
    owner_stream: BinaryIO,
) -> None:
    server = uvicorn.Server(
        uvicorn.Config(
            app,
            host=host,
            port=port,
            log_level="info",
            timeout_graceful_shutdown=1,
        )
    )
    watcher = threading.Thread(
        target=stop_when_stdin_closes,
        args=(server, owner_stream),
        name="okf-owner-watch",
        daemon=True,
    )
    watcher.start()
    server.run()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="okf-server")
    parser.add_argument("--config", type=Path)
    parser.add_argument("--log-directory", type=Path)
    parser.add_argument("--exit-on-stdin-close", action="store_true")
    args = parser.parse_args(argv)
    log_stream = (
        redirect_bounded_logs(args.log_directory.resolve())
        if args.log_directory is not None
        else None
    )
    if args.config is not None:
        apply_deployment_config(args.config.resolve())
    host = os.environ.get("OKF_API_HOST", "127.0.0.1")
    if host not in {"127.0.0.1", "localhost", "::1"}:
        raise SystemExit("OKF_API_HOST must remain a loopback address")
    port = int(os.environ.get("OKF_API_PORT", "8765"))
    app = create_app()
    if args.exit_on_stdin_close:
        run_plugin_owned_server(app, host=host, port=port, owner_stream=sys.stdin.buffer)
    else:
        uvicorn.run(app, host=host, port=port, log_level="info")
    if log_stream is not None:
        log_stream.flush()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

"""Reuse the proven V1 SSH lifecycle around the shared MinerU service."""

from __future__ import annotations

import sys
from collections.abc import Generator
from contextlib import contextmanager
from urllib.parse import urlsplit

from .clients import MinerUClient
from .config import ImportSettings
from .ssh_transport import SSHConfig, SSHLeaseError, SSHTransport, SSHTransportError


def _health(client: MinerUClient) -> bool:
    try:
        return client.client.get(f"{client.base_url}/health", timeout=5.0).status_code == 200
    except Exception:
        return False


@contextmanager
def managed_mineru_client(settings: ImportSettings) -> Generator[MinerUClient]:
    """Own one remote lease, server lifecycle, and loopback SSH tunnel."""

    parsed = urlsplit(settings.mineru_url)
    if parsed.hostname not in {"127.0.0.1", "localhost", "::1"}:
        raise ValueError("managed MinerU SSH requires a loopback MinerU URL")
    local_port = parsed.port
    if local_port is None:
        raise ValueError("managed MinerU SSH requires an explicit local port")
    transport = SSHTransport(
        SSHConfig(
            host=settings.mineru_ssh_host,
            local_port=local_port,
            remote_port=settings.mineru_ssh_remote_port,
        )
    )
    with transport.acquire_lease(timeout=30) as lease:
        status = transport.status_server(timeout=30)
        was_healthy = "api=healthy" in status.stdout.splitlines()
        started_here = False
        if not was_healthy:
            started = transport.start_server()
            started_here = "is already running" not in started.stdout

        client = MinerUClient(settings.mineru_url)
        completed = False
        try:
            with transport.open_tunnel(
                health_probe=lambda: _health(client),
                timeout=60,
            ):
                yield client
                if not lease.is_running:
                    raise SSHLeaseError("the remote MinerU lease was lost during conversion")
                completed = True
        finally:
            client.close()
            if started_here:
                active_error = sys.exc_info()[1]
                try:
                    if not lease.is_running:
                        raise SSHLeaseError(
                            "remote lease was lost; refusing to stop an unowned service"
                        )
                    transport.stop_server(timeout=90, completed=completed)
                except SSHTransportError as stop_error:
                    if active_error is None:
                        raise
                    active_error.add_note(
                        f"Additionally, the MinerU server could not be stopped: {stop_error}"
                    )

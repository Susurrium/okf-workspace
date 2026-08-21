"""Force this single-GPU deployment's PyTorch rendezvous store onto loopback.

PyTorch's default TCPStore server binds a wildcard socket even when the
rendezvous URL names 127.0.0.1.  PyTorch 2.9 exposes ``master_listen_fd`` for
exactly pre-bound sockets, but ``init_process_group`` does not surface it.  The
small, fail-closed adapter below replaces only PyTorch's private store factory;
all collective and process-group behaviour remains PyTorch's own.
"""

from __future__ import annotations

import importlib
import os
import socket
from datetime import timedelta
from typing import Any


def _install_loopback_tcpstore_guard() -> None:
    import torch.distributed as dist

    rendezvous = importlib.import_module("torch.distributed.rendezvous")

    def _loopback_c10d_store(
        hostname: str,
        port: int,
        rank: int,
        world_size: int,
        timeout: timedelta,
        use_libuv: bool = True,
    ) -> Any:
        del use_libuv
        if hostname not in {"127.0.0.1", "localhost"}:
            raise RuntimeError(f"refusing non-loopback PyTorch rendezvous host: {hostname}")
        if rank != 0 or world_size != 1:
            raise RuntimeError(
                "this MinerU TCPStore guard permits only rank=0, world_size=1; "
                f"received rank={rank}, world_size={world_size}"
            )
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            listener.bind(("127.0.0.1", port))
            descriptor = listener.detach()
            try:
                return dist.TCPStore(
                    host_name="127.0.0.1",
                    port=port,
                    world_size=world_size,
                    is_master=True,
                    timeout=timeout,
                    multi_tenant=True,
                    master_listen_fd=descriptor,
                    use_libuv=False,
                )
            except BaseException:
                os.close(descriptor)
                raise
        finally:
            listener.close()

    rendezvous._create_c10d_store = _loopback_c10d_store
    rendezvous._mineru_loopback_tcpstore_guard = True


if os.environ.get("MINERU_LOOPBACK_TCPSTORE") == "1":
    try:
        _install_loopback_tcpstore_guard()
    except BaseException as error:
        # CPython's site module catches ordinary Exceptions from sitecustomize
        # and continues.  SystemExit deliberately makes a failed security
        # adapter fatal before MinerU or vLLM can open a rendezvous listener.
        raise SystemExit(f"could not install MinerU loopback TCPStore guard: {error}") from error

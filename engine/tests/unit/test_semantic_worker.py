from __future__ import annotations

import os
import threading

from okf_workspace.semantic.worker import stop_when_stdin_closes


def test_semantic_worker_stops_when_api_owner_pipe_closes() -> None:
    stopped = threading.Event()

    read_fd, write_fd = os.pipe()
    os.close(write_fd)
    with os.fdopen(read_fd, "rb") as stream:
        stop_when_stdin_closes(stopped, stream)

    assert stopped.is_set()

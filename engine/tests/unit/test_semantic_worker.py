from __future__ import annotations

import io
import threading

from okf_workspace.semantic.worker import stop_when_stdin_closes


def test_semantic_worker_stops_when_api_owner_pipe_closes() -> None:
    stopped = threading.Event()

    stop_when_stdin_closes(stopped, io.BytesIO())

    assert stopped.is_set()

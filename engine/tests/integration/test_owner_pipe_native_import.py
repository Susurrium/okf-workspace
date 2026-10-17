from __future__ import annotations

import importlib.util
import queue
import subprocess
import sys
import threading
from pathlib import Path

import pytest


@pytest.mark.skipif(importlib.util.find_spec("numpy") is None, reason="requires vector extra")
@pytest.mark.parametrize("owner", ["api", "semantic"])
def test_owner_pipe_allows_native_import_and_stops_on_eof(tmp_path: Path, owner: str) -> None:
    script = tmp_path / "owner_pipe.py"
    script.write_text(
        """
import sys
import threading
import time
import uvicorn
from okf_workspace.server import stop_when_stdin_closes as stop_api
from okf_workspace.semantic.worker import stop_when_stdin_closes as stop_semantic

stopped = threading.Event()
server = uvicorn.Server(uvicorn.Config('unused:app'))
callback, target = (stop_api, server) if sys.argv[1] == 'api' else (stop_semantic, stopped)
watcher = threading.Thread(target=callback, args=(target, sys.stdin.buffer), daemon=True)
watcher.start()
time.sleep(0.2)
assert watcher.is_alive(), 'data must not be treated as owner EOF'
import numpy
print('native import ready', flush=True)
watcher.join(10)
assert not watcher.is_alive(), 'owner EOF did not stop the watcher'
assert server.should_exit if sys.argv[1] == 'api' else stopped.is_set()
print('owner closed', flush=True)
""",
        encoding="utf-8",
    )
    process = subprocess.Popen(
        [sys.executable, str(script), owner],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    assert process.stdin is not None
    assert process.stdout is not None
    process.stdin.write("owner remains active\n")
    process.stdin.flush()
    output = process.stdout
    messages: queue.Queue[str] = queue.Queue()
    reader = threading.Thread(target=lambda: messages.put(output.readline()), daemon=True)
    reader.start()
    try:
        try:
            first = messages.get(timeout=15)
        except queue.Empty:
            pytest.fail("native import blocked while the owner pipe remained open")
        assert first.strip() == "native import ready"
        process.stdin.close()
        process.stdin = None
        stdout, stderr = process.communicate(timeout=15)
        assert process.returncode == 0, stderr
        assert "owner closed" in stdout
    finally:
        if process.stdin is not None:
            process.stdin.close()
            process.stdin = None
        try:
            process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.communicate(timeout=5)
        reader.join(timeout=5)

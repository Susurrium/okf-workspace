from __future__ import annotations

import os
import time
from typing import BinaryIO

if os.name == "nt":
    import _winapi
    import msvcrt


def wait_for_owner_pipe_eof(stream: BinaryIO) -> None:
    if os.name != "nt":
        stream.read()
        return

    handle = msvcrt.get_osfhandle(stream.fileno())
    # Windows 上阻塞读取 stdin 会阻止 NumPy 等原生 DLL 加载；仅在已有数据时读取。
    while True:
        try:
            available = _winapi.PeekNamedPipe(handle, 1)[-2]
            if available:
                _winapi.ReadFile(handle, min(available, 65536))
            else:
                time.sleep(0.05)
        except OSError as exc:
            if exc.winerror in {109, 232}:
                return
            raise

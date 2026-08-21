from __future__ import annotations

import io
import json
import sys
from pathlib import Path
from typing import cast

import pytest

from okf_workspace import server


def test_server_rejects_non_loopback_binding(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OKF_API_HOST", "0.0.0.0")

    with pytest.raises(SystemExit, match="loopback"):
        server.main([])


def test_server_starts_only_on_configured_loopback(monkeypatch: pytest.MonkeyPatch) -> None:
    called: dict[str, object] = {}
    monkeypatch.setenv("OKF_API_HOST", "127.0.0.1")
    monkeypatch.setenv("OKF_API_PORT", "8877")
    monkeypatch.setattr(server, "create_app", lambda: "app")

    def run(app: object, **options: object) -> None:
        called.update({"app": app, **options})

    monkeypatch.setattr(server.uvicorn, "run", run)

    assert server.main([]) == 0
    assert called["host"] == "127.0.0.1"
    assert called["port"] == 8877


def test_server_applies_ai_and_service_deployment_config(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    config = tmp_path / "deployment.json"
    config.write_text(
        json.dumps(
            {
                "vault": str(tmp_path / "vault"),
                "originals": str(tmp_path / "originals"),
                "state": str(tmp_path / "state"),
                "api_port": 8899,
                "mineru_url": "http://127.0.0.1:18000",
                "markitdown_url": "https://markitdown.example.test",
                "markitdown_token_file": str(tmp_path / "markitdown-token"),
                "ai_mode": "codex",
                "codex_command": str(tmp_path / "codex.cmd"),
                "codex_model": "",
                "ai_base_url": "https://ai.example.test/v1",
                "ai_model": "example-model",
                "ai_api_key_file": str(tmp_path / "ai-key"),
                "livesync_required": False,
            }
        ),
        encoding="utf-8",
    )
    called: dict[str, object] = {}
    monkeypatch.setenv("OKF_API_HOST", "127.0.0.1")
    monkeypatch.setattr(server, "create_app", lambda: "app")

    def run(app: object, **options: object) -> None:
        called.update({"app": app, **options})

    monkeypatch.setattr(server.uvicorn, "run", run)

    assert server.main(["--config", str(config)]) == 0
    assert called["port"] == 8899
    assert server.os.environ["OKF_AI_MODEL"] == "example-model"
    assert server.os.environ["OKF_AI_API_KEY_FILE"].endswith("ai-key")
    assert server.os.environ["OKF_AI_MODE"] == "codex"
    assert server.os.environ["OKF_CODEX_COMMAND"].endswith("codex.cmd")
    assert server.os.environ["OKF_LIVESYNC_REQUIRED"] == "False"


def test_server_log_directory_is_bounded(tmp_path: Path) -> None:
    original_stdout = sys.stdout
    original_stderr = sys.stderr
    stream = None
    try:
        for index in range(14):
            path = tmp_path / f"local-api-20260817-{index:06d}.log"
            path.write_text(str(index), encoding="utf-8")
        stream = server.redirect_bounded_logs(tmp_path, keep=12)
        stream.write("started\n")
        stream.flush()
    finally:
        sys.stdout = original_stdout
        sys.stderr = original_stderr
        if stream is not None:
            stream.close()
    assert len(list(tmp_path.glob("local-api-*.log"))) == 12


def test_plugin_owned_server_stops_when_owner_pipe_closes() -> None:
    class FakeServer:
        should_exit = False

    fake = FakeServer()
    server.stop_when_stdin_closes(
        cast(server.uvicorn.Server, fake),
        io.BytesIO(),
    )

    assert fake.should_exit

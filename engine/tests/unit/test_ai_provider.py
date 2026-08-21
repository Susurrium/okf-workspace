from __future__ import annotations

import subprocess
from pathlib import Path
from typing import cast

import pytest

from okf_workspace.ai.provider import AISettings, CodexExecProvider, CodexSettings


def test_ai_settings_reads_key_from_vault_external_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    key_file = tmp_path / "ai-key"
    key_file.write_text("secret-value\n", encoding="utf-8")
    monkeypatch.setenv("OKF_AI_BASE_URL", "https://ai.example.test/v1")
    monkeypatch.setenv("OKF_AI_MODEL", "example-model")
    monkeypatch.setenv("OKF_AI_API_KEY_FILE", str(key_file))
    monkeypatch.delenv("OKF_AI_API_KEY", raising=False)

    settings = AISettings.from_env()

    assert settings.base_url == "https://ai.example.test/v1"
    assert settings.model == "example-model"
    assert settings.api_key == "secret-value"


def test_ai_settings_fails_clearly_when_provider_is_not_configured(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    for name in (
        "OKF_AI_BASE_URL",
        "OKF_AI_MODEL",
        "OKF_AI_API_KEY",
        "OKF_AI_API_KEY_FILE",
    ):
        monkeypatch.delenv(name, raising=False)

    with pytest.raises(RuntimeError, match="AI is not configured"):
        AISettings.from_env()


def test_codex_provider_uses_subscription_cli_without_file_permissions(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    def run(command: list[str], **options: object) -> subprocess.CompletedProcess[str]:
        captured.update({"command": command, **options})
        return subprocess.CompletedProcess(command, 0, stdout="生成结果\n", stderr="")

    monkeypatch.setattr("okf_workspace.ai.provider.subprocess.run", run)
    provider = CodexExecProvider(
        CodexSettings(
            command="codex.cmd",
            working_directory=tmp_path / "codex-runtime",
        )
    )

    assert provider.complete(system="只做摘要", user="正文") == "生成结果"
    command = cast(list[str], captured["command"])
    assert "--ephemeral" in command
    assert command[command.index("--sandbox") + 1] == "read-only"
    assert command[-1] == "-"
    assert "只做摘要" in str(captured["input"])
    assert "正文" in str(captured["input"])

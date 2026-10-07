from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("pwsh") is None,
    reason="Windows and PowerShell required",
)


def _write(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value), encoding="utf-8")


def _quote(path: Path) -> str:
    return "'" + str(path).replace("'", "''") + "'"


def _fixture(tmp_path: Path, role: str = "test", port: int = 34876) -> tuple[Path, Path]:
    vault, state = tmp_path / "vault", tmp_path / "state"
    config = state / "config/deployment.json"
    deployment = {
        "installation_id": "fixture-installation", "vault": str(vault),
        "state": str(state), "api_port": port,
    }
    _write(config, deployment)
    _write(state / "config/test-environment.json", {**deployment, "environment": role})
    settings = vault / ".obsidian/plugins/okf-workspace-dashboard/data.json"
    _write(settings, {
        "deploymentConfig": str(config), "tokenFile": str(state / "secrets/local-api-token"),
        "baseUrl": f"http://127.0.0.1:{port}", "manageLocalService": True,
        "user_preference": "preserve-me",
    })
    _write(vault / ".obsidian/community-plugins.json", [
        "okf-workspace-dashboard", "obsidian-livesync", "unrelated-plugin",
    ])
    _write(tmp_path / "appdata/obsidian/obsidian.json", {"vaults": {}})
    return config, settings


def _run(tmp_path: Path, config: Path, action: str = "Stop") -> subprocess.CompletedProcess[str]:
    command = (
        f"$env:APPDATA={_quote(tmp_path / 'appdata')};"
        f"& {_quote(ROOT / 'scripts/test-workspace.ps1')} "
        f"-Config {_quote(config)} -Action {action}"
    )
    return subprocess.run(
        ["pwsh", "-NoProfile", "-Command", command], capture_output=True,
        text=True, encoding="utf-8", errors="replace", timeout=20, check=False,
    )


@pytest.mark.parametrize(("role", "port"), [("production", 34876), ("test", 8765)])
def test_production_target_rejected_before_settings_change(
    tmp_path: Path, role: str, port: int,
) -> None:
    config, settings = _fixture(tmp_path, role, port)
    before = settings.read_bytes()
    plugins = settings.parents[2] / "community-plugins.json"
    plugins_before = plugins.read_bytes()
    result = _run(tmp_path, config)
    assert result.returncode != 0
    assert "matching isolated test marker" in result.stderr
    assert settings.read_bytes() == before
    assert plugins.read_bytes() == plugins_before


def test_closed_test_stop_disables_autostart_and_sync_preserving_preferences(
    tmp_path: Path,
) -> None:
    config, settings = _fixture(tmp_path)
    result = _run(tmp_path, config)
    assert result.returncode == 0, result.stdout + result.stderr
    saved = json.loads(settings.read_text(encoding="utf-8-sig"))
    assert saved["manageLocalService"] is False
    assert saved["user_preference"] == "preserve-me"
    plugins = json.loads((settings.parents[2] / "community-plugins.json").read_text(
        encoding="utf-8-sig",
    ))
    assert plugins == ["okf-workspace-dashboard", "unrelated-plugin"]
    before = settings.read_bytes()
    status = _run(tmp_path, config, "Status")
    assert status.returncode == 0, status.stdout + status.stderr
    parsed = json.loads(status.stdout)
    assert parsed["engine_autostart"] is False
    assert parsed["livesync_enabled"] is False
    assert parsed["vault_open"] is False
    assert settings.read_bytes() == before

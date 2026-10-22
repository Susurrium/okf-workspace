from __future__ import annotations

import json
import shutil
import socket
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


def _quote(path: Path | str) -> str:
    return "'" + str(path).replace("'", "''") + "'"


def _fixture(tmp_path: Path, role: str = "test", port: int = 34876) -> tuple[Path, Path]:
    vault, state = tmp_path / "vault", tmp_path / "state"
    config = state / "config/deployment.json"
    deployment = {
        "installation_id": "fixture-installation", "vault": str(vault),
        "state": str(state), "api_port": port,
    }
    _write(config, deployment)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        cdp_port = listener.getsockname()[1]
    _write(state / "config/test-environment.json", {
        **deployment, "environment": role, "cdp_port": cdp_port,
    })
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


@pytest.mark.parametrize("change_identity", [False, True])
def test_stop_persists_disabled_state_after_host_flushes_settings(
    tmp_path: Path, change_identity: bool,
) -> None:
    config, settings = _fixture(tmp_path)
    fake_cdp = tmp_path / "fake-cdp.ps1"
    fake_cdp.write_text(
        f"$settingsPath = {_quote(settings)}\n"
        "$settings = Get-Content -LiteralPath $settingsPath -Raw | ConvertFrom-Json\n"
        "$settings.manageLocalService = $true\n"
        "$settings.user_preference = 'changed-during-shutdown'\n"
        + ("$settings.baseUrl = 'http://127.0.0.1:8765'\n" if change_identity else "")
        +
        "$settings | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $settingsPath\n"
        "$pluginsPath = Join-Path (Split-Path -Parent (Split-Path -Parent "
        "(Split-Path -Parent $settingsPath))) 'community-plugins.json'\n"
        "@('okf-workspace-dashboard', 'obsidian-livesync', 'unrelated-plugin', "
        "'new-user-plugin') | ConvertTo-Json | Set-Content -LiteralPath $pluginsPath\n"
        "$global:LASTEXITCODE = 0\n"
        "Write-Output 'true'\n",
        encoding="utf-8",
    )
    commands = tmp_path / "host-commands.ps1"
    profile = tmp_path / "state/obsidian-profile"
    # 仅隔离 Obsidian/CDP 和进程查询边界，实际控制脚本负责读写测试配置。
    commands.write_text(
        "function Get-CimInstance { param($Filter)\n"
        "[pscustomobject]@{ProcessId=12345; CommandLine="
        + _quote(f'Obsidian.exe --user-data-dir="{profile}"') + "}\n}\n"
        "function Get-NetTCPConnection { param($LocalPort, $State, $ErrorAction) }\n"
        "function Get-Process { param($Id, $ErrorAction) }\n"
        "function Get-Command { param($Name, $ErrorAction)\n"
        f"if ($Name -eq 'node') {{ [pscustomobject]@{{Source={_quote(fake_cdp)}}} }}\n"
        "else { Microsoft.PowerShell.Core\\Get-Command $Name -ErrorAction $ErrorAction }\n}\n",
        encoding="utf-8",
    )
    command = (
        f"$env:APPDATA={_quote(tmp_path / 'appdata')};"
        f". {_quote(commands)};"
        f"& {_quote(ROOT / 'scripts/test-workspace.ps1')} -Config {_quote(config)} -Action Stop"
    )
    result = subprocess.run(
        ["pwsh", "-NoProfile", "-Command", command], capture_output=True,
        text=True, encoding="utf-8", errors="replace", timeout=20, check=False,
    )
    saved = json.loads(settings.read_text(encoding="utf-8-sig"))
    if change_identity:
        assert result.returncode != 0
        assert "identity changed during shutdown" in result.stderr
        assert saved["baseUrl"] == "http://127.0.0.1:8765"
        assert saved["manageLocalService"] is True
        assert saved["user_preference"] == "changed-during-shutdown"
        return
    assert result.returncode == 0, result.stdout + result.stderr
    assert saved["manageLocalService"] is False
    assert saved["user_preference"] == "changed-during-shutdown"
    plugins = json.loads((settings.parents[2] / "community-plugins.json").read_text(
        encoding="utf-8-sig",
    ))
    assert plugins == ["okf-workspace-dashboard", "unrelated-plugin", "new-user-plugin"]


@pytest.mark.parametrize("registry_kind", ["test-profile", "default-profile"])
def test_mixed_or_concurrent_profiles_rejected_before_writes(
    tmp_path: Path, registry_kind: str,
) -> None:
    config, settings = _fixture(tmp_path)
    deployment = json.loads(config.read_text(encoding="utf-8"))
    if registry_kind == "test-profile":
        registry = tmp_path / "state/obsidian-profile/obsidian.json"
        vault = tmp_path / "production"
    else:
        registry = tmp_path / "appdata/obsidian/obsidian.json"
        vault = Path(deployment["vault"])
    _write(registry, {"vaults": {"other": {"path": str(vault), "open": True}}})
    before = settings.read_bytes()
    registry_before = registry.read_bytes()
    result = _run(tmp_path, config, "Start")
    assert result.returncode != 0
    assert "profile" in result.stderr
    assert settings.read_bytes() == before
    assert registry.read_bytes() == registry_before


@pytest.mark.parametrize("field", ["installation_id", "vault", "state", "api_port"])
def test_mismatched_test_identity_rejected_before_writes(tmp_path: Path, field: str) -> None:
    config, settings = _fixture(tmp_path)
    marker_path = config.parent / "test-environment.json"
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    marker[field] = 34877 if field == "api_port" else "different"
    _write(marker_path, marker)
    before = settings.read_bytes()
    result = _run(tmp_path, config)
    assert result.returncode != 0
    assert settings.read_bytes() == before


@pytest.mark.parametrize(
    "script", ["install-dashboard", "install-okf-claudian", "update-test-workspace"],
)
def test_development_install_rejects_production_before_build(
    tmp_path: Path, script: str,
) -> None:
    config, settings = _fixture(tmp_path, role="production", port=8765)
    _write(settings.parents[0] / "manifest.json", {"id": "okf-workspace-dashboard"})
    before = settings.read_bytes()
    command = (
        f"& {_quote(ROOT / f'scripts/{script}.ps1')} "
        f"-Vault {_quote(tmp_path / 'vault')} -State {_quote(tmp_path / 'state')}"
    )
    result = subprocess.run(
        ["pwsh", "-NoProfile", "-Command", command], capture_output=True,
        text=True, encoding="utf-8", errors="replace", timeout=20, check=False,
    )
    assert result.returncode != 0
    assert "matching isolated test marker" in result.stderr
    assert settings.read_bytes() == before
    assert config.exists()

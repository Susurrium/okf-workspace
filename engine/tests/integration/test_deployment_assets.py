# pyright: reportUnknownMemberType=false, reportUnknownVariableType=false

from __future__ import annotations

import json
import shutil
import subprocess
from pathlib import Path

import pytest
from ruamel.yaml import YAML


def _powershell_quote(value: Path | str) -> str:
    return "'" + str(value).replace("'", "''") + "'"


def _run_powershell(command: str) -> subprocess.CompletedProcess[str]:
    # Match error messages independently of terminal colors and concise-view wrapping.
    plain_command = "$PSStyle.OutputRendering='PlainText';$ErrorView='NormalView';" + command
    return subprocess.run(
        ["pwsh", "-NoProfile", "-Command", plain_command],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def _available_powershells() -> tuple[str, ...]:
    return tuple(
        executable
        for executable in ("powershell.exe", "pwsh")
        if shutil.which(executable) is not None
    )


def _write_claudian_build(source: Path) -> None:
    source.mkdir()
    (source / "main.js").write_text("// compiled\n", encoding="utf-8")
    (source / "styles.css").write_text("/* compiled */\n", encoding="utf-8")
    (source / "manifest.json").write_text(
        json.dumps({"id": "okf-claudian", "version": "test"}), encoding="utf-8"
    )


def _install_claudian(
    root: Path,
    vault: Path,
    source: Path,
) -> subprocess.CompletedProcess[str]:
    state = vault.parent / "test-state"
    config = state / "config/deployment.json"
    config.parent.mkdir(parents=True, exist_ok=True)
    deployment = {"vault": str(vault), "state": str(state), "api_port": 34876,
                  "installation_id": "claudian-test-installation"}
    config.write_text(json.dumps(deployment), encoding="utf-8")
    (config.parent / "test-environment.json").write_text(
        json.dumps({**deployment, "environment": "test"}), encoding="utf-8",
    )
    return subprocess.run(
        [
            "pwsh",
            "-NoProfile",
            "-File",
            str(root / "scripts" / "install-okf-claudian.ps1"),
            "-Vault",
            str(vault),
            "-State",
            str(state),
            "-ClaudianRepository",
            str(source),
            "-SkipBuild",
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def test_windows_scripts_parse_and_server_compose_contains_no_committed_secrets() -> None:
    root = Path(__file__).parents[3]
    scripts = sorted((root / "deploy" / "windows").glob("*.ps1")) + sorted(
        (root / "scripts").glob("*.ps1")
    )
    script_paths = ",".join(f"'{str(path).replace(chr(39), chr(39) * 2)}'" for path in scripts)
    command = (
        f"$scriptPaths=@({script_paths});"
        "$failed=$false;"
        "$scriptPaths | ForEach-Object {"
        "$tokens=$null;$errors=$null;"
        "[System.Management.Automation.Language.Parser]::ParseFile("
        "$_,[ref]$tokens,[ref]$errors)|Out-Null;"
        "if($errors.Count){$failed=$true;$errors|ForEach-Object Message}};"
        "if($failed){exit 1}"
    )
    for executable in _available_powershells():
        completed = subprocess.run(
            [executable, "-NoProfile", "-Command", command],
            check=False,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        assert completed.returncode == 0, f"{executable}: {completed.stderr or completed.stdout}"

    yaml = YAML(typ="safe")
    compose = yaml.load((root / "deploy" / "server" / "compose.yml").read_text(encoding="utf-8"))
    assert "couchdb" in compose["services"]
    assert "caddy" in compose["services"]
    assert "5984:5984" not in json.dumps(compose)
    assert not (root / "deploy" / "server" / "secrets" / "couchdb.env").exists()


@pytest.mark.skipif(shutil.which("pwsh") is None, reason="PowerShell 7 is required")
def test_deployment_receipt_verifies_real_artifact_layout_and_rejects_mismatch(
    tmp_path: Path,
) -> None:
    root = Path(__file__).parents[3]
    repository = tmp_path / "repository"
    for relative in ("scripts/record-deployment.ps1", "deploy/windows/common.ps1"):
        target = repository / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / relative, target)
    vault = tmp_path / "vault"
    state = tmp_path / "state"
    for component, plugin_id in (
        ("dashboard", "okf-workspace-dashboard"),
        ("claudian", "okf-claudian"),
    ):
        for name in ("main.js", "styles.css", "manifest.json"):
            build = repository / component / name
            if component == "dashboard" and name != "manifest.json":
                build = repository / component / "dist" / name
            build.parent.mkdir(parents=True, exist_ok=True)
            build.write_text(f"{component}/{name}\n", encoding="utf-8")
            installed = vault / ".obsidian/plugins" / plugin_id / name
            installed.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(build, installed)
    (repository / "dashboard/styles.css").write_text("unbundled styles\n", encoding="utf-8")
    (repository / "dashboard/dist/manifest.json").write_text(
        "copied manifest decoy\n", encoding="utf-8"
    )
    engine_file = repository / "engine/src/okf_workspace/__init__.py"
    engine_file.parent.mkdir(parents=True)
    engine_file.write_text('__version__ = "test"\n', encoding="utf-8")
    (repository / "release-manifest.yaml").write_text("release: test\n", encoding="utf-8")
    for arguments in (
        ["init"],
        ["add", "."],
        [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "-c",
            "commit.gpgsign=false",
            "commit",
            "-m",
            "fixture",
        ],
    ):
        subprocess.run(["git", "-C", str(repository), *arguments], check=True, capture_output=True)
    config = tmp_path / "deployment.json"
    config.write_text(json.dumps({"vault": str(vault), "state": str(state)}), encoding="utf-8")
    command = (
        f"& {_powershell_quote(repository / 'scripts/record-deployment.ps1')} "
        f"-Config {_powershell_quote(config)}"
    )
    completed = _run_powershell(command)
    assert completed.returncode == 0, completed.stderr or completed.stdout
    receipt_path = state / "reports/deployment-receipt.json"
    receipt_bytes = receipt_path.read_bytes()
    receipt = json.loads(receipt_bytes)
    assert len(receipt["installed_plugin_sha256"]) == 6
    assert "okf_workspace/__init__.py" in receipt["engine_source_sha256"]
    assert receipt["tracked_worktree_dirty"] is False

    for name in ("main.js", "manifest.json", "styles.css"):
        installed = vault / ".obsidian/plugins/okf-workspace-dashboard" / name
        original = installed.read_bytes()
        installed.write_text("stale installed build\n", encoding="utf-8")
        rejected = _run_powershell(command)
        assert rejected.returncode != 0
        assert f"Installed artifact differs from build: okf-workspace-dashboard/{name}" in (
            rejected.stderr
        )
        assert receipt_path.read_bytes() == receipt_bytes
        installed.write_bytes(original)


@pytest.mark.parametrize("executable", _available_powershells())
def test_json_hashtable_reader_is_recursive_and_cross_version(
    tmp_path: Path,
    executable: str,
) -> None:
    root = Path(__file__).parents[3]
    common = root / "deploy" / "windows" / "common.ps1"
    payload = tmp_path / "nested.json"
    payload.write_text(
        json.dumps(
            {
                "nested": {
                    "items": [
                        {"name": "中文"},
                        [],
                        None,
                    ]
                }
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    command = (
        f". {_powershell_quote(common)}; "
        f"$data=Read-OkfJsonHashtable -Path {_powershell_quote(payload)}; "
        "if($data -isnot [hashtable]){throw 'root is not a hashtable'}; "
        "if($data['nested'] -isnot [hashtable]){throw 'nested object is not a hashtable'}; "
        "if($data['nested']['items'] -isnot [object[]]){throw 'items is not an array'}; "
        "if($data['nested']['items'][0] -isnot [hashtable]){"
        "throw 'array object is not a hashtable'}; "
        "if($data['nested']['items'][0]['name'] -cne '中文'){throw 'unicode changed'}; "
        "if($data['nested']['items'][1].Count -ne 0){throw 'empty array changed'}; "
        "if($null -ne $data['nested']['items'][2]){throw 'null changed'}"
    )
    completed = subprocess.run(
        [executable, "-NoProfile", "-Command", command],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert completed.returncode == 0, completed.stderr or completed.stdout

    scripts = list((root / "deploy" / "windows").glob("*.ps1")) + list(
        (root / "scripts").glob("*.ps1")
    )
    assert all(
        "ConvertFrom-Json -AsHashtable" not in path.read_text(encoding="utf-8") for path in scripts
    )


def test_dashboard_persists_only_external_token_file_path() -> None:
    root = Path(__file__).parents[3]
    settings = (root / "dashboard" / "src" / "plugin" / "settings.ts").read_text(encoding="utf-8")
    plugin = (root / "dashboard" / "src" / "plugin" / "main.ts").read_text(encoding="utf-8")
    manifest = json.loads((root / "dashboard" / "manifest.json").read_text(encoding="utf-8"))
    installer = (root / "deploy" / "windows" / "install.ps1").read_text(encoding="utf-8")
    quick_installer = (root / "scripts" / "install-dashboard.ps1").read_text(encoding="utf-8")
    claudian_installer = (root / "scripts" / "install-okf-claudian.ps1").read_text(encoding="utf-8")
    uninstaller = (root / "deploy" / "windows" / "uninstall.ps1").read_text(encoding="utf-8")

    assert "tokenFile" in settings
    assert "readFileSync" in plugin
    assert "token: this.settings.token" not in plugin
    assert "$pluginData.Remove('token')" in installer
    assert "feedReadingPositions" not in installer
    assert "Read-OkfJsonHashtable -Path $pluginDataPath" in installer
    assert "ConvertFrom-Json -AsHashtable" not in installer
    assert installer.index("Read-OkfJsonHashtable -Path $pluginDataPath") < installer.index(
        "Install-OkfDashboardPluginAtomic"
    )
    assert installer.index("Get-OkfDashboardPluginMigrationPlan") < installer.index(
        "Install-OkfDashboardPluginAtomic"
    )
    assert "Write-OkfJson -Path $pluginDataPath -Value $pluginData" in installer
    assert "$PSBoundParameters.ContainsKey('MinerUTokenFile')" in installer
    assert "mineru_token_file" in installer
    assert "$PSBoundParameters.ContainsKey('SkipVectorIndex')" in installer
    assert "$PSBoundParameters.ContainsKey('EnableBackupSetup')" in installer
    assert "$SkipVectorIndex = -not [bool]$existingConfig.enable_vectors" in installer
    assert "$EnableBackupSetup = $true" in installer
    assert "$PSBoundParameters.ContainsKey('AIBaseUrl')" in installer
    assert "$PSBoundParameters.ContainsKey('AIModel')" in installer
    assert "$PSBoundParameters.ContainsKey('AIApiKeyFile')" in installer
    assert "[ValidateSet('codex', 'provider')]" in installer
    assert "codex_command" in installer
    assert "livesync_required" in installer
    assert "pythonExecutable" in installer
    assert "deploymentConfig" in installer
    assert "serviceLogDirectory" in installer
    assert "$obsidianAppSettings['propertiesInDocument'] = 'visible'" in installer
    assert "$obsidianAppSettings['propertiesInDocument'] = 'hidden'" not in installer
    assert "Register-ScheduledTask -TaskName 'OKF Brain Local Service'" not in installer
    assert "Unregister-ScheduledTask -TaskName 'OKF Brain Local Service'" in installer
    for field in ("baseUrl", "tokenFile", "deploymentConfig", "serviceLogDirectory"):
        assert f"$data['{field}'] =" in quick_installer
    assert "$data.Remove('token')" in quick_installer
    assert quick_installer.index("Assert-OkfTestEnvironment") < quick_installer.index(
        "build-dashboard.ps1"
    )
    assert quick_installer.index("Read-OkfJsonHashtable -Path $dataPath") < (
        quick_installer.index("Install-OkfDashboardPluginAtomic")
    )
    assert quick_installer.index("Get-OkfDashboardPluginMigrationPlan") < (
        quick_installer.index("Install-OkfDashboardPluginAtomic")
    )
    assert "$PSCmdlet.ShouldProcess($task, 'Stop and unregister scheduled task')" in uninstaller
    assert "System32\\WindowsPowerShell\\v1.0\\powershell.exe" in installer
    assert "-NonInteractive -WindowStyle Hidden" in installer
    assert "realclaudian" not in claudian_installer
    assert "realclaudian" not in uninstaller
    assert "foreach ($legacyId in @('claudian'))" in claudian_installer
    assert "-AllowedManifestIds @('okf-claudian')" in claudian_installer
    assert "if ($ownedLegacyClaudian) { $removedPluginIds += 'claudian' }" in uninstaller
    assert manifest["isDesktopOnly"] is False


def test_windows_installers_enforce_safe_idempotent_boundaries() -> None:
    root = Path(__file__).parents[3]
    installer = (root / "deploy" / "windows" / "install.ps1").read_text(encoding="utf-8")
    uninstaller = (root / "deploy" / "windows" / "uninstall.ps1").read_text(encoding="utf-8")

    assert installer.index("Assert-OkfDataPathLayout") < installer.index(
        "New-Item -ItemType Directory -Force -Path $vaultPath"
    )
    assert "installation_id = $installationId" in installer
    assert "Write-OkfOwnershipMarker -Target $vaultPath" in installer
    assert "Write-OkfOwnershipMarker -Target $originalsPath" in installer
    assert "Write-OkfOwnershipMarker -Target $statePath" in installer
    assert "Install-OkfPluginAtomic" in installer
    assert "-ExpectedId 'obsidian-livesync'" in installer
    assert "$recommendedPlugins" not in installer

    validation_end = uninstaller.index("foreach ($task in @(")
    assert uninstaller.index("Assert-OkfDataPathLayout") < validation_end
    assert uninstaller.index("Assert-OkfOwnershipMarker") < validation_end
    assert "$dataParent" not in uninstaller
    assert "$PSCmdlet.ShouldProcess($targetSummary, 'Remove all validated OKF Workspace data')" in (
        uninstaller
    )


def test_data_path_layout_rejects_roots_repository_and_nesting(tmp_path: Path) -> None:
    root = Path(__file__).parents[3]
    common = root / "deploy" / "windows" / "common.ps1"
    vault = tmp_path / "vault"
    originals = tmp_path / "originals"
    state = tmp_path / "state"
    repository = tmp_path / "repo"
    prefix = f". {_powershell_quote(common)}; "

    valid = _run_powershell(
        prefix
        + "Assert-OkfDataPathLayout "
        + f"-Vault {_powershell_quote(vault)} "
        + f"-Originals {_powershell_quote(originals)} "
        + f"-State {_powershell_quote(state)} "
        + f"-RepositoryRoot {_powershell_quote(repository)} | Out-Null"
    )
    assert valid.returncode == 0, valid.stderr or valid.stdout

    invalid_layouts = (
        (vault, vault / "nested", state, repository),
        (repository, originals, state, repository),
        (Path(tmp_path.anchor), originals, state, repository),
    )
    for invalid_vault, invalid_originals, invalid_state, invalid_repository in invalid_layouts:
        rejected = _run_powershell(
            prefix
            + "Assert-OkfDataPathLayout "
            + f"-Vault {_powershell_quote(invalid_vault)} "
            + f"-Originals {_powershell_quote(invalid_originals)} "
            + f"-State {_powershell_quote(invalid_state)} "
            + f"-RepositoryRoot {_powershell_quote(invalid_repository)} | Out-Null"
        )
        assert rejected.returncode != 0


def test_livesync_atomic_install_preflights_and_preserves_plugin_data(tmp_path: Path) -> None:
    root = Path(__file__).parents[3]
    common = root / "deploy" / "windows" / "common.ps1"
    source = tmp_path / "source"
    target = tmp_path / "plugins" / "obsidian-livesync"
    source.mkdir()
    target.mkdir(parents=True)
    (target / "main.js").write_text("old", encoding="utf-8")
    (target / "data.json").write_text('{"keep": true}', encoding="utf-8")
    (source / "main.js").write_text("new", encoding="utf-8")
    (source / "manifest.json").write_text(
        '{"id": "obsidian-livesync", "version": "1.0.0"}', encoding="utf-8"
    )

    command = (
        f". {_powershell_quote(common)}; "
        "Install-OkfPluginAtomic "
        f"-Source {_powershell_quote(source)} "
        f"-Target {_powershell_quote(target)} "
        "-ExpectedId 'obsidian-livesync' | Out-Null"
    )
    missing_file = _run_powershell(command)
    assert missing_file.returncode != 0
    assert (target / "main.js").read_text(encoding="utf-8") == "old"

    (source / "styles.css").write_text("css", encoding="utf-8")
    installed = _run_powershell(command)
    assert installed.returncode == 0, installed.stderr or installed.stdout
    assert (target / "main.js").read_text(encoding="utf-8") == "new"
    assert (target / "data.json").read_text(encoding="utf-8") == '{"keep": true}'


def test_uninstall_validates_every_owned_path_before_mutating(tmp_path: Path) -> None:
    root = Path(__file__).parents[3]
    uninstaller = root / "deploy" / "windows" / "uninstall.ps1"
    installation_id = "synthetic-installation"
    paths = {
        "vault": tmp_path / "vault-parent" / "vault",
        "originals": tmp_path / "originals-parent" / "originals",
        "state": tmp_path / "state-parent" / "state",
    }
    marker_paths: dict[str, str] = {}
    for role, target in paths.items():
        target.mkdir(parents=True)
        marker = target / ".okf-workspace-owner.json"
        marker.write_text(
            json.dumps(
                {
                    "schema": 1,
                    "product": "okf-workspace",
                    "role": role,
                    "installation_id": installation_id,
                    "path": str(target),
                }
            ),
            encoding="utf-8",
        )
        marker_paths[role] = str(marker)

    config_path = paths["state"] / "config" / "deployment.json"
    config_path.parent.mkdir()
    config_path.write_text(
        json.dumps(
            {
                "installation_id": installation_id,
                "repository_root": str(tmp_path / "repo"),
                **{role: str(path) for role, path in paths.items()},
                "ownership_markers": marker_paths,
            }
        ),
        encoding="utf-8",
    )
    command = (
        "function Get-ScheduledTask { [CmdletBinding()] param([string]$TaskName); $null }; "
        f"& {_powershell_quote(uninstaller)} "
        f"-Config {_powershell_quote(config_path)} -RemoveData -WhatIf"
    )
    different_parents = _run_powershell(command)
    assert different_parents.returncode == 0, different_parents.stderr or different_parents.stdout
    assert all(path.is_dir() for path in paths.values())

    plugin_sentinel = paths["vault"] / ".obsidian" / "plugins" / "okf-workspace-dashboard"
    plugin_sentinel.mkdir(parents=True)
    (plugin_sentinel / "keep.txt").write_text("keep", encoding="utf-8")
    originals_marker = Path(marker_paths["originals"])
    tampered = json.loads(originals_marker.read_text(encoding="utf-8"))
    tampered["installation_id"] = "different-installation"
    originals_marker.write_text(json.dumps(tampered), encoding="utf-8")

    rejected = _run_powershell(
        f"& {_powershell_quote(uninstaller)} -Config {_powershell_quote(config_path)} -RemoveData"
    )
    assert rejected.returncode != 0
    assert (plugin_sentinel / "keep.txt").read_text(encoding="utf-8") == "keep"
    assert all(path.is_dir() for path in paths.values())


def test_uninstall_refuses_unowned_legacy_claudian_before_mutating(tmp_path: Path) -> None:
    root = Path(__file__).parents[3]
    uninstaller = root / "deploy" / "windows" / "uninstall.ps1"
    vault = tmp_path / "vault"
    legacy = vault / ".obsidian" / "plugins" / "claudian"
    legacy.mkdir(parents=True)
    legacy_marker = legacy / "keep.txt"
    legacy_marker.write_text("upstream plugin\n", encoding="utf-8")
    (legacy / "manifest.json").write_text(
        json.dumps({"id": "claudian", "version": "user"}),
        encoding="utf-8",
    )
    official = vault / ".obsidian" / "plugins" / "realclaudian"
    official.mkdir()
    official_marker = official / "keep.txt"
    official_marker.write_text("official plugin\n", encoding="utf-8")
    community_plugins = vault / ".obsidian" / "community-plugins.json"
    community_plugins.write_text(
        json.dumps(["realclaudian", "claudian", "okf-claudian"]),
        encoding="utf-8",
    )
    community_before = community_plugins.read_bytes()
    config = tmp_path / "deployment.json"
    config.write_text(json.dumps({"vault": str(vault)}), encoding="utf-8")

    completed = _run_powershell(
        f"& {_powershell_quote(uninstaller)} -Config {_powershell_quote(config)}"
    )

    assert completed.returncode != 0
    assert "manifest id 'claudian'" in (completed.stderr + completed.stdout)
    assert legacy_marker.read_text(encoding="utf-8") == "upstream plugin\n"
    assert official_marker.read_text(encoding="utf-8") == "official plugin\n"
    assert community_plugins.read_bytes() == community_before


def _install_skills(root: Path, vault: Path) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [
            "pwsh",
            "-NoProfile",
            "-File",
            str(root / "scripts" / "install-skills.ps1"),
            "-Vault",
            str(vault),
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )


def test_quick_dashboard_installer_rejects_a_mistyped_vault_before_build(
    tmp_path: Path,
) -> None:
    root = Path(__file__).parents[3]
    missing_vault = tmp_path / "mistyped-vault"
    completed = subprocess.run(
        [
            "pwsh",
            "-NoProfile",
            "-File",
            str(root / "scripts" / "install-dashboard.ps1"),
            "-Vault",
            str(missing_vault),
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert completed.returncode != 0
    assert "Vault does not exist" in (completed.stderr + completed.stdout)
    assert not missing_vault.exists()


@pytest.mark.parametrize("executable", _available_powershells())
@pytest.mark.parametrize(
    "broken_input",
    ["invalid-dashboard-settings", "non-object-deployment-config"],
)
def test_quick_dashboard_installer_preflights_json_before_replacing_artifacts(
    tmp_path: Path,
    executable: str,
    broken_input: str,
) -> None:
    root = Path(__file__).parents[3]
    vault = tmp_path / "vault"
    target = vault / ".obsidian" / "plugins" / "okf-workspace-dashboard"
    target.mkdir(parents=True)
    artifacts = {
        "main.js": b"old dashboard javascript\n",
        "manifest.json": b'{"id":"okf-workspace-dashboard","version":"old"}\n',
        "styles.css": b"old dashboard css\n",
        "data.json": b'{"keep":"user setting"}\n',
    }
    for name, content in artifacts.items():
        (target / name).write_bytes(content)

    state = tmp_path / "state"
    if broken_input == "invalid-dashboard-settings":
        (target / "data.json").write_text('{"broken"', encoding="utf-8")
        artifacts["data.json"] = (target / "data.json").read_bytes()
    else:
        config = state / "config" / "deployment.json"
        config.parent.mkdir(parents=True)
        config.write_text('[{"api_port": 9999}]', encoding="utf-8")

    completed = subprocess.run(
        [
            executable,
            "-NoProfile",
            "-File",
            str(root / "scripts" / "install-dashboard.ps1"),
            "-Vault",
            str(vault),
            "-State",
            str(state),
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    assert completed.returncode != 0
    assert {name: (target / name).read_bytes() for name in artifacts} == artifacts
    assert not list(target.parent.glob(".okf-workspace-dashboard.stage-*"))
    assert not list(target.parent.glob(".okf-workspace-dashboard.backup-*"))


def test_claudian_installer_preserves_the_official_upstream_plugin(tmp_path: Path) -> None:
    root = Path(__file__).parents[3]
    vault = tmp_path / "vault"
    plugins = vault / ".obsidian" / "plugins"
    upstream = plugins / "realclaudian"
    mistaken_legacy = plugins / "claudian"
    upstream.mkdir(parents=True)
    mistaken_legacy.mkdir()
    upstream_marker = upstream / "keep.txt"
    upstream_marker.write_text("official plugin\n", encoding="utf-8")
    (mistaken_legacy / "remove.txt").write_text("old OKF copy\n", encoding="utf-8")
    (mistaken_legacy / "manifest.json").write_text(
        json.dumps({"id": "okf-claudian", "version": "legacy"}), encoding="utf-8"
    )
    community_plugins = vault / ".obsidian" / "community-plugins.json"
    community_plugins.write_text(
        json.dumps(["realclaudian", "claudian", "another-plugin"]), encoding="utf-8"
    )
    settings_root = vault / ".claudian"
    settings_root.mkdir()
    settings_path = settings_root / "claudian-settings.json"
    settings_path.write_text(
        json.dumps(
            {
                "systemPromptMode": "full",
                "settingsProvider": "codex",
                "providerConfigs": {
                    "claude": {"enabled": True},
                    "codex": {"enabled": True, "safeMode": "read-only"},
                },
            }
        ),
        encoding="utf-8",
    )

    source = tmp_path / "claudian-build"
    _write_claudian_build(source)

    completed = _install_claudian(root, vault, source)
    assert completed.returncode == 0, completed.stderr or completed.stdout
    enabled = json.loads(community_plugins.read_text(encoding="utf-8-sig"))
    assert enabled == ["realclaudian", "another-plugin", "okf-claudian"]
    assert upstream_marker.read_text(encoding="utf-8") == "official plugin\n"
    assert not mistaken_legacy.exists()
    assert (plugins / "okf-claudian" / "manifest.json").is_file()
    preserved_settings = json.loads(settings_path.read_text(encoding="utf-8-sig"))
    assert preserved_settings["systemPromptMode"] == "full"
    assert preserved_settings["providerConfigs"]["claude"]["enabled"] is True
    assert preserved_settings["providerConfigs"]["codex"]["safeMode"] == "read-only"


@pytest.mark.parametrize(
    "legacy_manifest_id",
    [None, "claudian", "user-plugin"],
    ids=["missing-manifest", "upstream-identity", "unrelated-identity"],
)
def test_claudian_installer_rejects_unowned_legacy_before_writing(
    tmp_path: Path,
    legacy_manifest_id: str | None,
) -> None:
    root = Path(__file__).parents[3]
    vault = tmp_path / "vault"
    legacy = vault / ".obsidian" / "plugins" / "claudian"
    legacy.mkdir(parents=True)
    legacy_marker = legacy / "keep.txt"
    legacy_marker.write_text("not owned by OKF\n", encoding="utf-8")
    if legacy_manifest_id is not None:
        (legacy / "manifest.json").write_text(
            json.dumps({"id": legacy_manifest_id, "version": "user"}),
            encoding="utf-8",
        )

    official = vault / ".obsidian" / "plugins" / "realclaudian"
    official.mkdir()
    official_marker = official / "keep.txt"
    official_marker.write_text("official plugin\n", encoding="utf-8")
    community_plugins = vault / ".obsidian" / "community-plugins.json"
    community_plugins.write_text(
        json.dumps(["realclaudian", "claudian", "another-plugin"]),
        encoding="utf-8",
    )
    community_before = community_plugins.read_bytes()

    source = tmp_path / "claudian-build"
    _write_claudian_build(source)
    completed = _install_claudian(root, vault, source)

    assert completed.returncode != 0
    assert "Refusing to remove retired plugin" in (completed.stderr + completed.stdout)
    assert legacy_marker.read_text(encoding="utf-8") == "not owned by OKF\n"
    assert official_marker.read_text(encoding="utf-8") == "official plugin\n"
    assert community_plugins.read_bytes() == community_before
    assert not (vault / ".obsidian" / "plugins" / "okf-claudian").exists()
    assert not (vault / ".claudian").exists()


def test_skill_installer_owns_only_manifested_skills(tmp_path: Path) -> None:
    root = Path(__file__).parents[3]
    vault = tmp_path / "vault"
    vault.mkdir()

    target = vault / ".agents" / "skills"
    user_skill = target / "my-private-skill"
    user_skill.mkdir(parents=True)
    marker = user_skill / "SKILL.md"
    marker.write_text("user owned\n", encoding="utf-8")

    first = _install_skills(root, vault)
    assert first.returncode == 0, first.stderr or first.stdout

    source_names = {
        path.name for path in (root / "engine" / "workspace" / "skills").iterdir() if path.is_dir()
    }
    ownership_path = target / ".okf-managed-skills.json"
    ownership = json.loads(ownership_path.read_text(encoding="utf-8-sig"))
    assert ownership == {
        "schema": 1,
        "owner": "okf-workspace-engine",
        "skills": sorted(source_names),
    }
    assert marker.read_text(encoding="utf-8") == "user owned\n"

    managed_skill_file = target / sorted(source_names)[0] / "SKILL.md"
    managed_skill_file.write_text("stale managed copy\n", encoding="utf-8")

    stale_owned = target / "retired-okf-skill"
    stale_owned.mkdir()
    (stale_owned / "SKILL.md").write_text("old managed\n", encoding="utf-8")
    ownership["skills"].append(stale_owned.name)
    ownership_path.write_text(json.dumps(ownership), encoding="utf-8")

    second = _install_skills(root, vault)
    assert second.returncode == 0, second.stderr or second.stdout
    assert marker.read_text(encoding="utf-8") == "user owned\n"
    assert managed_skill_file.read_text(encoding="utf-8") != "stale managed copy\n"
    assert not stale_owned.exists()


def test_skill_installer_adopts_only_an_identical_legacy_install(tmp_path: Path) -> None:
    root = Path(__file__).parents[3]
    source_root = root / "engine" / "workspace" / "skills"
    vault = tmp_path / "vault"
    target = vault / ".agents" / "skills"
    target.mkdir(parents=True)
    for source_skill in source_root.iterdir():
        if source_skill.is_dir():
            shutil.copytree(source_skill, target / source_skill.name)

    user_skill = target / "my-private-skill"
    user_skill.mkdir()
    user_marker = user_skill / "SKILL.md"
    user_marker.write_text("user owned\n", encoding="utf-8")

    completed = _install_skills(root, vault)
    assert completed.returncode == 0, completed.stderr or completed.stdout
    payload = json.loads(completed.stdout)
    source_names = sorted(path.name for path in source_root.iterdir() if path.is_dir())
    assert payload["adopted"] == source_names
    ownership = json.loads((target / ".okf-managed-skills.json").read_text(encoding="utf-8-sig"))
    assert ownership["skills"] == source_names
    assert user_marker.read_text(encoding="utf-8") == "user owned\n"


def test_skill_installer_rejects_an_unowned_same_name_before_copying(tmp_path: Path) -> None:
    root = Path(__file__).parents[3]
    source_names = sorted(
        path.name for path in (root / "engine" / "workspace" / "skills").iterdir() if path.is_dir()
    )
    assert len(source_names) > 1

    vault = tmp_path / "vault"
    conflict = vault / ".agents" / "skills" / source_names[0]
    conflict.mkdir(parents=True)
    marker = conflict / "SKILL.md"
    marker.write_text("user version\n", encoding="utf-8")

    completed = _install_skills(root, vault)
    assert completed.returncode != 0
    assert "is not owned by OKF Workspace" in (completed.stderr + completed.stdout)
    assert marker.read_text(encoding="utf-8") == "user version\n"
    assert not (vault / ".agents" / "skills" / ".okf-managed-skills.json").exists()
    assert not (vault / ".agents" / "skills" / source_names[1]).exists()

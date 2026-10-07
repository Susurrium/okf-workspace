from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]
pytestmark = pytest.mark.skipif(
    sys.platform != "win32" or shutil.which("pwsh") is None or shutil.which("uv") is None,
    reason="Windows, PowerShell and uv are required",
)


def _shell(command: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["pwsh", "-NoProfile", "-Command", "$ErrorActionPreference='Stop';" + command],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=180,
        check=False,
    )


def _quote(path: Path) -> str:
    return "'" + str(path).replace("'", "''") + "'"


@pytest.fixture(scope="module")
def release_package(tmp_path_factory: pytest.TempPathFactory) -> Path:
    package = tmp_path_factory.mktemp("release-package")
    for folder, names in (
        ("deploy/windows", (
            "common", "release", "install", "maintenance", "feed-sync", "uninstall",
            "run-service", "backup", "restore-test",
        )),
        ("scripts", ("install-skills", "install-okf-claudian", "record-deployment")),
    ):
        for name in names:
            target = package / folder / f"{name}.ps1"
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / folder / f"{name}.ps1", target)
    for component, plugin_id in (
        ("dashboard", "okf-workspace-dashboard"),
        ("claudian", "okf-claudian"),
    ):
        for name in ("main.js", "styles.css", "manifest.json"):
            directory = package / component
            if component == "dashboard" and name != "manifest.json":
                directory /= "dist"
            directory.mkdir(parents=True, exist_ok=True)
            content = (
                json.dumps({"id": plugin_id, "version": "fixture"})
                if name == "manifest.json"
                else "/* fixture plugin */\n"
            )
            (directory / name).write_text(content, encoding="utf-8")
    engine = package / "engine"
    subprocess.run(
        ["uv", "build", str(ROOT / "engine"), "--wheel", "--out-dir", str(engine)],
        check=True,
        capture_output=True,
        timeout=90,
    )
    dependency_sets: tuple[tuple[str, list[str]], ...] = (
        ("requirements.lock", []),
        ("requirements-vector.lock", ["--extra", "vector"]),
    )
    for name, extras in dependency_sets:
        subprocess.run(
            [
                "uv", "export", "--frozen", "--no-dev", "--no-emit-project",
                "--no-header", "--no-annotate", "--output-file", str(engine / name), *extras,
            ],
            cwd=ROOT / "engine",
            check=True,
            capture_output=True,
        )
    shutil.copyfile(ROOT / "release-manifest.yaml", package / "release-manifest.yaml")
    wheel = next(engine.glob("*.whl"))
    files = {
        p.relative_to(package).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in package.rglob("*") if p.is_file()
    }
    (package / "runtime-manifest.json").write_text(
        json.dumps({
            "schema": "okf-workspace-release/v1", "release": "0.9.2",
            "engine_wheel": wheel.relative_to(package).as_posix(), "files": files,
            "source_revision": "fixture", "source_worktree_dirty": False,
        }), encoding="utf-8",
    )
    return package


def test_release_integrity_rejection_happens_before_copy(
    tmp_path: Path, release_package: Path,
) -> None:
    package = tmp_path / "package"
    shutil.copytree(release_package, package)
    (package / "dashboard/dist/main.js").write_text("tampered", encoding="utf-8")
    program = tmp_path / "program"
    command = (
        f". {_quote(ROOT / 'deploy/windows/common.ps1')};"
        f". {_quote(ROOT / 'deploy/windows/release.ps1')};"
        f"Install-OkfReleaseFiles -PackageRoot {_quote(package)} -ProgramRoot {_quote(program)}"
    )
    result = _shell(command)
    assert result.returncode != 0
    assert "checksum mismatch" in result.stderr
    assert not program.exists()


def test_release_rejects_traversal_paths(tmp_path: Path, release_package: Path) -> None:
    package = tmp_path / "package"
    shutil.copytree(release_package, package)
    manifest = package / "runtime-manifest.json"
    metadata = json.loads(manifest.read_text(encoding="utf-8"))
    metadata["files"]["../outside.txt"] = "0" * 64
    manifest.write_text(json.dumps(metadata), encoding="utf-8")
    result = _shell(
        f". {_quote(ROOT / 'deploy/windows/common.ps1')};"
        f". {_quote(ROOT / 'deploy/windows/release.ps1')};"
        f"Read-OkfRelease -Root {_quote(package)}"
    )
    assert result.returncode != 0
    assert "Invalid release file entry" in result.stderr


def test_wheel_install_initializes_fresh_vault_and_preserves_user_data_on_reinstall(
    tmp_path: Path, release_package: Path,
) -> None:
    program, vault, state, originals = (
        tmp_path / name for name in ("program", "vault", "state", "originals")
    )
    command = (
        f"& {_quote(release_package / 'deploy/windows/install.ps1')} "
        f"-ProgramRoot {_quote(program)} -Vault {_quote(vault)} "
        f"-State {_quote(state)} -Originals {_quote(originals)} "
        "-AIMode provider -AIBaseUrl 'https://example.invalid' -AIModel fixture "
        "-SkipVectorIndex -SkipScheduledTasks"
    )
    installed = _shell(command)
    assert installed.returncode == 0, installed.stdout + installed.stderr
    config_path = state / "config/deployment.json"
    config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    runtime = Path(config["runtime_root"])
    assert runtime.is_relative_to(program)
    assert config["engine_runtime"] == "wheel"
    assert not (runtime / "engine/src").exists()
    assert not (runtime / "engine/workspace").exists()
    assert (vault / "system/contracts/base.yaml").is_file()
    assert (vault / ".agents/skills/distill-wiki/SKILL.md").is_file()
    receipt_path = state / "reports/deployment-receipt.json"
    receipt = json.loads(receipt_path.read_text(encoding="utf-8-sig"))
    assert receipt["engine_runtime"].startswith("wheel;")
    token = (state / "secrets/local-api-token").read_bytes()
    user_note = vault / "My Board.md"
    user_content = "---\ndashboard: true\nworkbench_schema: 99\n---\n\nUser content\n"
    user_note.write_text(user_content, encoding="utf-8")
    reinstalled = _shell(command)
    assert reinstalled.returncode == 0, reinstalled.stdout + reinstalled.stderr
    assert user_note.read_text(encoding="utf-8") == user_content
    assert (state / "secrets/local-api-token").read_bytes() == token
    assert len(list((program / "releases").iterdir())) == 1

    candidate = tmp_path / "candidate"
    shutil.copytree(release_package, candidate)
    candidate_main = candidate / "dashboard/dist/main.js"
    candidate_main.write_text("/* updated plugin */\n", encoding="utf-8")
    candidate_manifest = candidate / "runtime-manifest.json"
    metadata = json.loads(candidate_manifest.read_text(encoding="utf-8"))
    metadata["release"] = "0.9.3"
    metadata["files"]["dashboard/dist/main.js"] = hashlib.sha256(
        candidate_main.read_bytes()
    ).hexdigest()
    candidate_manifest.write_text(json.dumps(metadata), encoding="utf-8")
    upgrade_command = command.replace(
        _quote(release_package / "deploy/windows/install.ps1"),
        _quote(candidate / "deploy/windows/install.ps1"),
    )
    upgraded = _shell(upgrade_command)
    assert upgraded.returncode == 0, upgraded.stdout + upgraded.stderr
    upgraded_config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    assert Path(upgraded_config["runtime_root"]) != runtime
    assert len(list((program / "releases").iterdir())) == 2
    rolled_back = _shell(command)
    assert rolled_back.returncode == 0, rolled_back.stdout + rolled_back.stderr
    rollback_config = json.loads(config_path.read_text(encoding="utf-8-sig"))
    assert Path(rollback_config["runtime_root"]) == runtime
    assert user_note.read_text(encoding="utf-8") == user_content
    assert (state / "secrets/local-api-token").read_bytes() == token

    module = runtime / "engine/.venv/Lib/site-packages/okf_workspace/__init__.py"
    module.write_text(module.read_text(encoding="utf-8") + "\n# tampered\n", encoding="utf-8")
    rejected = _shell(command)
    assert rejected.returncode != 0
    assert "Installed Engine differs from release wheel" in rejected.stderr
    assert user_note.read_text(encoding="utf-8") == user_content

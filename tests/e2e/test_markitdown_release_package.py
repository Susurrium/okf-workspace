from __future__ import annotations

import hashlib
import json
import os
import subprocess
import sys
import tarfile
from io import BytesIO
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[2]


@pytest.mark.skipif(os.name != "nt", reason="Windows release packager")
def test_markitdown_release_contains_public_example_but_no_private_environment(
    tmp_path: Path,
) -> None:
    output = tmp_path / "release"
    completed = subprocess.run(
        [
            "pwsh",
            "-NoProfile",
            "-File",
            str(ROOT / "scripts" / "package-markitdown-deployment.ps1"),
            "-OutputDirectory",
            str(output),
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert completed.returncode == 0, completed.stderr or completed.stdout

    archives = list(output.glob("markitdown-release-*.tar.gz"))
    assert len(archives) == 1
    with tarfile.open(archives[0], "r:gz") as release:
        names = {name.removeprefix("./") for name in release.getnames()}
        metadata_member = next(
            member
            for member in release.getmembers()
            if member.name.removeprefix("./") == "release-metadata.json"
        )
        metadata_file = release.extractfile(metadata_member)
        assert metadata_file is not None
        metadata = json.load(metadata_file)

    assert "deploy/markitdown/.env.example" in names
    assert "deploy/markitdown/.env" not in names
    assert "deploy/markitdown/install-release-bundle.sh" in names
    assert "deploy/markitdown/release_bundle.py" in names
    assert "deploy/markitdown/rollback-release-bundle.sh" in names
    assert metadata["service_version"] == "1.4.0"
    assert metadata["engine_build_id"] == "markitdown-0.1.6-py31213-assets-v3"
    assert metadata["result_schema"] == "markitdown-result/v3"
    assert metadata["default_profile"] == "fallback-assets-v2"

    extracted = tmp_path / "extracted"
    extracted.mkdir()
    verified = subprocess.run(
        [
            sys.executable,
            str(ROOT / "deploy" / "markitdown" / "release_bundle.py"),
            "verify-extract",
            "--archive",
            str(archives[0]),
            "--checksum",
            str(Path(f"{archives[0]}.sha256")),
            "--destination",
            str(extracted),
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    assert verified.returncode == 0, verified.stderr or verified.stdout
    assert len(verified.stdout.strip()) == 64
    assert (extracted / "deploy" / "markitdown" / "compose.yaml").is_file()


def test_release_bundle_rejects_a_parent_traversal_member(tmp_path: Path) -> None:
    archive = tmp_path / "unsafe.tar.gz"
    with tarfile.open(archive, "w:gz") as release:
        member = tarfile.TarInfo("../outside")
        payload = b"unsafe"
        member.size = len(payload)
        release.addfile(member, BytesIO(payload))
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    checksum = Path(f"{archive}.sha256")
    checksum.write_text(f"{digest}  {archive.name}\n", encoding="utf-8")
    destination = tmp_path / "destination"
    destination.mkdir()

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "deploy" / "markitdown" / "release_bundle.py"),
            "verify-extract",
            "--archive",
            str(archive),
            "--checksum",
            str(checksum),
            "--destination",
            str(destination),
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    assert completed.returncode == 1
    assert "unsafe name" in completed.stderr or "traverses" in completed.stderr
    assert not (tmp_path / "outside").exists()


def test_release_upgrade_environment_preserves_site_values_and_uses_new_identity(
    tmp_path: Path,
) -> None:
    example = ROOT / "deploy" / "markitdown" / ".env.example"
    previous = tmp_path / "previous.env"
    prior_text = example.read_text(encoding="utf-8")
    replacements = {
        "MARKITDOWN_IMAGE": "obsidian-markitdown-service:1.2.0",
        "MARKITDOWN_ENGINE_BUILD_ID": "markitdown-old-build",
        "MARKITDOWN_HOST_PORT": "19010",
        "MARKITDOWN_EXPECTED_MOUNT": "/data",
        "MARKITDOWN_EXPECTED_SOURCE": "/dev/test-data",
        "MARKITDOWN_TAILNET_FQDN": "test-node.example.ts.net",
        "MARKITDOWN_MAX_ACTIVE_TASKS": "2",
        "MARKITDOWN_BUNDLE_MANIFEST_SHA256": "a" * 64,
        "MARKITDOWN_RELEASE_MANIFEST_SHA256": "a" * 64,
    }
    rendered_lines: list[str] = []
    for line in prior_text.splitlines():
        key = line.partition("=")[0]
        rendered_lines.append(f"{key}={replacements[key]}" if key in replacements else line)
    previous.write_text("\n".join(rendered_lines) + "\n", encoding="utf-8")
    output = tmp_path / "new.env"
    new_digest = "b" * 64

    completed = subprocess.run(
        [
            sys.executable,
            str(ROOT / "deploy" / "markitdown" / "release_bundle.py"),
            "prepare-upgrade-env",
            "--example",
            str(example),
            "--previous",
            str(previous),
            "--output",
            str(output),
            "--manifest-sha256",
            new_digest,
        ],
        check=False,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    assert completed.returncode == 0, completed.stderr or completed.stdout
    values = {
        key: value
        for line in output.read_text(encoding="utf-8").splitlines()
        if line and not line.startswith("#")
        for key, _, value in [line.partition("=")]
    }
    assert values["MARKITDOWN_IMAGE"] == "obsidian-markitdown-service:1.4.0"
    assert values["MARKITDOWN_ENGINE_BUILD_ID"] == (
        "markitdown-0.1.6-py31213-assets-v3"
    )
    assert values["MARKITDOWN_HOST_PORT"] == "19010"
    assert values["MARKITDOWN_EXPECTED_SOURCE"] == "/dev/test-data"
    assert values["MARKITDOWN_MAX_ACTIVE_TASKS"] == "2"
    assert values["MARKITDOWN_BUNDLE_MANIFEST_SHA256"] == new_digest
    assert values["MARKITDOWN_RELEASE_MANIFEST_SHA256"] == new_digest

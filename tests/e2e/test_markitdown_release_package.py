from __future__ import annotations

import os
import subprocess
import tarfile
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
    )
    assert completed.returncode == 0, completed.stderr or completed.stdout

    archives = list(output.glob("markitdown-release-*.tar.gz"))
    assert len(archives) == 1
    with tarfile.open(archives[0], "r:gz") as release:
        names = {name.removeprefix("./") for name in release.getnames()}

    assert "deploy/markitdown/.env.example" in names
    assert "deploy/markitdown/.env" not in names

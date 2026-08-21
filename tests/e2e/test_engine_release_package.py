from __future__ import annotations

from pathlib import Path
from zipfile import ZipFile

import pytest


def test_built_engine_wheel_contains_only_the_static_workspace_kit() -> None:
    root = Path(__file__).parents[2]
    wheels = sorted((root / "engine" / "dist").glob("*.whl"))
    if not wheels:
        pytest.skip("Engine wheel is verified after the CI build step")

    with ZipFile(wheels[-1]) as archive:
        names = set(archive.namelist())

    prefix = "okf_workspace/resources/vault/"
    assert f"{prefix}AGENTS.md" in names
    assert f"{prefix}system/contracts/source.yaml" in names
    assert f"{prefix}system/policies/content-boundary.md" in names

    obsidian_files = {name for name in names if name.startswith(f"{prefix}.obsidian/")}
    assert obsidian_files == {
        f"{prefix}.obsidian/app.json",
        f"{prefix}.obsidian/daily-notes.json",
        f"{prefix}.obsidian/templates.json",
    }

    forbidden_fragments = (
        f"{prefix}.claudian/",
        f"{prefix}.agents/",
        f"{prefix}inbox/",
        f"{prefix}learning/",
        f"{prefix}projects/",
        f"{prefix}sources/",
        f"{prefix}self/decisions/",
        f"{prefix}self/hypotheses/",
    )
    assert not any(fragment in name for name in names for fragment in forbidden_fragments)

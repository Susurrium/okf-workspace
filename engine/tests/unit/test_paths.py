from __future__ import annotations

from pathlib import Path

import pytest

from okf_workspace.okf.paths import (
    UnsafeBundlePath,
    normalize_bundle_path,
    resolve_bundle_path,
    slugify,
)


@pytest.mark.parametrize("value", ["../secret.md", "/absolute.md", "C:/secret.md", ""])
def test_rejects_unsafe_bundle_paths(value: str) -> None:
    with pytest.raises(UnsafeBundlePath):
        normalize_bundle_path(value)


def test_normalizes_windows_separators() -> None:
    assert normalize_bundle_path(r"knowledge\wiki\示例.md").as_posix() == ("knowledge/wiki/示例.md")


def test_resolves_inside_vault(tmp_path: Path) -> None:
    assert (
        resolve_bundle_path(tmp_path, "knowledge/note.md")
        == (tmp_path / "knowledge" / "note.md").resolve()
    )


def test_slugify_preserves_readable_chinese() -> None:
    assert slugify("LiveSync 不是备份！") == "LiveSync-不是备份"

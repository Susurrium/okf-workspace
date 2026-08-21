from __future__ import annotations

from pathlib import Path

import pytest

from markitdown_service.config import ConfigurationError, Settings


def _identity_environment(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> str:
    release_sha256 = "a" * 64
    monkeypatch.setenv("MARKITDOWN_STATE_DIR", str(tmp_path / "state"))
    monkeypatch.setenv("MARKITDOWN_SPOOL_DIR", str(tmp_path / "spool"))
    monkeypatch.setenv("MARKITDOWN_ENGINE_BUILD_ID", "markitdown-0.1.6-py31213-v3")
    monkeypatch.setenv("MARKITDOWN_IMAGE_BUILD_ID", "markitdown-0.1.6-py31213-v3")
    monkeypatch.setenv("MARKITDOWN_RELEASE_MANIFEST_SHA256", release_sha256)
    monkeypatch.setenv("MARKITDOWN_IMAGE_RELEASE_MANIFEST_SHA256", release_sha256)
    return release_sha256


def test_environment_binds_runtime_to_image_release_identity(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    release_sha256 = _identity_environment(monkeypatch, tmp_path)
    settings = Settings.from_environment(require_tokens=False)
    assert settings.engine_build_id == "markitdown-0.1.6-py31213-v3"
    assert settings.release_manifest_sha256 == release_sha256


@pytest.mark.parametrize(
    ("name", "value"),
    [
        ("MARKITDOWN_ENGINE_BUILD_ID", "unsafe build/id"),
        ("MARKITDOWN_IMAGE_BUILD_ID", "wrong-build"),
        ("MARKITDOWN_IMAGE_RELEASE_MANIFEST_SHA256", "b" * 64),
        ("MARKITDOWN_RELEASE_MANIFEST_SHA256", "not-a-sha256"),
    ],
)
def test_environment_rejects_mismatched_or_invalid_release_identity(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
    name: str,
    value: str,
) -> None:
    _identity_environment(monkeypatch, tmp_path)
    monkeypatch.setenv(name, value)
    with pytest.raises(ConfigurationError):
        Settings.from_environment(require_tokens=False)

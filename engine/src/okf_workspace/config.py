"""Filesystem configuration for OKF Workspace."""

from __future__ import annotations

import json
import os
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import cast


def _configured_path(value: str | None, fallback: Path) -> Path:
    return Path(value).expanduser().resolve() if value else fallback.resolve()


@dataclass(frozen=True, slots=True)
class BrainPaths:
    """All mutable data roots remain outside the source repository."""

    vault: Path
    originals: Path
    state: Path

    @property
    def search_database(self) -> Path:
        return self.state / "brain.sqlite"

    @property
    def vector_database(self) -> Path:
        return self.state / "vectors.sqlite"

    @property
    def trace_directory(self) -> Path:
        return self.state / "traces"

    @classmethod
    def from_env(cls) -> BrainPaths:
        data_root = Path(os.environ.get("OKF_BRAIN_DATA_ROOT", r"E:\ObsidianData"))
        return cls(
            vault=_configured_path(
                os.environ.get("OKF_BRAIN_VAULT"),
                data_root / "OKF-Brain",
            ),
            originals=_configured_path(
                os.environ.get("OKF_BRAIN_ORIGINALS"),
                data_root / "OKF-Brain-Originals",
            ),
            state=_configured_path(
                os.environ.get("OKF_BRAIN_STATE"),
                data_root / "OKF-Brain-State",
            ),
        )


def repository_root() -> Path:
    return Path(__file__).resolve().parents[2]


def default_template_root() -> Path:
    candidate = repository_root() / "workspace" / "vault"
    if candidate.is_dir():
        return candidate
    packaged = Path(__file__).resolve().parent / "resources" / "vault"
    if packaged.is_dir():
        return packaged
    raise FileNotFoundError("Vault template is unavailable in the repository or package")


def apply_deployment_config(path: Path) -> BrainPaths:
    """Load operational paths and service settings without exposing secret contents."""

    loaded = cast(object, json.loads(path.read_text(encoding="utf-8")))
    if not isinstance(loaded, dict):
        raise ValueError("deployment config must contain a JSON object")
    config = cast(Mapping[str, object], loaded)
    variables = {
        "OKF_BRAIN_VAULT": config.get("vault"),
        "OKF_BRAIN_ORIGINALS": config.get("originals"),
        "OKF_BRAIN_STATE": config.get("state"),
        "OKF_MINERU_URL": config.get("mineru_url"),
        "OKF_DEFAULT_CONVERSION_METHOD": config.get("default_conversion_method"),
        "OKF_MINERU_SELF_HOSTED_ENABLED": config.get("mineru_self_hosted_enabled"),
        "OKF_MINERU_TOKEN_FILE": config.get("mineru_token_file"),
        "OKF_MINERU_MODEL": config.get("mineru_model"),
        "OKF_MINERU_SSH_MANAGED": config.get("mineru_ssh_managed"),
        "OKF_MINERU_SSH_HOST": config.get("mineru_ssh_host"),
        "OKF_MINERU_SSH_REMOTE_PORT": config.get("mineru_ssh_remote_port"),
        "OKF_MARKITDOWN_URL": config.get("markitdown_url"),
        "OKF_MARKITDOWN_TOKEN_FILE": config.get("markitdown_token_file"),
        "OKF_AI_MODE": config.get("ai_mode"),
        "OKF_CODEX_COMMAND": config.get("codex_command"),
        "OKF_CODEX_MODEL": config.get("codex_model"),
        "OKF_AI_BASE_URL": config.get("ai_base_url"),
        "OKF_AI_MODEL": config.get("ai_model"),
        "OKF_AI_API_KEY_FILE": config.get("ai_api_key_file"),
        "OKF_API_PORT": config.get("api_port"),
        "OKF_LIVESYNC_REQUIRED": config.get("livesync_required"),
        "OKF_SEMANTIC_AUTOMATION": config.get("semantic_automation"),
        "OKF_SEMANTIC_TIMEOUT_SECONDS": config.get("semantic_timeout_seconds"),
        "OKF_SEMANTIC_RETRIEVAL_TIMEOUT_SECONDS": config.get("semantic_retrieval_timeout_seconds"),
    }
    for name, value in variables.items():
        if value is not None and (
            str(value).strip() or name.startswith(("OKF_MINERU_", "OKF_MARKITDOWN_"))
        ):
            os.environ[name] = str(value)
    return BrainPaths.from_env()

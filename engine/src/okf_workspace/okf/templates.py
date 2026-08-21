"""Create a production Vault from the canonical repository template."""

from __future__ import annotations

import shutil
from pathlib import Path

from okf_workspace.config import default_template_root

from .validator import validate_bundle


class VaultInitializationError(RuntimeError):
    """Raised when initialization would mix with an existing Vault."""


_STATIC_FILES = (
    "AGENTS.md",
    "index.md",
    ".gitignore",
    ".obsidian/app.json",
    ".obsidian/daily-notes.json",
    ".obsidian/templates.json",
    "self/capabilities.md",
    "self/constraints.md",
    "self/direction.md",
    "self/now.md",
    "self/preferences.md",
    "self/profile.md",
)
_STATIC_DIRECTORIES = ("system",)
_DYNAMIC_DIRECTORIES = (
    "archive/captures",
    "feeds/ai-daily",
    "feeds/treehole",
    "inbox/captures",
    "knowledge/maps",
    "knowledge/wiki",
    "learning/courses",
    "learning/guides",
    "learning/plans",
    "life/areas",
    "life/daily",
    "life/reflections",
    "life/reviews",
    "projects",
    "self/decisions",
    "self/hypotheses",
    "sources/assets",
    "sources/records",
    "sources/text",
)


def _copy_workspace_kit(template: Path, target: Path) -> None:
    target.mkdir(parents=True)
    for name in _STATIC_FILES:
        source = template / name
        if not source.is_file():
            raise VaultInitializationError(f"Workspace Kit file is missing: {source}")
        destination = target / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source, destination)
    for name in _STATIC_DIRECTORIES:
        source = template / name
        if not source.is_dir():
            raise VaultInitializationError(f"Workspace Kit directory is missing: {source}")
        shutil.copytree(source, target / name)
    for relative in _DYNAMIC_DIRECTORIES:
        (target / relative).mkdir(parents=True, exist_ok=True)


def initialize_vault(
    target: Path,
    *,
    template_root: Path | None = None,
) -> Path:
    target = target.resolve()
    template = (template_root or default_template_root()).resolve()
    if not template.is_dir():
        raise VaultInitializationError(f"template directory does not exist: {template}")
    if target.exists() and any(target.iterdir()):
        raise VaultInitializationError(f"target Vault is not empty: {target}")
    if target.exists():
        target.rmdir()
    target.parent.mkdir(parents=True, exist_ok=True)
    _copy_workspace_kit(template, target)
    report = validate_bundle(target)
    if not report.valid:
        shutil.rmtree(target)
        details = "; ".join(f"{item.path}: {item.message}" for item in report.errors)
        raise VaultInitializationError(f"template produced an invalid bundle: {details}")
    return target

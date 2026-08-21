from __future__ import annotations

import json
import re
from pathlib import Path
from typing import cast

import tomllib
from ruamel.yaml import YAML

ROOT = Path(__file__).resolve().parents[2]


def _yaml(path: Path) -> dict[str, object]:
    loaded = YAML(typ="safe").load(path.read_text(encoding="utf-8"))
    assert isinstance(loaded, dict)
    return cast(dict[str, object], loaded)


def _project_version(path: Path) -> str:
    loaded = tomllib.loads(path.read_text(encoding="utf-8"))
    return str(cast(dict[str, object], loaded["project"])["version"])


def _quoted_version(path: Path, symbol: str) -> str:
    content = path.read_text(encoding="utf-8")
    match = re.search(rf"\b{re.escape(symbol)}\s*=\s*[\"']([^\"']+)[\"']", content)
    assert match is not None, f"missing {symbol} in {path}"
    return match.group(1)


def _lockfile_version(path: Path) -> str:
    loaded = json.loads(path.read_text(encoding="utf-8"))
    packages = cast(dict[str, object], loaded["packages"])
    root = cast(dict[str, object], packages[""])
    return str(root["version"])


def test_release_manifest_matches_all_build_units() -> None:
    release = _yaml(ROOT / "release-manifest.yaml")
    components = cast(dict[str, object], release["components"])

    engine_version = str(components["engine"])
    assert engine_version == _project_version(ROOT / "engine" / "pyproject.toml")
    assert engine_version == _quoted_version(
        ROOT / "engine" / "src" / "okf_workspace" / "__init__.py", "__version__"
    )

    dashboard_package = json.loads((ROOT / "dashboard" / "package.json").read_text())
    dashboard_manifest = json.loads((ROOT / "dashboard" / "manifest.json").read_text())
    assert dashboard_package["name"] == "okf-workspace-dashboard"
    assert dashboard_manifest["id"] == "okf-workspace-dashboard"
    assert dashboard_package["name"] == dashboard_manifest["id"]
    assert str(components["dashboard"]) == dashboard_package["version"]
    assert dashboard_package["version"] == dashboard_manifest["version"]
    assert dashboard_package["version"] == _lockfile_version(
        ROOT / "dashboard" / "package-lock.json"
    )
    assert dashboard_package["version"] == _quoted_version(
        ROOT / "dashboard" / "src" / "version.ts", "DASHBOARD_VERSION"
    )

    claudian_package = json.loads((ROOT / "claudian" / "package.json").read_text())
    claudian_manifest = json.loads((ROOT / "claudian" / "manifest.json").read_text())
    assert claudian_package["name"] == "okf-claudian"
    assert claudian_manifest["id"] == "okf-claudian"
    assert claudian_package["name"] == claudian_manifest["id"]
    assert str(components["claudian"]) == claudian_package["version"]
    assert claudian_package["version"] == claudian_manifest["version"]
    assert claudian_package["version"] == _lockfile_version(ROOT / "claudian" / "package-lock.json")

    markitdown_version = str(components["markitdown_service"])
    assert markitdown_version == _project_version(ROOT / "services" / "markitdown" / "pyproject.toml")
    assert markitdown_version == _quoted_version(
        ROOT / "services" / "markitdown" / "src" / "markitdown_service" / "__init__.py",
        "__version__",
    )

    release_surfaces = (
        ROOT / "services" / "markitdown" / "Dockerfile",
        ROOT / "deploy" / "markitdown" / "compose.yaml",
        ROOT / "deploy" / "markitdown" / ".env.example",
        ROOT / "deploy" / "markitdown" / "verify.py",
        ROOT / "scripts" / "package-markitdown-deployment.ps1",
    )
    for path in release_surfaces:
        assert markitdown_version in path.read_text(encoding="utf-8"), (
            f"MarkItDown release surface does not declare {markitdown_version}: {path}"
        )


def test_workspace_schema_has_one_release_value() -> None:
    release = _yaml(ROOT / "release-manifest.yaml")
    workspace = _yaml(ROOT / "engine" / "workspace" / "manifest.yaml")
    assert release["workspace_schema"] == workspace["workspace_schema"]


def test_markitdown_compose_builds_the_monorepo_service() -> None:
    compose_path = ROOT / "deploy" / "markitdown" / "compose.yaml"
    compose = _yaml(compose_path)
    services = cast(dict[str, object], compose["services"])
    api = cast(dict[str, object], services["api"])
    build = cast(dict[str, object], api["build"])
    context = (compose_path.parent / str(build["context"])).resolve()
    assert context == (ROOT / "services" / "markitdown").resolve()
    assert (context / str(build["dockerfile"])).is_file()

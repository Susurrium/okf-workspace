"""Render the canonical human-readable body for an OKF artifact.

The templates live inside the Vault so Obsidian, Codex and the Python service all
share one visible structure.  Frontmatter remains typed code because YAML values
need lossless serialization and preservation when notes are updated.
"""

from __future__ import annotations

import re
from pathlib import Path
from string import Template

from okf_workspace.config import default_template_root

_TOKEN = re.compile(r"{{\s*([a-zA-Z][a-zA-Z0-9_]*)\s*}}")


class ArtifactTemplateError(ValueError):
    """Raised when a canonical template is missing or cannot be rendered."""


def canonical_template_path(vault: Path, name: str) -> Path:
    """Return the Vault template when installed, otherwise the bundled fallback."""

    relative = Path("system") / "templates" / "canonical" / f"{name}.md"
    local = vault.resolve() / relative
    if local.is_file():
        return local
    bundled = default_template_root() / relative
    if bundled.is_file():
        return bundled
    raise ArtifactTemplateError(f"canonical artifact template does not exist: {name}")


def render_artifact_body(vault: Path, name: str, **values: str) -> str:
    """Render a strict, intentionally small ``{{name}}`` template."""

    source = canonical_template_path(vault, name).read_text(encoding="utf-8")
    required = set(_TOKEN.findall(source))
    missing = sorted(required.difference(values))
    if missing:
        raise ArtifactTemplateError(f"template {name} is missing values: {', '.join(missing)}")
    # Convert to ``string.Template`` only after collecting tokens so unexpected
    # braces in user-authored Markdown are left untouched.
    converted = _TOKEN.sub(lambda match: "${" + match.group(1) + "}", source)
    rendered = Template(converted).substitute(values)
    return rendered.rstrip() + "\n"

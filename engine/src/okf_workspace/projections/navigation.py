"""Keep the root index as a stable human directory.

Dynamic activity, tasks and recents belong to Dashboard/plugin projections. The
root index intentionally stays readable on every device and is never an AI
retrieval dependency.
"""

from __future__ import annotations

from pathlib import Path


def rebuild_root_index(vault: Path) -> Path:
    """Return the single root directory without injecting dynamic content."""

    target = vault.resolve() / "index.md"
    if not target.is_file():
        raise FileNotFoundError(target)
    return target

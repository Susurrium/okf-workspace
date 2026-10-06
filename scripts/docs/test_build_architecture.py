"""Failure-boundary checks for the offline documentation generator."""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

SPEC = importlib.util.spec_from_file_location(
    "architecture_builder", Path(__file__).with_name("build_architecture.py")
)
assert SPEC is not None and SPEC.loader is not None
builder = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(builder)


@pytest.mark.parametrize("source", ["missing.md", "../outside.md", "C:/private.md"])
def test_missing_and_external_evidence_is_rejected(tmp_path: Path, source: str) -> None:
    with pytest.raises(ValueError):
        builder.check_source(source, tmp_path)


def test_moved_section_is_not_silently_accepted(tmp_path: Path) -> None:
    (tmp_path / "README.md").write_text(
        '## Data ownership\n\n<a id="conversion"></a>\n', encoding="utf-8"
    )
    builder.check_source("README.md#data-ownership", tmp_path)
    builder.check_source("README.md#conversion", tmp_path)
    with pytest.raises(ValueError, match="anchor"):
        builder.check_source("README.md#old-section", tmp_path)


def test_relationship_to_missing_node_is_rejected() -> None:
    with pytest.raises(ValueError, match="Dangling"):
        builder.validate_charts(
            [{"id": "test", "nodes": [], "edges": [{"a": "missing", "b": "missing"}]}]
        )


def test_shared_flow_continuation_must_be_copied() -> None:
    child = builder.item("step", "shared", "docs/architecture/README.md")
    tree = builder.item("root", "test", "docs/architecture/README.md", [child, child])
    with pytest.raises(ValueError, match="shared node"):
        builder.identify_flow(tree)


def test_description_cannot_end_inline_script() -> None:
    rendered = builder.script_json({"title": "</script><script>alert(1)</script>"})
    assert "</script>" not in rendered
    assert "\\u003c" in rendered

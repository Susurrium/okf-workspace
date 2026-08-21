from __future__ import annotations

from pathlib import Path

from okf_workspace.fixtures import generate_fixture_vault
from okf_workspace.okf.frontmatter import read_document
from okf_workspace.okf.validator import validate_bundle


def test_fixture_generator_covers_acceptance_states(tmp_path: Path) -> None:
    vault = generate_fixture_vault(tmp_path / "fixture-vault")

    assert validate_bundle(vault).valid
    assert (vault / "knowledge/wiki/nonce-note.md").read_text(encoding="utf-8").find(
        "FIXTURE-NONCE-20260817"
    ) >= 0
    assert (vault / "sources/records/documents/sample-source.md").exists()
    assert (vault / "sources/text/documents/sample-source.md").exists()

    statuses = {
        (
            str(document.frontmatter.get("status", "stable")),
            document.frontmatter.get("studied_at") is not None,
        )
        for path in (vault / "knowledge/wiki").glob("*.md")
        if path.name != "index.md"
        if (document := read_document(path))
    }
    assert ("draft", False) in statuses
    assert ("stable", False) in statuses
    assert ("stable", True) in statuses

from __future__ import annotations

from pathlib import Path

from okf_workspace.notes import NoteService
from okf_workspace.okf.frontmatter import OkfDocument, write_document
from okf_workspace.okf.validator import validate_bundle, validate_paths


def test_template_bundle_is_valid(vault: Path) -> None:
    report = validate_bundle(vault)

    assert report.valid, report.issues
    assert report.files_checked > 5


def test_missing_type_is_an_error(vault: Path) -> None:
    bad = vault / "knowledge" / "wiki" / "bad.md"
    bad.parent.mkdir(parents=True, exist_ok=True)
    bad.write_text("---\ntitle: Missing type\n---\n# Bad\n", encoding="utf-8")

    report = validate_bundle(vault)

    assert not report.valid
    assert any(
        issue.code == "missing-type" and issue.path.endswith("bad.md") for issue in report.errors
    )


def test_unknown_type_requires_an_explicit_contract(vault: Path) -> None:
    custom = vault / "knowledge" / "wiki" / "custom.md"
    custom.parent.mkdir(parents=True, exist_ok=True)
    custom.write_text(
        "---\ntype: Future Custom Type\nfuture_field: anything\n---\n# Custom\n",
        encoding="utf-8",
    )

    report = validate_bundle(vault)

    assert any(issue.code == "unknown-type" for issue in report.errors)


def test_unknown_fields_on_a_registered_type_are_preserved_and_allowed(vault: Path) -> None:
    custom = vault / "knowledge" / "wiki" / "custom.md"
    custom.parent.mkdir(parents=True, exist_ok=True)
    custom.write_text(
        "---\n"
        "type: Wiki\n"
        "title: Custom\n"
        "description: Extension field test\n"
        "status: draft\n"
        "created_at: 2026-08-20T00:00:00+08:00\n"
        "sources: []\n"
        "future_field: anything\n"
        "---\n# Custom\n",
        encoding="utf-8",
    )

    report = validate_bundle(vault)

    assert report.valid, report.issues


def test_missing_workspace_write_field_warns_without_rejecting_legacy_source(
    vault: Path,
) -> None:
    source = vault / "sources/records/custom/legacy.md"
    write_document(
        source,
        OkfDocument(
            {
                "type": "Source",
                "title": "Legacy Source",
                "created_at": "2026-08-20T00:00:00+08:00",
                "resource": "custom://legacy",
                "kind": "custom",
                "purpose": "reference",
            },
            "# Legacy Source\n",
        ),
    )

    report = validate_bundle(vault)

    assert report.valid
    assert any(
        issue.code == "workspace-write-field"
        and issue.path == "sources/records/custom/legacy.md"
        for issue in report.warnings
    )


def test_runtime_instruction_and_format_files_are_not_concepts(vault: Path) -> None:
    (vault / "AGENTS.md").write_text("# Runtime instructions\n", encoding="utf-8")
    skill = vault / ".agents" / "skills" / "example" / "SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_text(
        "---\nname: example\ndescription: Example runtime skill.\n---\n# Example\n",
        encoding="utf-8",
    )
    contract = vault / "system" / "contracts" / "wiki.md"
    contract.parent.mkdir(parents=True, exist_ok=True)
    contract.write_text("# Wiki format\n", encoding="utf-8")

    report = validate_bundle(vault)

    assert report.valid, report.issues
    checked_paths = {issue.path for issue in report.issues}
    assert "AGENTS.md" not in checked_paths
    assert ".agents/skills/example/SKILL.md" not in checked_paths
    assert "system/contracts/wiki.md" not in checked_paths


def test_nested_index_is_not_allowed(vault: Path) -> None:
    index = vault / "knowledge" / "index.md"
    index.parent.mkdir(parents=True, exist_ok=True)
    index.write_text("---\ntype: Index\n---\n# Knowledge\n", encoding="utf-8")

    report = validate_bundle(vault)

    assert any(issue.code == "nested-index" for issue in report.errors)


def test_log_dates_must_be_newest_first(vault: Path) -> None:
    log = vault / "projects" / "log.md"
    log.parent.mkdir(parents=True, exist_ok=True)
    log.write_text(
        "# Directory Update Log\n\n## 2026-01-01\n\n## 2026-02-01\n",
        encoding="utf-8",
    )

    report = validate_bundle(vault)

    assert any(issue.code == "log-order" for issue in report.errors)


def test_contract_catalog_rejects_required_fields_without_declared_types(vault: Path) -> None:
    contract = vault / "system" / "contracts" / "broken.yaml"
    contract.write_text(
        """contract_version: 3
artifact: Broken
authority: markdown
paths: [knowledge/wiki/<slug>.md]
required_fields: [invented_state]
regions:
  human: [body]
""",
        encoding="utf-8",
    )

    report = validate_bundle(vault)

    assert any(
        issue.code == "contract-error" and "must declare a field type" in issue.message
        for issue in report.errors
    )


def test_targeted_validation_does_not_let_unrelated_legacy_note_block_a_write(
    vault: Path,
) -> None:
    valid = NoteService(vault).create_wiki("Targeted validation", "Valid durable content.")
    unrelated = vault / "knowledge" / "wiki" / "legacy-invalid.md"
    unrelated.write_text("---\ntype: Removed Legacy Type\n---\n# Legacy\n", encoding="utf-8")

    targeted = validate_paths(vault, [valid])
    full = validate_bundle(vault)

    assert targeted.valid, targeted.issues
    assert targeted.files_checked == 1
    assert any(issue.path.endswith("legacy-invalid.md") for issue in full.errors)


def test_generated_wiki_requires_real_sources(vault: Path) -> None:
    wiki = vault / "knowledge" / "wiki" / "premature.md"
    wiki.parent.mkdir(parents=True, exist_ok=True)
    wiki.write_text(
        """---
type: Wiki
title: Premature
status: draft
created_at: 2026-08-20T00:00:00+08:00
description: Background output is not actually present.
generated:
  by: process:codex-background-wiki-draft
  at: 2026-08-20T00:00:00+08:00
---
# Premature
""",
        encoding="utf-8",
    )

    report = validate_paths(vault, [wiki])

    codes = {issue.code for issue in report.errors}
    assert "conditional-missing-field" in codes

from __future__ import annotations

import json
from pathlib import Path
from typing import cast

from okf_workspace.okf.contracts import load_contract_catalog
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.retrieval.scanner import iter_markdown

FINAL_ARTIFACTS = {
    "Capture",
    "Daily",
    "Reflection",
    "Review",
    "Project",
    "Decision",
    "Course",
    "Lesson",
    "Study Guide",
    "Wiki",
    "Wiki Map",
    "Digest",
    "Source",
    "Source Text",
    "Profile",
    "Agent Policy",
    "System View",
}


def test_vault_installs_shared_contracts_templates_and_native_views(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")

    assert (vault / "system/contracts/daily.yaml").is_file()
    assert (vault / "system/templates/canonical/daily.md").is_file()
    assert (vault / "system/templates/canonical/review.md").is_file()
    assert (vault / "system/templates/core/Daily.md").is_file()
    assert (vault / "system/templates/interactive/Reflection.md").is_file()
    assert (vault / "system/templates/interactive/Review.md").is_file()
    assert (vault / "system/views/Tasks.md").is_file()
    assert not (vault / "log.md").exists()

    clipper = cast(
        dict[str, object],
        json.loads(
            (vault / "system/integrations/web-clipper/workspace-web-capture.json").read_text(
                encoding="utf-8"
            )
        ),
    )
    assert clipper["schemaVersion"] == "0.1.0"
    assert clipper["path"] == 'inbox/captures/{{time|date:"YYYY"}}/{{time|date:"MM"}}'
    assert "ingested_via" in str(clipper["properties"])
    assert '{{"' not in str(clipper["noteContentFormat"])

    indexed = {path.relative_to(vault).as_posix() for path in iter_markdown(vault)}
    assert "system/templates/canonical/daily.md" not in indexed
    assert "system/views/Tasks.md" not in indexed
    assert "index.md" not in indexed


def test_core_daily_and_templater_use_separate_template_roots(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    daily = (vault / ".obsidian/daily-notes.json").read_text(encoding="utf-8")
    templater = (vault / ".obsidian/templates.json").read_text(encoding="utf-8")

    assert "system/templates/core/Daily" in daily
    assert "system/templates/interactive" in templater


def test_profile_v3_has_one_fixed_contract_per_final_artifact(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    catalog = load_contract_catalog(vault)

    assert catalog.version == 3
    assert catalog.profile == "workspace"
    assert catalog.okf_version == "0.2"
    assert catalog.common_required_fields == ("type", "title", "created_at")
    assert catalog.common_states["status"] == {"draft", "stable", "deprecated"}
    assert set(catalog.artifacts) == FINAL_ARTIFACTS

    assert catalog.artifacts["Study Guide"].required_ai_regions == ("study-material",)
    assert catalog.artifacts["Study Guide"].required_human_regions == ("notes",)
    assert catalog.artifacts["Lesson"].required_ai_regions == ("organized-lesson",)
    assert catalog.artifacts["Wiki"].required_fields == ("description",)
    assert catalog.artifacts["Capture"].required_fields == ("capture_status",)
    assert catalog.artifacts["Capture"].workspace_write_fields == ("ingested_via",)
    assert catalog.artifacts["Capture"].field_types["resource"] == "string"
    assert catalog.artifacts["Capture"].field_types["course"] == "vault_path"
    assert catalog.artifacts["Capture"].field_types["project"] == "vault_path"
    assert catalog.artifacts["Source"].required_fields == (
        "resource",
        "kind",
        "text",
        "uses",
    )
    assert "course" not in catalog.artifacts["Source"].field_types
    assert "project" not in catalog.artifacts["Source"].field_types
    assert "purpose" not in catalog.artifacts["Source"].field_types
    assert catalog.artifacts["Source"].field_types["uses"] == "source_use_list"
    assert catalog.artifacts["Source"].workspace_write_fields == ("ingested_via",)
    assert catalog.artifacts["Source"].states["ingested_via"] == {
        "web-clip",
        "file-import",
        "feed",
        "direct-entry",
    }
    assert "workspace_write_fields: [ingested_via]" in (
        vault / "system/contracts/capture.yaml"
    ).read_text(encoding="utf-8")
    assert "workspace_write_fields: [ingested_via]" in (
        vault / "system/contracts/source.yaml"
    ).read_text(encoding="utf-8")

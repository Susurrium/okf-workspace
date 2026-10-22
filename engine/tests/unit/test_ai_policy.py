from __future__ import annotations

from typing import cast

import pytest

from okf_workspace.ai.policy import Actor, WritePolicyError, authorize_write


def test_explicit_ai_can_create_draft_wiki_but_not_modify_self() -> None:
    authorize_write(
        "knowledge/wiki/example.md",
        actor="explicit-ai",
        operation="create",
    )
    with pytest.raises(WritePolicyError):
        authorize_write(
            "self/profile.md",
            actor="explicit-ai",
            operation="edit-section",
        )


def test_automatic_ai_is_limited_to_named_managed_regions() -> None:
    authorize_write(
        "projects/example/project.md",
        actor="automatic-ai",
        operation="replace-managed-region",
        managed_region="project-current-state",
    )
    with pytest.raises(WritePolicyError):
        authorize_write(
            "projects/example/project.md",
            actor="automatic-ai",
            operation="edit-section",
        )
    authorize_write(
        "life/daily/2026/08/2026-08-17.md",
        actor="automatic-ai",
        operation="replace-managed-region",
        managed_region="linked-activity",
    )
    with pytest.raises(WritePolicyError):
        authorize_write(
            "life/reflections/example.md",
            actor="automatic-ai",
            operation="replace-managed-region",
            managed_region="summary",
        )


@pytest.mark.parametrize("path,actor", [
    ("SELF/profile.md", "explicit-ai"),
    ("Sources/Text/protected.md", "explicit-ai"),
    ("Life/Reflections/private.md", "automatic-ai"),
])
def test_protected_namespaces_reject_case_variants(path: str, actor: str) -> None:
    with pytest.raises(WritePolicyError):
        authorize_write(path, actor=cast(Actor, actor), operation="replace-managed-region",
                        managed_region="summary")

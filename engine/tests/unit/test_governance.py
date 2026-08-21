from __future__ import annotations

from pathlib import Path

from okf_workspace.governance import scan_governance
from okf_workspace.okf.frontmatter import OkfDocument, write_document
from okf_workspace.okf.templates import initialize_vault


def test_governance_enforces_the_narrow_profile_v3_generated_marker(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    write_document(
        vault / "knowledge/wiki/background.md",
        OkfDocument(
            {
                "type": "Wiki",
                "title": "Background",
                "description": "Background Wiki",
                "created_at": "2026-08-20T12:00:00+08:00",
                "sources": [{"resource": "https://example.test/source"}],
                "generated": {
                    "by": "codex/background",
                    "at": "2026-08-20T12:00:00+08:00",
                },
            },
            "# Background\n",
        ),
    )
    write_document(
        vault / "life/daily/2026/08/2026-08-20.md",
        OkfDocument(
            {
                "type": "Daily",
                "title": "2026-08-20",
                "created_at": "2026-08-20T12:00:00+08:00",
                "date": "2026-08-20",
                "generated": {
                    "by": "process:codex-background",
                    "at": "2026-08-20T12:00:00+08:00",
                },
            },
            "# 2026-08-20\n",
        ),
    )

    codes = {issue.code for issue in scan_governance(vault)}

    assert "wiki-generated-actor" in codes
    assert "generated-on-non-wiki" in codes

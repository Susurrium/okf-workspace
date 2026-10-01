from __future__ import annotations

import os
from pathlib import Path
from typing import cast

import pytest

from okf_workspace.config import default_template_root
from okf_workspace.dashboard.system import system_status
from okf_workspace.governance import scan_governance
from okf_workspace.migration import migrate_current_layout
from okf_workspace.okf.frontmatter import OkfDocument, parse_document
from okf_workspace.okf.validator import validate_bundle, validate_document, validate_paths
from okf_workspace.projections.tasks import collect_tasks
from okf_workspace.retrieval.context import ContextReader
from okf_workspace.retrieval.index import SearchIndex
from okf_workspace.retrieval.search import HybridSearcher
from okf_workspace.retrieval.vector import HashedNgramEmbedder, VectorIndex

BOARD = (
    "---\ndashboard: true\nworkbench_schema: 1\n"
    "columns: [{id: memo, name: Memo, type: memo}]\n"
    "future_extension: {keep: true}\n---\n"
    "LayoutNonce and a personal memo.\n\n## Memo\n"
    "<!-- okf-section:memo -->\n- [ ] #task Real work ^task-board\n"
)


@pytest.mark.parametrize("relative", ["2.md", "boards/学习.md", "renamed.md", "dashboard.md"])
@pytest.mark.parametrize("profile", [True, False])
def test_workbench_identity_survives_names_and_validator_modes(
    vault: Path,
    relative: str,
    profile: bool,
) -> None:
    path = vault / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(BOARD, encoding="utf-8")
    assert validate_bundle(vault, profile=profile).valid
    assert validate_paths(vault, [relative], profile=profile).valid
    assert path.read_text(encoding="utf-8") == BOARD


@pytest.mark.parametrize("schema", ["", "workbench_schema: 99\n"])
def test_legacy_and_future_workbenches_do_not_require_artifact_fields(
    vault: Path,
    schema: str,
) -> None:
    path = vault / "future.md"
    path.write_text(f"---\ndashboard: true\n{schema}---\nMemo\n", encoding="utf-8")
    assert validate_bundle(vault).valid


def test_artifact_publication_cannot_create_a_workbench(vault: Path) -> None:
    report = validate_document(vault, Path("new-board.md"), parse_document(BOARD))
    assert any(issue.code == "non-artifact-publication" for issue in report.errors)


def test_root_navigation_cannot_be_a_board_and_migration_does_not_destroy_it(vault: Path) -> None:
    path = vault / "index.md"
    path.write_text(BOARD, encoding="utf-8")
    before = path.read_bytes()
    assert any(issue.code == "reserved-workbench" for issue in validate_bundle(vault).errors)
    migrate_current_layout(vault, default_template_root())
    assert path.read_bytes() == before


@pytest.mark.parametrize("relative", ["dashboard.md", "boards/conflict.md"])
@pytest.mark.parametrize("artifact_type", ["Wiki", "Source", "Project"])
def test_workbench_marker_cannot_bypass_artifact_contract(
    vault: Path,
    relative: str,
    artifact_type: str,
) -> None:
    document = OkfDocument({"dashboard": True, "type": artifact_type}, "Memo\n")
    path = vault / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\ndashboard: true\ntype: {artifact_type}\n---\nMemo\n", encoding="utf-8")
    for report in (
        validate_bundle(vault),
        validate_paths(vault, [relative]),
        validate_document(vault, path, document),
    ):
        assert any(issue.code == "document-role-conflict" for issue in report.errors)


@pytest.mark.parametrize(
    "metadata,code",
    [
        ('dashboard: "true"\n', "workbench-marker"),
        ("dashboard: 1\n", "workbench-marker"),
        ("dashboard: true\nworkbench_schema: false\n", "workbench-schema"),
        ("dashboard: true\nworkbench_schema: 0\n", "workbench-schema"),
        ("dashboard: true\ncolumns: [\n", "frontmatter"),
    ],
)
def test_invalid_workbench_metadata_is_diagnosed(vault: Path, metadata: str, code: str) -> None:
    path = vault / "dashboard.md"
    path.write_text(f"---\n{metadata}---\nMemo\n", encoding="utf-8")
    assert any(issue.code == code for issue in validate_bundle(vault).errors)


def test_plain_bad_notes_and_marker_examples_remain_invalid(vault: Path) -> None:
    for name, text in {
        "bad.md": "---\ntitle: Bad\n---\n# Bad\n",
        "example.md": "---\ntitle: Example\n---\n```yaml\ndashboard: true\n```\n",
        "dashboard.md": "---\ntitle: Misnamed note\n---\n# Bad\n",
    }.items():
        (vault / name).write_text(text, encoding="utf-8")
    paths = {issue.path for issue in validate_bundle(vault).errors if issue.code == "missing-type"}
    assert paths == {"bad.md", "example.md", "dashboard.md"}


def test_migration_preserves_workbench_bytes_and_tasks_ignore_backups(vault: Path) -> None:
    contents = {
        "2.md": BOARD,
        "boards/学习.md": BOARD.replace("workbench_schema: 1", "workbench_schema: 99"),
        "boards/index.md": BOARD,
        "boards/log.md": BOARD,
        "conflict.md": BOARD.replace("dashboard: true", "dashboard: true\ntype: Wiki"),
        "knowledge/concepts/board.md": BOARD,
        "learning/topics/board.md": BOARD,
        "sources/records/custom/board.md": BOARD,
        "sources/text/custom/board.md": BOARD,
        "invalid-marker.md": BOARD.replace("dashboard: true", 'dashboard: "true"'),
        "malformed.md": "---\ndashboard: true\ncolumns: [\n---\nMemo\n",
        ".dashboard-backup/old.md": BOARD,
    }
    for relative, text in contents.items():
        path = vault / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text.replace("\n", "\r\n").encode("utf-8"))
    before = {relative: (vault / relative).read_bytes() for relative in contents}
    migrate_current_layout(vault, default_template_root())
    assert {relative: (vault / relative).read_bytes() for relative in contents} == before
    assert {task.path for task in collect_tasks(vault)} >= {
        "2.md",
        "boards/学习.md",
        "boards/index.md",
        "boards/log.md",
    }
    assert not any(task.path.startswith(".dashboard-backup/") for task in collect_tasks(vault))


def test_index_removes_old_workbenches_and_explicit_reads_remain_available(
    vault: Path,
    tmp_path: Path,
) -> None:
    index = SearchIndex(vault, tmp_path / "state/search.sqlite")
    board = vault / "2.md"
    # Seed the old index as an ordinary note, then turn it into a workbench.
    board.write_text("---\ntype: Custom\n---\n# Old\nLayoutNonce\n", encoding="utf-8")
    index.sync()
    assert index.get_file_hash("2.md")
    board.write_text(BOARD, encoding="utf-8")
    backup = vault / ".dashboard-backup/old.md"
    backup.parent.mkdir(parents=True)
    backup.write_text(BOARD, encoding="utf-8")
    index.sync()
    assert index.get_file_hash("2.md") is None
    assert index.get_file_hash(".dashboard-backup/old.md") is None
    assert index.index_path(board, force=True) == (False, 0)
    assert not HybridSearcher(index).search("LayoutNonce", scope="all", refresh_index=False)
    hits = HybridSearcher(index).search("LayoutNonce", scope="all", explicit_paths=("2.md",))
    assert hits and all(hit.path == "2.md" for hit in hits)
    board.write_text(BOARD.replace("personal memo", "edited personal memo"), encoding="utf-8")
    items = ContextReader(index).read(hits)
    assert any("edited personal memo" in item.actual_text for item in items)
    assert index.get_file_hash("2.md") is None


def test_stale_lexical_and_vector_hits_cannot_reintroduce_a_workbench(
    vault: Path,
    tmp_path: Path,
) -> None:
    index = SearchIndex(vault, tmp_path / "state/search.sqlite")
    path = vault / "2.md"
    path.write_text("---\ntype: Custom\n---\n# Memo\nLayoutNonce\n", encoding="utf-8")
    index.sync()
    old_hit = HybridSearcher(index).search("LayoutNonce", scope="all", refresh_index=False)[0]
    vectors = VectorIndex(tmp_path / "state/vectors.sqlite")
    embedder = HashedNgramEmbedder()
    vectors.sync(index, embedder)
    path.write_text(BOARD, encoding="utf-8")
    searcher = HybridSearcher(index, vector_index=vectors, embedder=embedder)
    for mode in ("hybrid", "lexical", "vector"):
        hits = searcher.search("LayoutNonce", scope="all", mode=mode, refresh_index=False)
        assert all(hit.path != "2.md" for hit in hits)
    with pytest.raises(ValueError, match="default retrieval source"):
        ContextReader(index).read_hit(old_hit)
    index.sync()
    vectors.sync(index, embedder)
    with vectors.connect() as connection:
        assert not connection.execute("SELECT 1 FROM vectors WHERE path = '2.md'").fetchone()


def test_rename_preserves_workbench_role_without_plugin_registry(
    vault: Path, tmp_path: Path
) -> None:
    path = vault / "2.md"
    path.write_text(BOARD, encoding="utf-8")
    renamed = vault / "中文工作台.md"
    path.rename(renamed)
    assert validate_paths(vault, [renamed]).valid
    assert any(task.path == renamed.name for task in collect_tasks(vault))
    index = SearchIndex(vault, tmp_path / "state/search.sqlite")
    index.sync()
    assert index.get_file_hash(renamed.name) is None


def test_governance_respects_workbench_owned_metadata(vault: Path) -> None:
    board = vault / "2.md"
    board.write_text(
        BOARD.replace("dashboard: true", "dashboard: true\nstatus: stable\ngenerated: custom"),
        encoding="utf-8",
    )
    backup = vault / ".dashboard-backup/old.md"
    backup.parent.mkdir(parents=True)
    backup.write_text("---\ntype: Wiki\n---\nMemo\n", encoding="utf-8")
    issues = scan_governance(vault)
    assert not any(issue.path in {"2.md", ".dashboard-backup/old.md"} for issue in issues)
    assert parse_document(board.read_text(encoding="utf-8")).frontmatter["generated"] == "custom"


def test_malformed_board_is_diagnosed_and_not_a_default_retrieval_source(
    vault: Path,
    tmp_path: Path,
) -> None:
    path = vault / "2.md"
    path.write_text("---\ndashboard: true\ncolumns: [\n---\nMalformedNonce\n", encoding="utf-8")
    assert any(
        issue.code == "frontmatter" and issue.path == "2.md" for issue in scan_governance(vault)
    )
    index = SearchIndex(vault, tmp_path / "state/search.sqlite")
    index.sync()
    assert index.get_file_hash("2.md") is None


def test_layout_edits_do_not_report_a_stale_knowledge_index(vault: Path, tmp_path: Path) -> None:
    state = tmp_path / "state"
    index = SearchIndex(vault, state / "brain.sqlite")
    index.sync()
    board = vault / "2.md"
    board.write_text(BOARD, encoding="utf-8")
    future = index.database.stat().st_mtime + 60
    os.utime(board, (future, future))
    status = system_status(vault, state)
    actionable = cast(list[dict[str, object]], status["actionable"])
    assert not any(item["item_id"] == "index" for item in actionable)

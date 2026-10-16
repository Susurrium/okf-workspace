from pathlib import Path
from typing import cast

import pytest

from okf_workspace.cli import main
from okf_workspace.dashboard.catalog import scan_notes
from okf_workspace.notes import NoteService
from okf_workspace.okf.frontmatter import read_document, write_document
from okf_workspace.okf.validator import validate_paths
from okf_workspace.retrieval.index import SearchIndex


def test_category_is_optional_and_does_not_move_or_rewrite_legacy_projects(vault: Path) -> None:
    service = NoteService(vault)
    old = service.create_project("legacy", "已有项目")
    before = old.read_bytes()
    new = service.create_project("new", "新项目", category="  科研  ")
    assert read_document(new).frontmatter["project_category"] == "科研"
    assert old.read_bytes() == before
    assert "project_category" not in read_document(old).frontmatter
    assert not validate_paths(vault, [old, new]).errors
    rows = {note.title: note for note in scan_notes(vault)}
    assert rows["已有项目"].project_category is None
    assert rows["新项目"].project_category == "科研"


def test_category_edits_preserve_status_body_extensions_and_related_files(vault: Path) -> None:
    service = NoteService(vault)
    path = service.create_project("demo", "示例", category="科研")
    document = read_document(path)
    document.frontmatter["future"] = {"retained": [1, 2]}
    document.frontmatter["project_status"] = "paused"
    document.body += "\n人工任务与注释：- [ ] #task 不改写 ^task-existing\n"
    write_document(path, document)
    body = read_document(path).body
    log = path.with_name("log.md").read_bytes()
    service.set_project_category("demo", "工具", expected="科研", check_expected=True)
    updated = read_document(path)
    assert updated.body == body
    assert updated.frontmatter["future"] == {"retained": [1, 2]}
    assert updated.frontmatter["project_status"] == "paused"
    assert updated.frontmatter["project_category"] == "工具"
    assert path.with_name("log.md").read_bytes() == log
    before = path.read_bytes()
    with pytest.raises(ValueError, match="目录名称"):
        service.set_project_category("../demo", "不可写入")
    assert path.read_bytes() == before
    with pytest.raises(ValueError, match="已经变化"):
        service.set_project_category("demo", "生活", expected="科研", check_expected=True)
    assert path.read_bytes() == before
    service.set_project_category("demo", None)
    assert "project_category" not in read_document(path).frontmatter


@pytest.mark.parametrize("category", [[], {}, True, "x" * 81, "研究\n生活"])
def test_invalid_category_is_rejected_before_project_creation(
    vault: Path, category: object,
) -> None:
    with pytest.raises(ValueError):
        NoteService(vault).create_project("bad", "无效类别项目", category=cast(str, category))
    assert not (vault / "projects/bad").exists()


def test_cli_and_retrieval_share_the_category(vault: Path) -> None:
    assert main(["note", "new", "project", "--vault", str(vault), "--slug", "cli",
                 "--title", "命令行项目", "--category", "科研"]) == 0
    path = vault / "projects/cli/project.md"
    document = read_document(path)
    document.body += "\n## 实施记录\n\n这个项目用于验证一个本地工具。\n"
    write_document(path, document)
    index = SearchIndex(vault, vault.parent / "category-search.sqlite")
    index.sync()
    assert any(hit.path == "projects/cli/project.md" for hit in index.fts_search("科研"))
    before = path.read_bytes()
    with index.connect() as connection:
        connection.execute("UPDATE metadata SET value = '2' WHERE key = 'schema_version'")
        connection.execute("UPDATE fts_chunks SET search_text = ''")
    upgraded = SearchIndex(vault, vault.parent / "category-search.sqlite")
    upgraded.sync()
    assert any(hit.path == "projects/cli/project.md" for hit in upgraded.fts_search("科研"))
    assert path.read_bytes() == before
    assert main(["project", "category", "cli", "--vault", str(vault),
                 "--category", ""]) == 0
    assert "project_category" not in read_document(path).frontmatter
    index.sync()
    assert not any(hit.path == "projects/cli/project.md" for hit in index.fts_search("科研"))

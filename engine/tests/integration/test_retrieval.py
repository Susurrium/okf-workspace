from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from okf_workspace.notes import NoteService
from okf_workspace.okf.frontmatter import OkfDocument, write_document
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.retrieval.context import ContextReader
from okf_workspace.retrieval.index import SearchIndex
from okf_workspace.retrieval.search import HybridSearcher

NOW = datetime(2026, 8, 17, 9, 30, tzinfo=timezone(timedelta(hours=8)))


def make_index(tmp_path: Path) -> tuple[Path, SearchIndex, NoteService]:
    vault = initialize_vault(tmp_path / "vault")
    index = SearchIndex(vault, tmp_path / "state" / "search.sqlite")
    service = NoteService(vault, clock=lambda: NOW)
    return vault, index, service


def test_fts_exact_scope_and_one_hop_source_expansion(tmp_path: Path) -> None:
    vault, index, service = make_index(tmp_path)
    source = vault / "sources/records/documents/livesync-source.md"
    write_document(
        source,
        OkfDocument(
            {
                "type": "Source",
                "title": "LiveSync 部署原文",
                "status": "stable",
                "resource": "okf-original://sha256/example/guide.md",
                "source_sha256": "example",
            },
            "# LiveSync 部署原文\n\n这里记录原始部署依据。\n",
        ),
    )
    service.create_wiki(
        "LiveSync 不是备份",
        "同步会快速传播删除和损坏，因此不能替代独立容灾备份。",
        sources=["sources/records/documents/livesync-source.md"],
    )
    service.create_daily(content="今天散步，和技术问题无关。")
    index.sync()

    hits = HybridSearcher(index).search(
        "LiveSync 同步为什么不能代替备份",
        scope="technical",
        limit=5,
        refresh_index=False,
    )

    paths = [hit.path for hit in hits]
    assert paths[0].startswith("knowledge/wiki/")
    assert "sources/records/documents/livesync-source.md" in paths
    assert all(not path.startswith("life/") for path in paths)
    assert any("FTS5/BM25" in hit.retrieval_reasons for hit in hits)


def test_context_reader_refreshes_changed_markdown_before_answer(tmp_path: Path) -> None:
    vault, index, service = make_index(tmp_path)
    note = service.create_wiki("Nonce", "当前值是 OLD-NONCE。")
    index.sync()
    hit = HybridSearcher(index).search(
        "OLD-NONCE",
        scope="all",
        limit=1,
        refresh_index=False,
    )[0]

    text = note.read_text(encoding="utf-8").replace("OLD-NONCE", "NEW-NONCE")
    note.write_text(text, encoding="utf-8", newline="\n")
    context = ContextReader(index).read_hit(hit)

    assert "NEW-NONCE" in context.actual_text
    assert "OLD-NONCE" not in context.actual_text
    assert context.refreshed_after_change
    refreshed = HybridSearcher(index).search(
        "NEW-NONCE",
        scope="all",
        limit=1,
        refresh_index=False,
    )
    assert refreshed[0].path == note.relative_to(vault).as_posix()


def test_incremental_sync_skips_unchanged_and_removes_deleted(tmp_path: Path) -> None:
    _, index, service = make_index(tmp_path)
    note = service.create_wiki("可删除笔记", "唯一内容 ALPHA-DELETE。")
    first = index.sync()
    second = index.sync()

    assert first.indexed > 0
    assert second.indexed == 0
    assert second.unchanged == first.indexed

    note.unlink()
    third = index.sync()

    assert third.removed == 1
    assert not HybridSearcher(index).search(
        "ALPHA-DELETE",
        scope="all",
        refresh_index=False,
    )


def test_human_navigation_is_not_an_ai_retrieval_source(tmp_path: Path) -> None:
    vault, index, _service = make_index(tmp_path)
    root_index = vault / "index.md"
    root_index.write_text(
        root_index.read_text(encoding="utf-8") + "\n只用于导航的唯一标记 NAVIGATION-ONLY-NONCE。\n",
        encoding="utf-8",
        newline="\n",
    )

    index.sync()

    assert not HybridSearcher(index).search(
        "NAVIGATION-ONLY-NONCE",
        scope="all",
        refresh_index=False,
    )


def test_runtime_instructions_are_not_indexed_as_personal_knowledge(tmp_path: Path) -> None:
    vault, index, _service = make_index(tmp_path)
    (vault / "AGENTS.md").write_text("RUNTIME-AGENT-NONCE", encoding="utf-8")
    skill = vault / ".agents" / "skills" / "example" / "SKILL.md"
    skill.parent.mkdir(parents=True, exist_ok=True)
    skill.write_text("RUNTIME-SKILL-NONCE", encoding="utf-8")

    index.sync()

    assert not HybridSearcher(index).search(
        "RUNTIME-AGENT-NONCE RUNTIME-SKILL-NONCE",
        scope="all",
        refresh_index=False,
    )

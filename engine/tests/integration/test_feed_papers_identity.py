from __future__ import annotations

from dataclasses import replace
from pathlib import Path

from okf_workspace.feeds.editions import edition_relative_path, materialize_edition
from okf_workspace.feeds.models import FeedEdition, FeedItem, FeedKind
from okf_workspace.okf.frontmatter import read_document, write_document


def _papers(identity: str, title: str) -> FeedEdition:
    edition_id = f"2026-09-08-papers-{identity}"
    return FeedEdition(
        edition_id=edition_id,
        feed=FeedKind.AI_DAILY,
        edition_at="2026-09-08",
        title=title,
        stream="papers",
        items=(FeedItem(identity, FeedKind.AI_DAILY, edition_id, title, f"正文 {title}"),),
    )


def test_two_papers_artifacts_on_one_date_have_distinct_readable_digests(vault: Path) -> None:
    first = _papers("a" * 12, "第一期")
    second = _papers("b" * 12, "修订期")
    first_path = materialize_edition(vault, first)
    second_path = materialize_edition(vault, second)
    assert first_path != second_path
    assert first_path.name == f"{first.edition_id}.md"
    assert read_document(first_path).frontmatter["digest_id"] == first.edition_id
    assert read_document(second_path).frontmatter["digest_id"] == second.edition_id
    assert "修订期" in read_document(second_path).body
    assert materialize_edition(vault, first) == first_path


def test_papers_legacy_path_copies_only_matching_identity_and_keeps_human_content(
    vault: Path,
) -> None:
    first = _papers("a" * 12, "第一期")
    # The previous implementation stored papers at the date-and-stream path.
    legacy_edition = replace(first, stream="papers-legacy")
    seeded = materialize_edition(vault, legacy_edition)
    legacy = seeded.with_name("2026-09-08-papers.md")
    seeded.rename(legacy)
    document = read_document(legacy)
    document.frontmatter["section"] = "papers"
    document.frontmatter["custom"] = "用户字段"
    document.body += "\n用户阅读批注。\n"
    write_document(legacy, document)
    before = legacy.read_bytes()
    matching = materialize_edition(vault, first)
    assert matching == vault / edition_relative_path(first)
    assert read_document(matching).frontmatter["custom"] == "用户字段"
    assert "用户阅读批注" in read_document(matching).body
    second = materialize_edition(vault, _papers("b" * 12, "修订期"))
    assert "用户阅读批注" not in read_document(second).body
    assert legacy.read_bytes() == before


def test_corrupt_legacy_papers_does_not_block_or_get_overwritten(vault: Path) -> None:
    edition = _papers("a" * 12, "第一期")
    legacy = (vault / edition_relative_path(edition)).with_name("2026-09-08-papers.md")
    legacy.parent.mkdir(parents=True, exist_ok=True)
    original = b"Human note without frontmatter\n"
    legacy.write_bytes(original)
    target = materialize_edition(vault, edition)
    assert read_document(target).frontmatter["digest_id"] == edition.edition_id
    assert legacy.read_bytes() == original

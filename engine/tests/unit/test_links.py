from __future__ import annotations

from okf_workspace.retrieval.links import extract_links, normalize_target


def test_wikilink_with_a_vault_path_is_not_resolved_below_current_note() -> None:
    links = extract_links(
        "[[sources/text/documents/manual|完整正文]]",
        source_path="learning/guides/manual.md",
        frontmatter={},
    )

    assert ("sources/text/documents/manual.md", "wiki") in links
    assert not any(path.startswith("learning/guides/sources/") for path, _kind in links)


def test_source_text_and_nested_use_relations_are_indexed() -> None:
    links = extract_links(
        "",
        source_path="sources/records/documents/manual.md",
        frontmatter={
            "text": "/sources/text/documents/manual.md",
            "uses": [
                {
                    "purpose": "study",
                    "course": "/learning/courses/network/course.md",
                    "project": "/projects/vpn/project.md",
                }
            ],
        },
    )

    assert ("sources/text/documents/manual.md", "text") in links
    assert ("learning/courses/network/course.md", "course") in links
    assert ("projects/vpn/project.md", "project") in links


def test_relative_parent_segments_are_collapsed_without_escaping_vault() -> None:
    assert normalize_target("../shared.md", "learning/guides/current.md") == ("learning/shared.md")
    assert normalize_target("../../../escape.md", "learning/guides/current.md") is None

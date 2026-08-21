from __future__ import annotations

from pathlib import Path

import pytest

from okf_workspace.okf.frontmatter import OkfDocument, read_document
from okf_workspace.sources import SourcePublisher


def _documents(vault: Path) -> tuple[Path, Path, OkfDocument, OkfDocument]:
    source = vault / "sources/records/web/example.md"
    source_text = vault / "sources/text/web/example.md"
    source_document = OkfDocument(
        {
            "type": "Source",
            "title": "Example",
            "resource": "https://example.com/article",
            "kind": "web",
            "text": "/sources/text/web/example.md",
            "ingested_via": "web-clip",
            "uses": [{"purpose": "reference"}],
        },
        "# Example\n",
    )
    text_document = OkfDocument(
        {
            "type": "Source Text",
            "title": "Example - 完整正文",
            "parser": "obsidian-web-clipper",
            "sources": [{"resource": "/sources/records/web/example.md"}],
        },
        "# Example\n\n完整正文。\n",
    )
    return source, source_text, source_document, text_document


def test_source_publisher_is_the_pair_write_and_query_boundary(vault: Path) -> None:
    source, source_text, source_document, text_document = _documents(vault)
    publisher = SourcePublisher(vault)

    published = publisher.publish_pair(
        source,
        source_text,
        source_document,
        text_document,
    )

    assert published.source == source
    assert published.source_text == source_text
    assert publisher.resolve_text(read_document(source))[0] == source_text
    found = publisher.find_by_resource(
        "https://example.com/article#fragment",
        normalize=lambda value: value.split("#", 1)[0],
    )
    assert found is not None and found[0] == source


def test_source_publisher_rolls_back_both_authority_files(
    vault: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source, source_text, source_document, text_document = _documents(vault)
    publisher = SourcePublisher(vault)
    publisher.publish_pair(source, source_text, source_document, text_document)
    before_source = source.read_bytes()
    before_text = source_text.read_bytes()
    updated_source = read_document(source)
    updated_text = read_document(source_text)
    updated_source.frontmatter["title"] = "Changed"
    updated_text.body = "# Changed\n\n新正文。\n"

    from okf_workspace.sources import publisher as publisher_module

    real_write = publisher_module.write_document
    writes = 0

    def fail_second_write(path: Path, document: OkfDocument) -> None:
        nonlocal writes
        writes += 1
        if writes == 2:
            raise OSError("simulated second-write failure")
        real_write(path, document)

    monkeypatch.setattr(publisher_module, "write_document", fail_second_write)

    with pytest.raises(OSError, match="second-write"):
        publisher.publish_pair(source, source_text, updated_source, updated_text)

    assert source.read_bytes() == before_source
    assert source_text.read_bytes() == before_text


def test_source_publisher_rejects_cross_bundle_pair(vault: Path) -> None:
    source, _source_text, source_document, text_document = _documents(vault)

    with pytest.raises(ValueError, match="sources/text"):
        SourcePublisher(vault).publish_pair(
            source,
            vault / "knowledge/wiki/not-source-text.md",
            source_document,
            text_document,
        )


def test_source_uses_are_idempotent_and_allow_course_plus_project(vault: Path) -> None:
    from okf_workspace.notes import NoteService

    service = NoteService(vault)
    service.create_course("systems", "系统课")
    service.create_project("deploy", "部署项目")
    _source, _source_text, source_document, _text_document = _documents(vault)
    publisher = SourcePublisher(vault)

    publisher.add_use(
        source_document,
        purpose="study",
        course="systems",
        project="deploy",
    )
    publisher.add_use(
        source_document,
        purpose="study",
        course="systems",
        project="deploy",
    )

    uses = source_document.frontmatter["uses"]
    assert len(uses) == 2
    assert uses[-1] == {
        "purpose": "study",
        "course": "/learning/courses/systems/course.md",
        "project": "/projects/deploy/project.md",
    }


def test_resolving_a_use_removes_only_the_relevant_undecided_context(vault: Path) -> None:
    from okf_workspace.notes import NoteService

    service = NoteService(vault)
    service.create_course("systems", "系统课")
    service.create_project("deploy", "部署项目")
    _source, _source_text, source_document, _text_document = _documents(vault)
    source_document.frontmatter["uses"] = [
        {"purpose": "undecided"},
        {
            "purpose": "undecided",
            "project": "/projects/deploy/project.md",
        },
    ]
    publisher = SourcePublisher(vault)

    publisher.resolve_use(source_document, purpose="study", course="systems")

    assert source_document.frontmatter["uses"] == [
        {
            "purpose": "undecided",
            "project": "/projects/deploy/project.md",
        },
        {
            "purpose": "study",
            "course": "/learning/courses/systems/course.md",
        },
    ]

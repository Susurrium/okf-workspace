from __future__ import annotations

import multiprocessing
from pathlib import Path

import pytest

from okf_workspace.okf.frontmatter import OkfDocument, read_document
from okf_workspace.sources import SourcePublisher


def _use_from_process(vault_path: str, purpose: str) -> None:
    vault = Path(vault_path)
    for _ in range(3):
        for name in ("example", "second"):
            SourcePublisher(vault).update_use(
                vault / f"sources/records/web/{name}.md", purpose=purpose
            )


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

    def fail_second_write(
        path: Path,
        document: OkfDocument,
        *,
        create_only: bool = False,
        expected_sha256: str | None = None,
    ) -> None:
        nonlocal writes
        writes += 1
        if writes == 2:
            raise OSError("simulated second-write failure")
        real_write(path, document, create_only=create_only, expected_sha256=expected_sha256)

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


def test_source_uses_survive_two_processes_and_two_resources(vault: Path) -> None:
    source, text, document, text_document = _documents(vault)
    SourcePublisher(vault).publish_pair(source, text, document, text_document)
    document.frontmatter["text"] = "/sources/text/web/second.md"
    document.frontmatter["resource"] = "https://example.com/second"
    text_document.frontmatter["sources"] = [{"resource": "/sources/records/web/second.md"}]
    SourcePublisher(vault).publish_pair(
        source.with_name("second.md"), text.with_name("second.md"), document, text_document
    )
    context = multiprocessing.get_context("spawn")
    workers = [
        context.Process(target=_use_from_process, args=(str(vault), purpose))
        for purpose in ("study", "wiki")
    ]
    for worker in workers:
        worker.start()
    for worker in workers:
        worker.join(timeout=20)
        if worker.is_alive():
            worker.terminate()
            worker.join(timeout=5)
        assert worker.exitcode == 0
    for path in (source, source.with_name("second.md")):
        uses = read_document(path).frontmatter["uses"]
        assert len(uses) == 3
        assert {use["purpose"] for use in uses} == {"reference", "study", "wiki"}
    assert not (vault / ".source-identity").exists()


def test_source_update_rejects_an_external_edit_after_snapshot(
    vault: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from okf_workspace.okf.file_io import FileWriteConflict
    from okf_workspace.okf.frontmatter import write_document

    source, text, document, text_document = _documents(vault)
    publisher = SourcePublisher(vault)
    publisher.publish_pair(source, text, document, text_document)
    original = publisher.resolve_use
    before_text = text.read_bytes()

    def edit_then_resolve(
        document: OkfDocument,
        *,
        purpose: str,
        course: str | None = None,
        project: str | None = None,
    ) -> object:
        external = read_document(source)
        external.frontmatter["user_field"] = "retained"
        write_document(source, external)
        return original(document, purpose=purpose, course=course, project=project)

    monkeypatch.setattr(publisher, "resolve_use", edit_then_resolve)
    with pytest.raises(FileWriteConflict):
        publisher.update_use(source, purpose="study")
    assert read_document(source).frontmatter["user_field"] == "retained"
    assert text.read_bytes() == before_text


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

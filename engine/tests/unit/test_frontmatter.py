from __future__ import annotations

from pathlib import Path

import pytest

from okf_workspace.okf.frontmatter import (
    FrontmatterError,
    OkfDocument,
    parse_document,
    read_document,
    write_document,
)


def test_round_trip_preserves_unknown_fields(tmp_path: Path) -> None:
    path = tmp_path / "note.md"
    path.write_text(
        "---\ntype: Custom Concept\nunknown_extension:\n  nested: value\n---\n# Body\n",
        encoding="utf-8",
    )

    document = read_document(path)
    document.frontmatter["status"] = "draft"
    write_document(path, document)
    reread = read_document(path)

    assert reread.frontmatter["unknown_extension"]["nested"] == "value"
    assert reread.frontmatter["status"] == "draft"
    assert reread.body.strip() == "# Body"


def test_requires_opening_and_closing_delimiters() -> None:
    with pytest.raises(FrontmatterError):
        parse_document("# no frontmatter\n")
    with pytest.raises(FrontmatterError):
        parse_document("---\ntype: Note\n")


def test_create_only_refuses_to_overwrite(tmp_path: Path) -> None:
    path = tmp_path / "note.md"
    document = OkfDocument({"type": "Reference"}, "# Reference\n")
    write_document(path, document, create_only=True)
    with pytest.raises(FileExistsError):
        write_document(path, document, create_only=True)

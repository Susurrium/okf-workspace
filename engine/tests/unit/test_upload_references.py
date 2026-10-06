from __future__ import annotations

import pytest

from okf_workspace.importers.upload_cleanup import references_attachment


@pytest.mark.parametrize("text", [
    "[PDF](../uploads/id/my%20file.pdf)",
    "![[my file.pdf#page=2|Page]]", "[[my file]]",
    "[PDF](/inbox/uploads/id/my%20file.pdf)",
    "file: /inbox/uploads/id/my file.pdf",
])
def test_cleanup_preserves_encoded_relative_and_short_references(text: str) -> None:
    assert references_attachment(text, "inbox/uploads/id/my file.pdf", "my file.pdf")


def test_original_identity_is_not_an_upload_reference() -> None:
    assert not references_attachment(
        "[Original](obsidian://okf-original?sha256=abc&filename=my%20file.pdf)",
        "inbox/uploads/id/my file.pdf", "my file.pdf",
    )

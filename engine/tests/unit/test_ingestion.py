from __future__ import annotations

import pytest

from okf_workspace.ingestion import normalize_ingested_via


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        ("web-clip", "web-clip"),
        ("file-import", "file-import"),
        ("feed", "feed"),
        ("direct-entry", "direct-entry"),
        ("web-clipper", "web-clip"),
        ("manual-upload", "file-import"),
        ("quick-capture", "direct-entry"),
        ("unknown", None),
        (None, None),
    ],
)
def test_normalize_ingested_via(value: object, expected: str | None) -> None:
    assert normalize_ingested_via(value) == expected

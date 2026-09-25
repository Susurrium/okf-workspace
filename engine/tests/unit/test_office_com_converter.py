from __future__ import annotations

import subprocess
from pathlib import Path
from unittest.mock import patch

import pytest

from okf_workspace.importers.word import OfficeComConverter


def test_legacy_office_conversion_has_a_bounded_timeout(tmp_path: Path) -> None:
    source = tmp_path / "legacy.doc"
    source.write_bytes(b"legacy document")
    destination = tmp_path / "normalized.docx"

    with patch(
        "okf_workspace.importers.word.subprocess.run",
        side_effect=subprocess.TimeoutExpired("powershell.exe", 180),
    ) as run, pytest.raises(RuntimeError, match="timed out"):
        OfficeComConverter().convert(source, destination)

    assert run.call_args.kwargs["timeout"] == 180

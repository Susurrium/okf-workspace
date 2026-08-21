from __future__ import annotations

from collections.abc import Iterator
from pathlib import Path

import pytest

from okf_workspace.okf.templates import initialize_vault


@pytest.fixture
def vault(tmp_path: Path) -> Iterator[Path]:
    yield initialize_vault(tmp_path / "vault")

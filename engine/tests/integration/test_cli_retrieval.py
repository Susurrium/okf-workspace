from __future__ import annotations

import json
from pathlib import Path

import pytest

from okf_workspace.cli import main
from okf_workspace.fixtures import generate_fixture_vault


def test_cli_rebuild_search_and_context_reopen_real_markdown(
    tmp_path: Path,
    capsys: pytest.CaptureFixture[str],
) -> None:
    vault = generate_fixture_vault(tmp_path / "vault")
    state = tmp_path / "state"

    assert (
        main(
            [
                "index",
                "rebuild",
                "--vault",
                str(vault),
                "--state",
                str(state),
            ]
        )
        == 0
    )
    capsys.readouterr()
    assert (
        main(
            [
                "search",
                "FIXTURE-NONCE-20260817",
                "--vault",
                str(vault),
                "--state",
                str(state),
                "--scope",
                "all",
                "--json",
            ]
        )
        == 0
    )
    assert "nonce-note.md" in capsys.readouterr().out
    assert (
        main(
            [
                "context",
                "FIXTURE-NONCE-20260817",
                "--vault",
                str(vault),
                "--state",
                str(state),
                "--scope",
                "all",
                "--no-vector",
                "--json",
            ]
        )
        == 0
    )
    context = capsys.readouterr().out
    context_payload = json.loads(context)
    assert any(
        "当前 nonce：FIXTURE-NONCE-20260817" in item["actual_text"]
        for item in context_payload["actual_reads"]
    )

from __future__ import annotations

import json
from pathlib import Path

import pytest

from okf_workspace import cli
from okf_workspace.cli import build_parser
from okf_workspace.config import default_template_root
from okf_workspace.okf.frontmatter import OkfDocument, write_document
from okf_workspace.okf.templates import initialize_vault


def test_resources_sync_updates_contracts_without_migrating_user_notes(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    source = vault / "sources/records/pdf/original-only.md"
    write_document(source, OkfDocument({
        "type": "Source", "title": "仅保存原件", "created_at": "2026-10-15T09:00:00+08:00",
        "resource": "/sources/originals/sample.pdf", "kind": "pdf", "ingested_via": "file-import",
        "uses": [{"purpose": "reference"}],
    }, "# 仅保存原件\n"))
    before = source.read_bytes()
    contract = vault / "system/contracts/source.yaml"
    template_contract = default_template_root() / "system/contracts/source.yaml"
    assert template_contract.is_file()
    contract.write_text("obsolete", encoding="utf-8")
    interactive = next((vault / "system/templates/interactive").rglob("*.md"))
    interactive.write_text("用户模板\n", encoding="utf-8")

    assert cli.main(["resources", "sync", "--vault", str(vault)]) == 0
    assert contract.read_bytes() == template_contract.read_bytes()
    assert interactive.read_text(encoding="utf-8") == "用户模板\n"
    assert source.read_bytes() == before
    assert not (vault / "sources/text/pdf/original-only.md").exists()


def test_cli_exposes_m1_commands() -> None:
    parser = build_parser()

    assert parser.parse_args(["init", "--vault", "vault"]).with_git is False
    assert parser.parse_args(["init", "--vault", "vault", "--with-git"]).with_git is True
    assert parser.parse_args(["validate", "--vault", "vault"]).command == "validate"
    assert parser.parse_args(["note", "new", "daily", "--vault", "vault"]).kind == "daily"
    review = parser.parse_args(
        ["note", "new", "review", "--period", "monthly", "--date", "2026-08-01"]
    )
    assert review.kind == "review"
    assert review.period == "monthly"
    assert parser.parse_args(["tasks", "rebuild", "--vault", "vault"]).command == "tasks"
    assert parser.parse_args(["index", "rebuild", "--vault", "vault"]).command == "index"
    assert parser.parse_args(["search", "同步与备份"]).command == "search"
    assert parser.parse_args(["ask", "同步与备份", "--scope", "technical"]).scope == ("technical")
    assert (
        parser.parse_args(
            [
                "organize",
                "inbox/captures/example.md",
                "--as",
                "wiki",
            ]
        ).destination
        == "wiki"
    )
    assert parser.parse_args(["test", "retrieval"]).test_command == "retrieval"
    assert parser.parse_args(["import", "paper.pdf", "--intent", "learn"]).quality == "quick"
    assert (
        parser.parse_args(
            ["conversion", "retry", "conv-example", "--parser", "markitdown"]
        ).conversion_command
        == "retry"
    )


def test_doctor_json_is_safe_across_native_powershell_code_pages(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    capsys: pytest.CaptureFixture[str],
) -> None:
    status: dict[str, object] = {
        "version": "1.10.0",
        "items": [
            {
                "item_id": "index",
                "label": "全文索引",
                "status": "stale",
                "detail": "需要重建",
                "action": "重建索引",
            }
        ],
        "actionable": [
            {
                "item_id": "index",
                "label": "全文索引",
                "status": "stale",
                "detail": "需要重建",
                "action": "重建索引",
            }
        ],
    }

    def fake_system_status(_vault: Path, _state: Path) -> dict[str, object]:
        return status

    monkeypatch.setattr(cli, "system_status", fake_system_status)
    vault = tmp_path / "中文 Vault"
    state = tmp_path / "运行状态"
    missing_config = tmp_path / "missing-deployment.json"

    assert (
        cli.main(
            [
                "doctor",
                "--verbose",
                "--vault",
                str(vault),
                "--state",
                str(state),
                "--config",
                str(missing_config),
            ]
        )
        == 0
    )

    captured = capsys.readouterr()
    assert captured.err == ""
    transport = captured.out.encode("ascii")
    assert b"\\u5168\\u6587\\u7d22\\u5f15" in transport
    for native_code_page in ("utf-8", "gb18030", "cp437"):
        parsed = json.loads(transport.decode(native_code_page))
        assert parsed["items"][0]["label"] == "全文索引"
        assert parsed["items"][0]["detail"] == "需要重建"

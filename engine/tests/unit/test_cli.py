from __future__ import annotations

from okf_workspace.cli import build_parser


def test_cli_exposes_m1_commands() -> None:
    parser = build_parser()

    assert parser.parse_args(["init", "--vault", "vault"]).with_git is False
    assert parser.parse_args(["init", "--vault", "vault", "--with-git"]).with_git is True
    assert parser.parse_args(["validate", "--vault", "vault"]).command == "validate"
    assert parser.parse_args(["note", "new", "daily", "--vault", "vault"]).kind == "daily"
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
    assert parser.parse_args(["import", "paper.pdf", "--intent", "learn"]).quality == "high"
    assert (
        parser.parse_args(
            ["conversion", "retry", "conv-example", "--parser", "markitdown"]
        ).conversion_command
        == "retry"
    )

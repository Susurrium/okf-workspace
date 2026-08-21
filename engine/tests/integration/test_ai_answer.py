from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

from okf_workspace.ai.answer import AnswerService
from okf_workspace.ai.provider import ChatProvider
from okf_workspace.notes import NoteService
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.retrieval.context import ContextReader
from okf_workspace.retrieval.index import SearchIndex
from okf_workspace.retrieval.search import HybridSearcher

NOW = datetime(2026, 8, 17, 9, 30, tzinfo=timezone(timedelta(hours=8)))


class RecordingProvider(ChatProvider):
    def __init__(self) -> None:
        self.user_prompt = ""

    def complete(self, *, system: str, user: str) -> str:
        assert "只能把“实际读取的本地笔记”" in system
        self.user_prompt = user
        return "本地笔记指出同步不能替代独立备份。[笔记 1]"


def test_answer_provider_receives_actual_markdown_and_user_sees_read_list(
    tmp_path: Path,
) -> None:
    vault = initialize_vault(tmp_path / "vault")
    NoteService(vault, clock=lambda: NOW).create_wiki(
        "LiveSync 原则",
        "同步会传播误删除，所以必须保留独立备份。",
    )
    index = SearchIndex(vault, tmp_path / "state" / "search.sqlite")
    index.sync()
    provider = RecordingProvider()
    service = AnswerService(
        HybridSearcher(index),
        ContextReader(index),
        provider,
    )

    result = service.ask("LiveSync 为什么不是备份", scope="technical")

    assert "同步会传播误删除" in provider.user_prompt
    assert "本次使用的笔记" in result.answer
    assert "knowledge/wiki/LiveSync-原则.md" in result.answer
    assert result.contexts[0].current_text_hash

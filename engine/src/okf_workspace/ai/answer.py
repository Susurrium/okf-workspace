"""Answer from real ContextItems and append an auditable read list."""

from __future__ import annotations

from dataclasses import dataclass

from okf_workspace.retrieval.context import ContextReader
from okf_workspace.retrieval.models import ContextItem, SearchHit
from okf_workspace.retrieval.search import HybridSearcher, ScopeName

from .provider import ChatProvider

SYSTEM_PROMPT = """你是用户本地 OKF 第二大脑的阅读助手。
只能把“实际读取的本地笔记”区块当作本地证据。
明确区分：本地笔记中的内容、你的一般知识、需要联网核对的信息。
如果材料不足，直接说明缺少什么，不要补造用户事实。
不要声称用户已经学习、认可或掌握某个内容。
回答正文中使用 [笔记 N] 标注本地依据。"""


@dataclass(frozen=True, slots=True)
class AnswerResult:
    answer: str
    contexts: tuple[ContextItem, ...]
    candidates: tuple[SearchHit, ...]


def _context_prompt(query: str, contexts: list[ContextItem]) -> str:
    blocks: list[str] = []
    for index, item in enumerate(contexts, start=1):
        blocks.append(
            f"[笔记 {index}]\n"
            f"路径：{item.path}\n"
            f"章节：{item.heading}\n"
            f"行号：{item.start_line}-{item.end_line}\n"
            f"实际读取正文：\n{item.actual_text}"
        )
    joined = "\n\n---\n\n".join(blocks)
    return f"用户问题：{query}\n\n以下是本次实际读取的本地笔记：\n\n{joined}"


def _used_notes(contexts: list[ContextItem]) -> str:
    if not contexts:
        return "\n\n本次使用的笔记：无。"
    lines = [
        f"- [{item.path}](/{item.path}) — {item.heading} (L{item.start_line}-L{item.end_line})"
        for item in contexts
    ]
    return "\n\n本次使用的笔记：\n" + "\n".join(lines)


class AnswerService:
    def __init__(
        self,
        searcher: HybridSearcher,
        reader: ContextReader,
        provider: ChatProvider,
    ) -> None:
        self.searcher = searcher
        self.reader = reader
        self.provider = provider

    def ask(
        self,
        query: str,
        *,
        scope: ScopeName = "auto",
        explicit_paths: tuple[str, ...] = (),
        candidate_limit: int = 8,
        context_limit: int = 6,
    ) -> AnswerResult:
        hits = self.searcher.search(
            query,
            scope=scope,
            explicit_paths=explicit_paths,
            limit=candidate_limit,
        )
        contexts = self.reader.read(hits, limit=context_limit)
        if not contexts:
            answer = (
                "当前本地笔记没有检索到足以回答这个问题的内容。可以指定一篇笔记，或先导入相关来源。"
            )
        else:
            answer = self.provider.complete(
                system=SYSTEM_PROMPT,
                user=_context_prompt(query, contexts),
            )
        return AnswerResult(
            answer=answer + _used_notes(contexts),
            contexts=tuple(contexts),
            candidates=tuple(hits),
        )

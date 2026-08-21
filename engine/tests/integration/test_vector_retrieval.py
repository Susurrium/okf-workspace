from __future__ import annotations

from collections.abc import Sequence
from datetime import datetime, timedelta, timezone
from pathlib import Path

from okf_workspace.notes import NoteService
from okf_workspace.okf.templates import initialize_vault
from okf_workspace.retrieval.index import SearchIndex
from okf_workspace.retrieval.search import HybridSearcher
from okf_workspace.retrieval.vector import Embedder, VectorIndex

NOW = datetime(2026, 8, 17, 9, 30, tzinfo=timezone(timedelta(hours=8)))


class MeaningEmbedder(Embedder):
    @property
    def model_id(self) -> str:
        return "test-meaning-v1"

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        vectors: list[list[float]] = []
        for text in texts:
            if any(term in text for term in ("容灾", "灾难恢复", "独立副本")):
                vectors.append([1.0, 0.0])
            elif "食堂" in text:
                vectors.append([0.0, 1.0])
            else:
                vectors.append([0.1, 0.1])
        return vectors


def test_vector_layer_is_optional_rebuildable_and_rrf_merged(tmp_path: Path) -> None:
    vault = initialize_vault(tmp_path / "vault")
    service = NoteService(vault, clock=lambda: NOW)
    service.create_wiki("备份原则", "重要数据需要独立副本。")
    service.create_wiki("午饭", "今天去食堂。")
    index = SearchIndex(vault, tmp_path / "state" / "search.sqlite")
    index.sync()

    lexical_only = HybridSearcher(index).search(
        "灾难恢复",
        scope="all",
        refresh_index=False,
    )
    assert all("备份原则" not in hit.heading for hit in lexical_only)

    vectors = VectorIndex(tmp_path / "state" / "vectors.sqlite")
    embedder = MeaningEmbedder()
    assert vectors.sync(index, embedder) > 0
    hybrid = HybridSearcher(
        index,
        vector_index=vectors,
        embedder=embedder,
    ).search(
        "灾难恢复",
        scope="all",
        refresh_index=False,
        limit=3,
    )

    assert "备份原则" in hybrid[0].heading
    assert any(reason.startswith("vector:") for reason in hybrid[0].retrieval_reasons)
    assert vectors.model_ids() == {"test-meaning-v1"}

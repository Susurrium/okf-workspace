"""Deterministic exact + FTS + optional vector retrieval with one-hop expansion."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import PurePosixPath
from typing import Literal

from .index import SearchIndex
from .models import SearchHit
from .scope import path_in_scope
from .vector import Embedder, VectorIndex

ScopeName = Literal["auto", "all", "technical", "learning", "projects", "life"]
RetrievalMode = Literal["hybrid", "lexical", "vector"]

_TECHNICAL_TERMS = {
    "api",
    "code",
    "docker",
    "git",
    "linux",
    "livesync",
    "obsidian",
    "python",
    "server",
    "tun",
    "vpn",
    "代理",
    "代码",
    "同步",
    "域名",
    "技术",
    "检索",
    "服务器",
    "网络",
    "部署",
}


@dataclass(frozen=True, slots=True)
class SearchScope:
    include_prefixes: tuple[str, ...] = ()
    exclude_prefixes: tuple[str, ...] = ()


def infer_scope(query: str, requested: ScopeName) -> SearchScope:
    if requested == "all":
        return SearchScope()
    if requested == "technical":
        return SearchScope(include_prefixes=("knowledge/", "sources/", "learning/", "projects/"))
    if requested == "learning":
        return SearchScope(include_prefixes=("learning/", "knowledge/", "sources/"))
    if requested == "projects":
        return SearchScope(include_prefixes=("projects/", "knowledge/", "sources/"))
    if requested == "life":
        return SearchScope(include_prefixes=("life/", "inbox/"))
    lowered = query.casefold()
    if any(term in lowered for term in _TECHNICAL_TERMS):
        return SearchScope(include_prefixes=("knowledge/", "sources/", "learning/", "projects/"))
    return SearchScope(exclude_prefixes=("self/",))


def _merge_rankings(
    rankings: list[tuple[str, list[SearchHit]]],
    *,
    rrf_constant: int = 60,
) -> list[SearchHit]:
    source_weights = {
        "explicit": 10.0,
        "exact": 3.0,
        "lexical": 1.0,
        "vector": 1.0,
    }
    scores: dict[tuple[str, str, int], float] = {}
    values: dict[tuple[str, str, int], SearchHit] = {}
    reasons: dict[tuple[str, str, int], list[str]] = {}
    for source, hits in rankings:
        for rank, hit in enumerate(hits, start=1):
            identity = hit.identity
            scores[identity] = scores.get(identity, 0.0) + source_weights.get(
                source,
                1.0,
            ) / (rrf_constant + rank)
            values[identity] = hit
            reason_values = reasons.setdefault(identity, [])
            for reason in (*hit.retrieval_reasons, source):
                if reason not in reason_values:
                    reason_values.append(reason)
    ordered = sorted(
        values,
        key=lambda identity: (-scores[identity], identity),
    )
    return [
        SearchHit(
            path=values[identity].path,
            heading=values[identity].heading,
            start_line=values[identity].start_line,
            end_line=values[identity].end_line,
            text_hash=values[identity].text_hash,
            score=scores[identity],
            retrieval_reasons=tuple(reasons[identity]),
        )
        for identity in ordered
    ]


def _diverse(hits: list[SearchHit], limit: int) -> list[SearchHit]:
    selected: list[SearchHit] = []
    per_path: dict[str, int] = {}
    for hit in hits:
        if per_path.get(hit.path, 0) >= 2:
            continue
        selected.append(hit)
        per_path[hit.path] = per_path.get(hit.path, 0) + 1
        if len(selected) >= limit:
            break
    return selected


class HybridSearcher:
    def __init__(
        self,
        index: SearchIndex,
        *,
        vector_index: VectorIndex | None = None,
        embedder: Embedder | None = None,
    ) -> None:
        if (vector_index is None) != (embedder is None):
            raise ValueError("vector_index and embedder must be configured together")
        self.index = index
        self.vector_index = vector_index
        self.embedder = embedder

    def search(
        self,
        query: str,
        *,
        scope: ScopeName = "auto",
        mode: RetrievalMode = "hybrid",
        explicit_paths: tuple[str, ...] = (),
        limit: int = 8,
        refresh_index: bool = True,
    ) -> list[SearchHit]:
        if limit <= 0:
            return []
        if mode == "vector" and (self.vector_index is None or self.embedder is None):
            raise ValueError("vector retrieval mode requires a vector index and embedder")
        if refresh_index:
            self.index.sync()
        boundaries = infer_scope(query, scope)
        rankings: list[tuple[str, list[SearchHit]]] = []

        explicit: list[SearchHit] = []
        for raw in explicit_paths:
            value = PurePosixPath(raw.lstrip("/")).as_posix()
            chunks = self.index.chunks_for_paths([value])
            explicit.extend(
                SearchHit(
                    path=chunk.path,
                    heading=chunk.heading,
                    start_line=chunk.start_line,
                    end_line=chunk.end_line,
                    text_hash=chunk.text_hash,
                    score=10.0,
                    retrieval_reasons=("explicit path",),
                )
                for chunk in chunks
            )
        if explicit:
            rankings.append(("explicit", explicit))

        if mode != "vector":
            exact = self.index.exact_search(
                query,
                include_prefixes=boundaries.include_prefixes,
                exclude_prefixes=boundaries.exclude_prefixes,
                limit=max(limit * 2, 10),
            )
            if exact:
                rankings.append(("exact", exact))
            lexical = self.index.fts_search(
                query,
                include_prefixes=boundaries.include_prefixes,
                exclude_prefixes=boundaries.exclude_prefixes,
                limit=max(limit * 3, 20),
            )
            if lexical:
                rankings.append(("lexical", lexical))
        if mode != "lexical" and self.vector_index is not None and self.embedder is not None:
            vectors = self.vector_index.search(
                query,
                self.embedder,
                include_prefixes=boundaries.include_prefixes,
                exclude_prefixes=boundaries.exclude_prefixes,
                limit=max(limit * 3, 20),
            )
            if vectors:
                rankings.append(("vector", vectors))

        merged = _merge_rankings(rankings)
        primary = _diverse(merged, limit)
        if mode != "hybrid":
            return primary
        related = self.index.related_paths(hit.path for hit in primary)
        existing_paths = {hit.path for hit in primary}
        expanded = [
            hit
            for path in sorted(related - existing_paths)
            if path_in_scope(path, boundaries.include_prefixes, boundaries.exclude_prefixes)
            if (hit := self.index.first_chunk(path)) is not None
        ]
        reserved = min(2, len(expanded), max(0, limit - 1))
        return primary[: limit - reserved] + expanded[:reserved]

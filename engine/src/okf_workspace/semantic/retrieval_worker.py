"""Short-lived, killable context retrieval for semantic operations."""

from __future__ import annotations

import argparse
import json
import os
import tempfile
from collections.abc import Mapping
from pathlib import Path
from typing import Literal, cast

from okf_workspace.retrieval.context import ContextReader
from okf_workspace.retrieval.index import SearchIndex
from okf_workspace.retrieval.search import HybridSearcher
from okf_workspace.retrieval.vector import FastEmbedder, VectorIndex

RetrievalMode = Literal["hybrid", "lexical"]


def retrieve_candidates(
    vault: Path,
    state: Path,
    *,
    query: str,
    sources: tuple[str, ...],
    mode: RetrievalMode,
) -> tuple[tuple[str, ...], RetrievalMode]:
    """Return paths only after re-opening real Markdown through ContextReader."""

    index = SearchIndex(vault, state / "brain.sqlite")
    index.sync()
    actual_mode: RetrievalMode = mode
    searcher = HybridSearcher(index)
    if mode == "hybrid" and (state / "vectors.sqlite").is_file():
        try:
            searcher = HybridSearcher(
                index,
                vector_index=VectorIndex(state / "vectors.sqlite"),
                embedder=FastEmbedder(),
            )
        except RuntimeError:
            actual_mode = "lexical"
    else:
        actual_mode = "lexical"
    try:
        hits = searcher.search(
            query,
            scope="learning",
            mode=actual_mode,
            explicit_paths=sources,
            limit=8,
            refresh_index=False,
        )
    except (OSError, RuntimeError, ValueError):
        if actual_mode == "lexical":
            raise
        actual_mode = "lexical"
        hits = HybridSearcher(index).search(
            query,
            scope="learning",
            mode="lexical",
            explicit_paths=sources,
            limit=8,
            refresh_index=False,
        )
    contexts = ContextReader(index).read(hits, limit=6)
    return tuple(dict.fromkeys(item.path for item in contexts)), actual_mode


def _load_request(path: Path) -> tuple[str, tuple[str, ...]]:
    loaded = cast(object, json.loads(path.read_text(encoding="utf-8")))
    if not isinstance(loaded, dict):
        raise ValueError("retrieval request must be an object")
    request = cast(Mapping[str, object], loaded)
    query = request.get("query")
    sources = request.get("sources", [])
    if not isinstance(query, str):
        raise ValueError("retrieval query must be text")
    if not isinstance(sources, list):
        raise ValueError("retrieval sources must be text paths")
    source_values = cast(list[object], sources)
    if not all(isinstance(item, str) for item in source_values):
        raise ValueError("retrieval sources must be text paths")
    return query, tuple(cast(list[str], source_values))


def _write_result(path: Path, paths: tuple[str, ...], mode: RetrievalMode) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, name = tempfile.mkstemp(prefix=".retrieval.", suffix=".tmp", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8", newline="\n") as handle:
            json.dump({"paths": list(paths), "mode": mode}, handle, ensure_ascii=False)
            handle.write("\n")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="okf-semantic-retrieval")
    parser.add_argument("--vault", type=Path, required=True)
    parser.add_argument("--state", type=Path, required=True)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--mode", choices=("hybrid", "lexical"), required=True)
    args = parser.parse_args(argv)
    query, sources = _load_request(args.request)
    paths, actual_mode = retrieve_candidates(
        args.vault.resolve(),
        args.state.resolve(),
        query=query,
        sources=sources,
        mode=cast(RetrievalMode, args.mode),
    )
    _write_result(args.output, paths, actual_mode)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

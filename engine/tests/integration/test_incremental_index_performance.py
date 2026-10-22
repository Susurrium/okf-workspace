from __future__ import annotations

import cProfile
import os
import pstats
from pathlib import Path
from typing import cast

import pytest

from okf_workspace.retrieval.index import SearchIndex
from okf_workspace.retrieval.vector import HashedNgramEmbedder, VectorIndex


def make_index(tmp_path: Path) -> tuple[SearchIndex, Path, Path]:
    vault = tmp_path / "vault"
    vault.mkdir()
    first = vault / "first.md"
    second = vault / "second.md"
    for path in (first, second):
        path.write_text(
            f"---\ntype: Wiki\ntitle: {path.stem}\nstatus: stable\n---\n\nRouting vpn evidence.\n",
            encoding="utf-8",
        )
    index = SearchIndex(vault, tmp_path / "state" / "index.sqlite")
    index.sync()
    return index, first, second


def test_unchanged_reconciliation_does_not_parse_yaml(tmp_path: Path) -> None:
    index, _, _ = make_index(tmp_path)
    profiler = cProfile.Profile()
    result = profiler.runcall(index.sync)
    functions = pstats.Stats(profiler).get_stats_profile().func_profiles
    assert result.unchanged == 2
    assert "parse_document" not in functions


def test_identical_content_refreshes_file_version(tmp_path: Path) -> None:
    index, first, _ = make_index(tmp_path)
    version = first.stat()
    os.utime(first, ns=(version.st_atime_ns, version.st_mtime_ns + 2_000_000_000))
    assert index.sync().indexed == 0
    with index.connect() as connection:
        row = connection.execute(
            "SELECT modified_ns FROM documents WHERE path = 'first.md'"
        ).fetchone()
    assert row is not None and row["modified_ns"] == first.stat().st_mtime_ns


def test_explicit_paths_preserve_other_documents_and_detect_same_size_changes(
    tmp_path: Path,
) -> None:
    index, first, second = make_index(tmp_path)
    version = first.stat()
    first.write_text(
        first.read_text(encoding="utf-8").replace("Routing", "Changed"), encoding="utf-8"
    )
    os.utime(first, ns=(version.st_atime_ns, version.st_mtime_ns))
    result = index.sync(paths=["first.md"])
    assert result.indexed == 1
    assert index.fts_search("Changed")[0].path == "first.md"
    assert index.get_file_hash(second.name) is not None
    first.unlink()
    assert index.sync(paths=["first.md"]).removed == 1
    assert index.get_file_hash(second.name) is not None


def test_changed_role_and_renamed_directory_remove_old_search_results(tmp_path: Path) -> None:
    index, first, _ = make_index(tmp_path)
    first.write_text("---\ndashboard: true\n---\nRouting hidden.\n", encoding="utf-8")
    index.sync(paths=["first.md"])
    assert index.get_file_hash("first.md") is None
    folder = index.vault / "目录"
    folder.mkdir()
    note = folder / "笔记.md"
    note.write_text("Plain directory evidence.", encoding="utf-8")
    index.sync(paths=["目录"])
    assert index.get_file_hash("目录/笔记.md")
    folder.rename(index.vault / "新目录")
    index.sync(paths=["目录", "新目录"])
    assert index.get_file_hash("目录/笔记.md") is None
    assert index.get_file_hash("新目录/笔记.md")


@pytest.mark.parametrize(
    "unsafe",
    [
        "../outside.md",
        "C:/outside.md",
        "//host/share/note.md",
        "folder/note.md:stream",
        "CON.md",
        "folder/aux/note.md",
        ".",
    ],
)
def test_incremental_paths_reject_escape_before_mutation(tmp_path: Path, unsafe: str) -> None:
    index, _, _ = make_index(tmp_path)
    with pytest.raises(ValueError):
        index.sync(paths=["first.md", unsafe])
    assert index.get_file_hash("first.md")


def test_noop_vector_sync_preserves_cached_matrix_and_cross_instance_changes_invalidate(
    tmp_path: Path,
) -> None:
    index, first, _ = make_index(tmp_path)
    vectors = VectorIndex(tmp_path / "state" / "vectors.sqlite")
    embedder = HashedNgramEmbedder(32)
    vectors.sync(index, embedder)
    vectors.search("Routing vpn", embedder)
    cached_models = cast(dict[str, object], vars(vectors)["_numpy_cache"])
    cache = cached_models[embedder.model_id]
    assert vectors.sync(index, embedder) == 0
    assert cached_models[embedder.model_id] is cache
    first.write_text("---\ntype: Wiki\n---\nNEW-VECTOR-EVIDENCE", encoding="utf-8")
    index.sync()
    VectorIndex(vectors.database).sync(index, embedder)
    vectors.search("NEW-VECTOR-EVIDENCE", embedder)
    assert cached_models[embedder.model_id] is not cache

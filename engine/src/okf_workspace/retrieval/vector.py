"""Optional, local, and fully rebuildable vector retrieval."""

from __future__ import annotations

import hashlib
import importlib
import math
import sqlite3
from array import array
from collections.abc import Callable, Generator, Iterable, Sequence
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Protocol, cast

from .index import SearchIndex
from .models import SearchHit
from .scope import path_in_scope


class Embedder(Protocol):
    @property
    def model_id(self) -> str: ...

    def embed(self, texts: Sequence[str]) -> list[list[float]]: ...


@dataclass(frozen=True, slots=True)
class _NumpyCache:
    matrix: Any
    norms: Any
    metadata: tuple[tuple[str, str, int, int, str], ...]


class HashedNgramEmbedder:
    """Small deterministic test/fallback vectorizer; not a semantic model."""

    def __init__(self, dimensions: int = 384) -> None:
        self.dimensions = dimensions

    @property
    def model_id(self) -> str:
        return f"hashed-char-ngram-v1-{self.dimensions}"

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        return [self._one(text) for text in texts]

    def _one(self, text: str) -> list[float]:
        normalized = "".join(text.casefold().split())
        vector = [0.0] * self.dimensions
        grams = [
            normalized[index : index + size]
            for size in (2, 3)
            for index in range(max(0, len(normalized) - size + 1))
        ]
        for gram in grams:
            digest = hashlib.blake2b(gram.encode("utf-8"), digest_size=8).digest()
            number = int.from_bytes(digest, "little")
            slot = number % self.dimensions
            vector[slot] += -1.0 if number & 1 else 1.0
        magnitude = math.sqrt(sum(value * value for value in vector))
        return [value / magnitude for value in vector] if magnitude else vector


class FastEmbedder:
    """Production local Chinese embedding through the optional fastembed extra."""

    def __init__(self, model: str = "BAAI/bge-small-zh-v1.5") -> None:
        try:
            module = importlib.import_module("fastembed")
        except ModuleNotFoundError as exc:
            raise RuntimeError(
                "vector model is not installed; run: uv sync --extra vector"
            ) from exc
        embedding_class = module.TextEmbedding
        self._model = embedding_class(model_name=model)
        self._model_id = f"fastembed:{model}"

    @property
    def model_id(self) -> str:
        return self._model_id

    def embed(self, texts: Sequence[str]) -> list[list[float]]:
        values = self._model.embed(list(texts))
        return [[float(value) for value in vector] for vector in values]


def _blob(vector: Sequence[float]) -> bytes:
    return array("f", vector).tobytes()


def _vector(blob: bytes) -> list[float]:
    values = array("f")
    values.frombytes(blob)
    return list(values)


def _cosine(left: Sequence[float], right: Sequence[float]) -> float:
    if len(left) != len(right) or not left:
        return 0.0
    dot = sum(a * b for a, b in zip(left, right, strict=True))
    left_size = math.sqrt(sum(value * value for value in left))
    right_size = math.sqrt(sum(value * value for value in right))
    if not left_size or not right_size:
        return 0.0
    return dot / (left_size * right_size)


class VectorIndex:
    def __init__(self, database: Path) -> None:
        self.database = database.resolve()
        self._numpy_cache: dict[str, _NumpyCache] = {}
        self._numpy_cache_versions: dict[str, int] = {}
        self.database.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as connection:
            connection.executescript(
                """
                CREATE TABLE IF NOT EXISTS vectors (
                    chunk_id TEXT PRIMARY KEY,
                    path TEXT NOT NULL,
                    heading TEXT NOT NULL,
                    start_line INTEGER NOT NULL,
                    end_line INTEGER NOT NULL,
                    text_hash TEXT NOT NULL,
                    model_id TEXT NOT NULL,
                    dimensions INTEGER NOT NULL,
                    vector BLOB NOT NULL
                );
                CREATE INDEX IF NOT EXISTS vectors_path ON vectors(path);
                CREATE TABLE IF NOT EXISTS vector_metadata (
                    key TEXT PRIMARY KEY, value INTEGER NOT NULL
                );
                INSERT OR IGNORE INTO vector_metadata VALUES ('generation', 0);
                CREATE TRIGGER IF NOT EXISTS vectors_insert AFTER INSERT ON vectors BEGIN
                    UPDATE vector_metadata SET value = value + 1 WHERE key = 'generation';
                END;
                CREATE TRIGGER IF NOT EXISTS vectors_delete AFTER DELETE ON vectors BEGIN
                    UPDATE vector_metadata SET value = value + 1 WHERE key = 'generation';
                END;
                CREATE TRIGGER IF NOT EXISTS vectors_update AFTER UPDATE ON vectors BEGIN
                    UPDATE vector_metadata SET value = value + 1 WHERE key = 'generation';
                END;
                """
            )

    @contextmanager
    def connect(self) -> Generator[sqlite3.Connection, None, None]:
        connection = sqlite3.connect(self.database)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode = WAL")
        try:
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    def sync(
        self,
        search_index: SearchIndex,
        embedder: Embedder,
        *,
        batch_size: int = 32,
        progress: Callable[[int, int], None] | None = None,
        should_cancel: Callable[[], bool] | None = None,
    ) -> int:
        fingerprints = search_index.chunk_fingerprints()
        active_ids = set(fingerprints)
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT chunk_id, text_hash, model_id FROM vectors"
            ).fetchall()
            existing = {
                str(row["chunk_id"]): (str(row["text_hash"]), str(row["model_id"])) for row in rows
            }
            removed_ids = set(existing) - active_ids
            for chunk_id in removed_ids:
                connection.execute("DELETE FROM vectors WHERE chunk_id = ?", (chunk_id,))

        pending = [
            chunk_id
            for chunk_id, digest in fingerprints.items()
            if existing.get(chunk_id) != (digest, embedder.model_id)
        ]
        written = 0
        if progress is not None:
            progress(0, len(pending))
        for offset in range(0, len(pending), batch_size):
            if should_cancel is not None and should_cancel():
                break
            batch = search_index.chunks_for_ids(pending[offset : offset + batch_size])
            vectors = embedder.embed([f"{chunk.heading}\n{chunk.text}" for chunk in batch])
            if len(vectors) != len(batch):
                raise RuntimeError("embedding provider returned the wrong vector count")
            with self.connect() as connection:
                for chunk, vector in zip(batch, vectors, strict=True):
                    connection.execute(
                        """
                        INSERT OR REPLACE INTO vectors(
                            chunk_id, path, heading, start_line, end_line,
                            text_hash, model_id, dimensions, vector
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            chunk.chunk_id,
                            chunk.path,
                            chunk.heading,
                            chunk.start_line,
                            chunk.end_line,
                            chunk.text_hash,
                            embedder.model_id,
                            len(vector),
                            _blob(vector),
                        ),
                    )
                    written += 1
            if progress is not None:
                progress(written, len(pending))
        if written or removed_ids:
            self._numpy_cache.clear()
            self._numpy_cache_versions.clear()
        return written

    def _load_numpy_cache(self, model_id: str) -> _NumpyCache | None:
        try:
            numpy = importlib.import_module("numpy")
        except ModuleNotFoundError:
            return None
        with self.connect() as connection:
            connection.execute("BEGIN")
            version = int(
                connection.execute(
                    "SELECT value FROM vector_metadata WHERE key = 'generation'"
                ).fetchone()[0]
            )
            cached = self._numpy_cache.get(model_id)
            if cached is not None and self._numpy_cache_versions.get(model_id) == version:
                return cached
            summary = connection.execute(
                """
                SELECT COUNT(*) AS total, MIN(dimensions) AS minimum,
                       MAX(dimensions) AS maximum
                FROM vectors WHERE model_id = ?
                """,
                (model_id,),
            ).fetchone()
            if summary is None or int(summary["total"]) == 0:
                return None
            dimensions = int(summary["minimum"])
            if dimensions != int(summary["maximum"]):
                raise RuntimeError("vector index contains inconsistent dimensions")
            matrix = numpy.empty((int(summary["total"]), dimensions), dtype=numpy.float32)
            metadata: list[tuple[str, str, int, int, str]] = []
            cursor = connection.execute(
                """
                SELECT path, heading, start_line, end_line, text_hash, vector
                FROM vectors WHERE model_id = ? ORDER BY chunk_id
                """,
                (model_id,),
            )
            offset = 0
            while rows := cursor.fetchmany(1024):
                for row in rows:
                    values = numpy.frombuffer(cast(bytes, row["vector"]), dtype=numpy.float32)
                    if int(values.size) != dimensions:
                        raise RuntimeError("vector index contains an invalid vector blob")
                    matrix[offset] = values
                    metadata.append(
                        (
                            str(row["path"]),
                            str(row["heading"]),
                            int(row["start_line"]),
                            int(row["end_line"]),
                            str(row["text_hash"]),
                        )
                    )
                    offset += 1
        norms = numpy.linalg.norm(matrix, axis=1)
        loaded = _NumpyCache(matrix, norms, tuple(metadata))
        self._numpy_cache[model_id] = loaded
        self._numpy_cache_versions[model_id] = version
        return loaded

    def _search_numpy(
        self,
        query_vector: Sequence[float],
        model_id: str,
        *,
        include_prefixes: Sequence[str],
        exclude_prefixes: Sequence[str],
        limit: int,
    ) -> list[SearchHit] | None:
        cache = self._load_numpy_cache(model_id)
        if cache is None:
            return None
        numpy = importlib.import_module("numpy")
        query = numpy.asarray(query_vector, dtype=numpy.float32)
        if query.ndim != 1 or query.shape[0] != cache.matrix.shape[1]:
            raise RuntimeError("query vector dimensions do not match the index")
        magnitude = float(numpy.linalg.norm(query))
        if not magnitude:
            return []
        scores = cache.matrix @ query
        scores = numpy.divide(
            scores,
            cache.norms * magnitude,
            out=numpy.zeros_like(scores),
            where=cache.norms != 0,
        )
        candidates = [
            index
            for index, (path, _heading, _start, _end, _hash) in enumerate(cache.metadata)
            if path_in_scope(path, include_prefixes, exclude_prefixes)
        ]
        if not candidates:
            return []
        candidate_indexes = numpy.asarray(candidates, dtype=numpy.int64)
        candidate_scores = scores[candidate_indexes]
        selected_count = min(limit, len(candidates))
        if selected_count == len(candidates):
            selected = numpy.arange(len(candidates))
        else:
            selected = numpy.argpartition(-candidate_scores, selected_count - 1)[:selected_count]
        ordered = selected[numpy.argsort(-candidate_scores[selected], kind="stable")]
        hits: list[SearchHit] = []
        for position in ordered:
            score = float(candidate_scores[position])
            if score <= 0:
                continue
            path, heading, start_line, end_line, digest = cache.metadata[
                int(candidate_indexes[position])
            ]
            hits.append(
                SearchHit(
                    path=path,
                    heading=heading,
                    start_line=start_line,
                    end_line=end_line,
                    text_hash=digest,
                    score=score,
                    retrieval_reasons=(f"vector:{model_id}",),
                )
            )
        return hits

    def search(
        self,
        query: str,
        embedder: Embedder,
        *,
        include_prefixes: Sequence[str] = (),
        exclude_prefixes: Sequence[str] = (),
        limit: int = 20,
    ) -> list[SearchHit]:
        query_vectors = embedder.embed([query])
        if len(query_vectors) != 1:
            raise RuntimeError("embedding provider did not return a query vector")
        query_vector = query_vectors[0]
        accelerated = self._search_numpy(
            query_vector,
            embedder.model_id,
            include_prefixes=include_prefixes,
            exclude_prefixes=exclude_prefixes,
            limit=limit,
        )
        if accelerated is not None:
            return accelerated
        with self.connect() as connection:
            rows = connection.execute(
                "SELECT * FROM vectors WHERE model_id = ?",
                (embedder.model_id,),
            ).fetchall()
        scored: list[tuple[float, sqlite3.Row]] = []
        for row in rows:
            path = str(row["path"])
            if not path_in_scope(path, include_prefixes, exclude_prefixes):
                continue
            similarity = _cosine(query_vector, _vector(cast(bytes, row["vector"])))
            scored.append((similarity, row))
        scored.sort(key=lambda item: item[0], reverse=True)
        return [
            SearchHit(
                path=str(row["path"]),
                heading=str(row["heading"]),
                start_line=int(row["start_line"]),
                end_line=int(row["end_line"]),
                text_hash=str(row["text_hash"]),
                score=score,
                retrieval_reasons=(f"vector:{embedder.model_id}",),
            )
            for score, row in scored[:limit]
            if score > 0
        ]

    def model_ids(self) -> set[str]:
        with self.connect() as connection:
            rows: Iterable[sqlite3.Row] = connection.execute(
                "SELECT DISTINCT model_id FROM vectors"
            ).fetchall()
        return {str(row["model_id"]) for row in rows}
